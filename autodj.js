// ========== AUTODJ / SCHEDULER ==========
// Plays scheduled playlists from an uploaded music library whenever nobody is
// live. The moment a live source starts (browser broadcaster "go-live" or a
// BUTT/Icecast source) the AutoDJ stops; when the live show ends it resumes
// with the next track of whatever the schedule says is on now.
//
// Audio path: every library file is transcoded once on upload to a uniform
// MP3 (44.1 kHz stereo 128 kbps, no ID3/Xing). Playback reads MP3 frames and
// sends them to /stream listeners paced against the wall clock, so tracks
// follow each other with no gap and no ffmpeg process per track. A single
// ffmpeg decoder per channel turns the same frames into PCM for socket
// listeners (optional; skipped if ffmpeg is missing).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let FFMPEG = process.env.FFMPEG_PATH || null;
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static'); } catch (e) { FFMPEG = 'ffmpeg'; } }

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEAD_MS = 1500;          // how far ahead of real time we keep listeners fed
const PACE_INTERVAL_MS = 100;
const SCHEDULE_TICK_MS = 1000;
const RESUME_DELAY_MS = 1500;  // pause between live ending and AutoDJ resuming

// ---------- MP3 frame parsing ----------
const BITRATES = {
  // [versionKey][layer] -> kbps table index 0..15
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function skipId3(buf) {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    return 10 + size;
  }
  return 0;
}

function parseFrames(buf) {
  const frames = [];
  let i = skipId3(buf);
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 3;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 3;    // 1=Layer III
    const brIdx = (buf[i + 2] >> 4) & 15;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const kbps = (ver === 3 ? BITRATES.V1L3 : BITRATES.V2L3)[brIdx];
    const sr = SAMPLE_RATES[ver][srIdx];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor((samples / 8) * kbps * 1000 / sr) + pad;
    if (len < 4 || i + len > buf.length) break;
    frames.push({ off: i, len, ms: samples * 1000 / sr });
    i += len;
  }
  return frames;
}

// ---------- time helpers ----------
function toMin(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return v >= 0 && v <= 1440 ? v : null;
}

function nowIn(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
  } catch (e) {
    return nowIn('UTC');
  }
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  const day = DAY_NAMES.indexOf(get('weekday'));
  const h = parseInt(get('hour'), 10) % 24;
  const m = parseInt(get('minute'), 10);
  const s = parseInt(get('second'), 10);
  return { day, min: h * 60 + m, sec: s };
}

// Week minute index 0..10079 starting Sunday 00:00
function slotRanges(slot) {
  const s = toMin(slot.start), e = toMin(slot.end);
  if (s === null || e === null) return [];
  const base = slot.day * 1440;
  if (e > s) return [[base + s, base + e]];
  // overnight: runs past midnight into the next day
  const nextBase = ((slot.day + 1) % 7) * 1440;
  return [[base + s, base + 1440], [nextBase, nextBase + e]];
}

function slotActiveAt(slot, weekMin) {
  return slotRanges(slot).some(([a, b]) => weekMin >= a && weekMin < b);
}

function genId() { return crypto.randomBytes(6).toString('hex'); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- module ----------
function createAutoDJ(opts) {
  const { io, channels, getChannel, stopServerRadio, startServerRadio, writeMp3, dataDir } = opts;
  const r2 = opts.r2 || null;          // Cloudflare R2 storage (see r2.js); null = local disk only
  const R2_PREFIX = 'autodj/';
  const r2Key = (t) => R2_PREFIX + 'library/' + t.file;
  const libDir = path.join(dataDir, 'library');
  const tmpDir = path.join(dataDir, 'tmp');
  const dataFile = path.join(dataDir, 'autodj.json');
  for (const d of [dataDir, libDir, tmpDir]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

  const emptyData = () => ({ timezone: 'Europe/Berlin', tracks: {}, playlists: {}, channels: {} });
  let data = emptyData();
  let ready = false;        // false while the library/schedule is still loading from R2
  let storageError = null;  // last R2 problem, shown on the dashboard

  // which library files are on this server's disk right now
  const cached = new Set();
  try {
    for (const f of fs.readdirSync(libDir)) {
      if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(libDir, f)); } catch (e) {} continue; }
      if (f.endsWith('.mp3')) cached.add(f);
    }
  } catch (e) {}
  const isCached = (t) => !!t && cached.has(t.file);

  function readLocalData() {
    try {
      if (fs.existsSync(dataFile)) return Object.assign(emptyData(), JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    } catch (e) { console.error('AutoDJ: could not read data file:', e.message); }
    return null;
  }

  let saveTimer = null;
  let r2SaveChain = Promise.resolve();
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const json = JSON.stringify(data, null, 2);
      try { fs.writeFileSync(dataFile, json); }
      catch (e) { console.error('AutoDJ: save failed:', e.message); }
      // never push to R2 before we have loaded from it, or we could overwrite the real schedule
      if (r2 && ready) {
        r2SaveChain = r2SaveChain
          .then(() => r2.putBuffer(R2_PREFIX + 'autodj.json', json, 'application/json'))
          .then(() => { if (storageError && storageError.startsWith('save')) storageError = null; })
          .catch(e => { storageError = 'save: ' + e.message; console.error('AutoDJ: R2 save failed:', e.message); });
      }
    }, 200);
  }

  if (!r2) {
    data = readLocalData() || emptyData();
    // drop tracks whose files vanished (e.g. Render wiped the disk)
    for (const id of Object.keys(data.tracks)) if (!isCached(data.tracks[id])) delete data.tracks[id];
    ready = true;
  } else {
    (async function loadFromR2(attempt) {
      try {
        const buf = await r2.getBuffer(R2_PREFIX + 'autodj.json');
        if (buf) {
          data = Object.assign(emptyData(), JSON.parse(buf.toString('utf8')));
          console.log(`🤖 AutoDJ: loaded schedule + ${Object.keys(data.tracks).length} tracks from R2 bucket "${r2.bucket}"`);
        } else {
          // first run with R2: move whatever is on local disk up to the bucket
          const local = readLocalData();
          if (local) {
            for (const id of Object.keys(local.tracks)) if (!isCached(local.tracks[id])) delete local.tracks[id];
            for (const t of Object.values(local.tracks)) await r2.putFile(r2Key(t), path.join(libDir, t.file), 'audio/mpeg');
            data = local;
            console.log(`🤖 AutoDJ: R2 bucket was empty, uploaded ${Object.keys(local.tracks).length} local tracks`);
          } else {
            console.log(`🤖 AutoDJ: R2 bucket "${r2.bucket}" is empty, starting a new library`);
          }
          await r2.putBuffer(R2_PREFIX + 'autodj.json', JSON.stringify(data, null, 2), 'application/json');
        }
        try { fs.writeFileSync(dataFile, JSON.stringify(data, null, 2)); } catch (e) {}
        storageError = null;
        ready = true;
        syncLibrary();
      } catch (e) {
        storageError = 'load: ' + e.message;
        const wait = Math.min(60, 5 * (attempt + 1));
        console.error(`AutoDJ: could not load from R2 (${e.message}), retrying in ${wait}s`);
        setTimeout(() => loadFromR2(attempt + 1), wait * 1000);
      }
    })(0);
  }

  // Download library files this server does not have yet (after a restart the
  // disk is empty). Tracks used by the schedule come first.
  let syncing = false;
  async function syncLibrary() {
    if (!r2 || syncing || !ready) return;
    syncing = true;
    try {
      const wanted = new Set();
      for (const conf of Object.values(data.channels)) {
        const pls = conf.slots.map(sl => sl.playlistId).concat(conf.fallbackPlaylistId);
        for (const plId of pls) { const pl = data.playlists[plId]; if (pl) pl.trackIds.forEach(t => wanted.add(t)); }
      }
      const missing = Object.values(data.tracks).filter(t => !isCached(t))
        .sort((a, b) => (wanted.has(b.id) ? 1 : 0) - (wanted.has(a.id) ? 1 : 0));
      if (missing.length) console.log(`🤖 AutoDJ: fetching ${missing.length} tracks from R2`);
      let failed = 0;
      for (const t of missing) {
        if (!data.tracks[t.id] || isCached(t)) continue;
        try { await fetchTrack(t); } catch (e) { failed++; storageError = 'download: ' + e.message; console.error('AutoDJ: R2 download failed', t.file, e.message); }
      }
      if (failed) setTimeout(syncLibrary, 60000);
    } finally { syncing = false; }
  }

  const fetching = new Map();
  function fetchTrack(t) {
    if (isCached(t)) return Promise.resolve(true);
    if (fetching.has(t.file)) return fetching.get(t.file);
    const p = r2.getFile(r2Key(t), path.join(libDir, t.file))
      .then(ok => { if (ok) cached.add(t.file); return ok; })
      .finally(() => fetching.delete(t.file));
    fetching.set(t.file, p);
    return p;
  }

  function chConf(chId) {
    if (!data.channels[chId]) data.channels[chId] = { enabled: false, fallbackPlaylistId: null, slots: [] };
    return data.channels[chId];
  }

  // per-channel runtime state
  const runtime = new Map();
  function rt(chId) {
    if (!runtime.has(chId)) {
      runtime.set(chId, {
        playing: false, key: null, slotId: null, playlistId: null,
        track: null, buf: null, frames: null, idx: 0,
        trackStartedAt: 0, startWall: 0, sentMs: 0,
        liveSource: false, resumeAt: 0, decoder: null,
        order: {}, pos: {}, history: []
      });
    }
    return runtime.get(chId);
  }

  // ---------- schedule logic ----------
  function playlistHasTracks(plId) {
    const pl = data.playlists[plId];
    return !!(pl && pl.trackIds.some(t => isCached(data.tracks[t])));
  }

  function activeSlot(chId, now) {
    now = now || nowIn(data.timezone);
    const weekMin = now.day * 1440 + now.min;
    const conf = chConf(chId);
    // later-added slots win if they overlap
    for (let i = conf.slots.length - 1; i >= 0; i--) {
      if (slotActiveAt(conf.slots[i], weekMin)) return conf.slots[i];
    }
    return null;
  }

  // What should the AutoDJ be playing right now? null = nothing
  function desired(chId) {
    if (!ready) return null;
    const conf = chConf(chId);
    if (!conf.enabled) return null;
    const slot = activeSlot(chId);
    if (slot && slot.type !== 'live' && playlistHasTracks(slot.playlistId)) {
      return { key: slot.id + ':' + slot.playlistId, slotId: slot.id, playlistId: slot.playlistId, slot };
    }
    if (conf.fallbackPlaylistId && playlistHasTracks(conf.fallbackPlaylistId)) {
      return { key: 'fallback:' + conf.fallbackPlaylistId, slotId: slot ? slot.id : null, playlistId: conf.fallbackPlaylistId, slot, fallback: true };
    }
    return null;
  }

  function nextTrackId(r, plId) {
    const pl = data.playlists[plId];
    if (!pl) return null;
    const valid = pl.trackIds.filter(t => isCached(data.tracks[t]));
    if (!valid.length) return null;
    const sig = valid.join(',') + '|' + !!pl.shuffle;
    let order = r.order[plId];
    if (!order || order.sig !== sig) {
      // new or edited playlist: in order mode continue after the current track if it is in here
      const list = pl.shuffle ? shuffle(valid) : valid;
      order = r.order[plId] = { sig, list };
      r.pos[plId] = (!pl.shuffle && r.track) ? list.indexOf(r.track.id) + 1 : 0;
    }
    if (!(r.pos[plId] < order.list.length)) {
      // reached the end: loop (reshuffle, and never repeat the last track straight away)
      if (pl.shuffle) {
        const list = shuffle(valid);
        if (list.length > 1 && r.track && list[0] === r.track.id) list.push(list.shift());
        order.list = list;
      }
      r.pos[plId] = 0;
    }
    return order.list[r.pos[plId]++];
  }

  function loadTrack(r, trackId) {
    const t = data.tracks[trackId];
    if (!t) return false;
    try {
      const buf = fs.readFileSync(path.join(libDir, t.file));
      const frames = parseFrames(buf);
      if (!frames.length) return false;
      r.track = t; r.buf = buf; r.frames = frames; r.idx = 0;
      r.trackStartedAt = Date.now();
      r.history.unshift({ id: t.id, title: t.title, artist: t.artist, at: new Date().toISOString() });
      r.history.length = Math.min(r.history.length, 20);
      return true;
    } catch (e) {
      console.error('AutoDJ: failed to load track', t.file, e.message);
      return false;
    }
  }

  function advance(chId, r) {
    // try a few tracks in case some files are broken
    for (let tries = 0; tries < 5; tries++) {
      const id = nextTrackId(r, r.playlistId);
      if (!id) return false;
      if (loadTrack(r, id)) { announceTrack(chId, r); return true; }
    }
    return false;
  }

  function announceTrack(chId, r) {
    const ch = getChannel(chId);
    if (!ch || !r.track) return;
    ch.stationInfo.nowPlaying = { title: r.track.title, artist: r.track.artist || '', duration: r.track.duration };
    io.to('listeners-' + chId).emit('now-playing', ch.stationInfo.nowPlaying);
    console.log(`🤖 AutoDJ [${chId}] ▶ ${r.track.artist ? r.track.artist + ' - ' : ''}${r.track.title}`);
  }

  // ---------- decoder for socket (PCM) listeners ----------
  function startDecoder(chId, r, rate) {
    if (r.decoder) return;
    try {
      const proc = spawn(FFMPEG, ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate || 44100), 'pipe:1']);
      proc.on('error', () => { if (r.decoder === proc) r.decoder = null; });
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', (pcm) => {
        if (r.decoder !== proc || !r.playing || r.liveSource) return;
        io.to('listeners-' + chId).volatile.emit('audio-stream', pcm);
      });
      proc.on('close', () => { if (r.decoder === proc) r.decoder = null; });
      r.decoder = proc;
    } catch (e) { r.decoder = null; }
  }

  function stopDecoder(r) {
    if (!r.decoder) return;
    const p = r.decoder;
    r.decoder = null;
    try { p.stdin.end(); } catch (e) {}
    try { p.kill('SIGKILL'); } catch (e) {}
  }

  // ---------- playback ----------
  function start(chId, want) {
    const ch = getChannel(chId);
    if (!ch) return;
    const r = rt(chId);
    stopServerRadio(ch);
    r.key = want.key; r.slotId = want.slotId; r.playlistId = want.playlistId;
    if (!advance(chId, r)) { r.key = null; return; }
    r.playing = true;
    r.startWall = Date.now();
    r.sentMs = 0;
    ch.stationInfo.isLive = true;
    ch.stationInfo.serverRadio = false;
    ch.stationInfo.autoDJ = true;
    // keep the rate socket listeners are already playing at, so their audio does not reset
    ch.stationInfo.sampleRate = ch.stationInfo.sampleRate || 44100;
    startDecoder(chId, r, ch.stationInfo.sampleRate);
    io.to('listeners-' + chId).emit('station-live', ch.stationInfo);
    console.log(`🤖 AutoDJ [${chId}] ON (${want.fallback ? 'fallback' : 'slot'} playlist "${(data.playlists[want.playlistId] || {}).name}")`);
  }

  function switchTo(chId, want) {
    const r = rt(chId);
    r.key = want.key; r.slotId = want.slotId; r.playlistId = want.playlistId;
    if (!advance(chId, r)) stop(chId, true);
  }

  // offline=true when nothing else takes over and listeners should see "off air"
  function stop(chId, offline) {
    const r = rt(chId);
    const ch = getChannel(chId);
    if (!r.playing) return;
    r.playing = false;
    r.key = null; r.buf = null; r.frames = null;
    stopDecoder(r);
    if (ch) {
      ch.stationInfo.autoDJ = false;
      ch.stationInfo.nowPlaying = null;
      if (offline) {
        ch.stationInfo.isLive = false;
        io.to('listeners-' + chId).emit('station-offline');
      }
    }
    console.log(`🤖 AutoDJ [${chId}] OFF${offline ? '' : ' (live took over)'}`);
  }

  function pace() {
    const now = Date.now();
    for (const [chId, r] of runtime) {
      if (!r.playing || r.liveSource || !r.frames) continue;
      const ch = getChannel(chId);
      if (!ch) { stop(chId, false); continue; }
      // if the event loop stalled for a while, don't burst-send the backlog
      if ((now - r.startWall) - r.sentMs > 3000) r.startWall = now - r.sentMs;
      const target = (now - r.startWall) + LEAD_MS;
      const pieces = [];
      while (r.sentMs < target) {
        if (r.idx >= r.frames.length) {
          if (!advance(chId, r)) { break; }
        }
        const f = r.frames[r.idx++];
        pieces.push(r.buf.subarray(f.off, f.off + f.len));
        r.sentMs += f.ms;
      }
      if (!pieces.length) {
        if (r.idx >= (r.frames ? r.frames.length : 0)) stop(chId, true);
        continue;
      }
      const chunk = Buffer.concat(pieces);
      writeMp3(ch, chunk);
      if (r.decoder) { try { r.decoder.stdin.write(chunk); } catch (e) {} }
    }
  }

  function scheduleTick() {
    const now = Date.now();
    for (const [chId] of channels) {
      const r = rt(chId);
      if (r.liveSource) { if (r.playing) stop(chId, false); continue; }
      if (r.resumeAt && now < r.resumeAt) continue;
      r.resumeAt = 0;
      const want = desired(chId);
      if (!want) {
        if (r.playing) {
          stop(chId, true);
          // hand back to the stream relay if one is configured
          const ch = getChannel(chId);
          if (ch && ch.serverRadioUrl && startServerRadio) startServerRadio(ch);
        }
        continue;
      }
      if (!r.playing) start(chId, want);
      else if (want.key !== r.key) {
        console.log(`🤖 AutoDJ [${chId}] schedule change → "${(data.playlists[want.playlistId] || {}).name}"`);
        switchTo(chId, want);
      }
    }
  }

  setInterval(pace, PACE_INTERVAL_MS);
  setInterval(scheduleTick, SCHEDULE_TICK_MS);

  // ---------- hooks called by server.js ----------
  function onLiveStart(ch) {
    const r = rt(ch.id);
    r.liveSource = true;
    if (r.playing) stop(ch.id, false);
  }

  function onLiveEnd(ch) {
    const r = rt(ch.id);
    if (!r.liveSource) return;
    r.liveSource = false;
    r.resumeAt = Date.now() + RESUME_DELAY_MS;
  }

  // true if AutoDJ owns this channel right now (server radio should stay off)
  function claims(ch) {
    return !!desired(ch.id);
  }

  // ---------- library ----------
  function importFile(tmpPath, originalName) {
    return new Promise((resolve, reject) => {
      const id = genId();
      const file = id + '.mp3';
      const out = path.join(libDir, file);
      const args = ['-hide_banner', '-y', '-i', tmpPath, '-vn', '-map', '0:a:0',
        '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k',
        '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', out];
      let stderr = '';
      let proc;
      try { proc = spawn(FFMPEG, args); } catch (e) { return reject(new Error('ffmpeg not available')); }
      proc.stderr.on('data', d => { if (stderr.length < 20000) stderr += d.toString(); });
      proc.on('error', () => reject(new Error('ffmpeg not available')));
      proc.on('close', (code) => {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        if (code !== 0) {
          try { fs.unlinkSync(out); } catch (e) {}
          const last = stderr.trim().split('\n').slice(-1)[0] || 'unknown error';
          return reject(new Error('Could not read audio: ' + last));
        }
        // pull title/artist from the source's tags
        const tag = (k) => {
          const m = stderr.split(/Output #0/)[0].match(new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'mi'));
          return m ? m[1].trim() : '';
        };
        const base = originalName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
        let title = tag('title'), artist = tag('artist');
        if (!title) {
          const parts = base.split(' - ');
          if (parts.length >= 2 && !artist) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
          else title = base;
        }
        const buf = fs.readFileSync(out);
        const frames = parseFrames(buf);
        const duration = frames.reduce((s, f) => s + f.ms, 0) / 1000;
        if (!frames.length) { try { fs.unlinkSync(out); } catch (e) {} return reject(new Error('No audio found in file')); }
        const track = {
          id, file, title: title.slice(0, 200), artist: artist.slice(0, 200),
          originalName: originalName.slice(0, 200), duration: Math.round(duration * 10) / 10,
          size: buf.length, addedAt: new Date().toISOString()
        };
        const store = r2 ? r2.putFile(r2Key(track), out, 'audio/mpeg') : Promise.resolve();
        store.then(() => {
          cached.add(file);
          data.tracks[id] = track;
          save();
          resolve(track);
        }).catch((e) => {
          try { fs.unlinkSync(out); } catch (er) {}
          storageError = 'upload: ' + e.message;
          reject(new Error('Converted, but could not store it in R2: ' + e.message));
        });
      });
    });
  }

  function deleteTrack(id) {
    const t = data.tracks[id];
    if (!t) return false;
    delete data.tracks[id];
    for (const pl of Object.values(data.playlists)) pl.trackIds = pl.trackIds.filter(x => x !== id);
    try { fs.unlinkSync(path.join(libDir, t.file)); } catch (e) {}
    cached.delete(t.file);
    if (r2) r2.del(r2Key(t)).catch(e => console.error('AutoDJ: R2 delete failed', t.file, e.message));
    save();
    return true;
  }

  // ---------- status / API helpers ----------
  function storageInfo() {
    const total = Object.keys(data.tracks).length;
    const onDisk = Object.values(data.tracks).filter(isCached).length;
    return { type: r2 ? 'r2' : 'local', bucket: r2 ? r2.bucket : null, ready, tracks: total, onDisk, error: storageError, isCloud: !!opts.isCloud };
  }

  function nextSlots(chId, count) {
    const conf = chConf(chId);
    const now = nowIn(data.timezone);
    const weekMin = now.day * 1440 + now.min;
    const out = [];
    for (const s of conf.slots) {
      const st = toMin(s.start);
      if (st === null || slotActiveAt(s, weekMin)) continue; // the one on now is not "next"
      let delta = (s.day * 1440 + st) - weekMin;
      if (delta <= 0) delta += 10080;
      out.push({ slot: s, inMinutes: delta });
    }
    return out.sort((a, b) => a.inMinutes - b.inMinutes).slice(0, count);
  }

  function status(chId) {
    const r = rt(chId);
    const ch = getChannel(chId);
    const slot = activeSlot(chId);
    const want = desired(chId);
    let mode = 'off';
    if (r.liveSource) mode = 'live';
    else if (r.playing) mode = 'auto';
    else if (ch && ch.serverRadioProcess) mode = 'relay';
    const pos = r.playing && r.frames ? r.frames.slice(0, r.idx).reduce((s, f) => s + f.ms, 0) / 1000 : 0;
    return {
      channel: chId,
      mode,
      enabled: chConf(chId).enabled,
      currentSlot: slot ? { id: slot.id, title: slot.title, type: slot.type, start: slot.start, end: slot.end } : null,
      playlist: r.playing && data.playlists[r.playlistId] ? { id: r.playlistId, name: data.playlists[r.playlistId].name } : null,
      usingFallback: !!(want && want.fallback),
      track: r.playing && r.track ? {
        id: r.track.id, title: r.track.title, artist: r.track.artist, duration: r.track.duration,
        position: Math.max(0, Math.round((pos - LEAD_MS / 1000) * 10) / 10)
      } : null,
      history: r.history.slice(0, 10),
      upNext: nextSlots(chId, 3).map(n => ({ id: n.slot.id, title: n.slot.title, type: n.slot.type, day: n.slot.day, start: n.slot.start, end: n.slot.end, inMinutes: n.inMinutes })),
      listeners: ch ? ch.streamClients.size : 0,
      serverTime: nowIn(data.timezone)
    };
  }

  function publicSchedule(chId) {
    const conf = chConf(chId);
    const st = status(chId);
    return {
      timezone: data.timezone,
      mode: st.mode,
      nowPlaying: st.track ? { title: st.track.title, artist: st.track.artist } : null,
      currentSlot: st.currentSlot,
      upNext: st.upNext,
      slots: conf.slots.map(s => ({ id: s.id, day: s.day, start: s.start, end: s.end, title: s.title, type: s.type }))
    };
  }

  function validateSlot(body) {
    const day = parseInt(body.day, 10);
    if (!(day >= 0 && day <= 6)) return 'Pick a day';
    const s = toMin(body.start), e = toMin(body.end);
    if (s === null || e === null || s >= 1440) return 'Times must be HH:MM';
    if (s === e) return 'Start and end cannot be the same';
    const type = body.type === 'live' ? 'live' : 'auto';
    if (type === 'auto' && !data.playlists[body.playlistId]) return 'Pick a playlist for an auto slot';
    return null;
  }

  function cleanSlot(body, id) {
    return {
      id: id || genId(),
      day: parseInt(body.day, 10),
      start: body.start,
      end: body.end === '00:00' ? '24:00' : body.end,
      type: body.type === 'live' ? 'live' : 'auto',
      playlistId: body.type === 'live' ? null : body.playlistId,
      title: String(body.title || '').slice(0, 80) || (body.type === 'live' ? 'Live show' : ((data.playlists[body.playlistId] || {}).name || 'AutoDJ')),
      color: /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : null
    };
  }

  function skip(chId) {
    const r = rt(chId);
    if (!r.playing) return false;
    // drop whatever is queued ahead and jump straight to the next track
    if (!advance(chId, r)) { stop(chId, true); return true; }
    r.startWall = Date.now(); r.sentMs = 0;
    return true;
  }

  // ---------- express routes ----------
  function mountRoutes(app, isAdmin, express) {
    const admin = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: 'Admin only' });
    const json = express.json({ limit: '1mb' });
    app.use('/api/autodj', (req, res, next) => {
      if (ready) return next();
      res.status(503).json({ error: 'Still loading the library from R2' + (storageError ? ' (' + storageError + ')' : '') + '. Try again in a moment.' });
    });

    app.get('/api/autodj', admin, (req, res) => {
      const chs = [];
      for (const [id, ch] of channels) chs.push({ id, name: ch.name, ...chConf(id), status: status(id) });
      res.json({
        timezone: data.timezone,
        tracks: Object.values(data.tracks).sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
        playlists: Object.values(data.playlists),
        channels: chs,
        ffmpeg: !!FFMPEG,
        storage: storageInfo()
      });
    });

    app.get('/api/autodj/status', admin, (req, res) => {
      const out = {};
      for (const [id] of channels) out[id] = status(id);
      out._storage = storageInfo();
      res.json(out);
    });

    app.put('/api/autodj/settings', admin, json, (req, res) => {
      const tz = String(req.body.timezone || '');
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { return res.status(400).json({ error: 'Unknown timezone' }); }
      data.timezone = tz; save();
      res.json({ ok: true });
    });

    // raw upload: body is the file itself, ?name=original-filename
    app.put('/api/autodj/upload', admin, (req, res) => {
      const name = String(req.query.name || 'track').replace(/[\/\\]/g, '_');
      const tmp = path.join(tmpDir, genId() + path.extname(name).slice(0, 8));
      const ws = fs.createWriteStream(tmp);
      let bytes = 0;
      const MAX = 1024 * 1024 * 1024; // 1 GB
      req.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX) { req.destroy(); ws.destroy(); try { fs.unlinkSync(tmp); } catch (e) {} }
      });
      req.pipe(ws);
      ws.on('finish', () => {
        if (bytes > MAX) return res.status(413).json({ error: 'File too large' });
        importFile(tmp, name)
          .then(track => res.json({ ok: true, track }))
          .catch(err => res.status(400).json({ error: err.message }));
      });
      ws.on('error', () => res.status(500).json({ error: 'Upload failed' }));
    });

    app.get('/api/autodj/tracks/:id/audio', admin, (req, res) => {
      const t = data.tracks[req.params.id];
      if (!t) return res.status(404).end();
      if (!isCached(t) && r2) {
        return fetchTrack(t).then(ok => ok ? res.sendFile(path.join(libDir, t.file)) : res.status(404).end())
          .catch(() => res.status(502).end());
      }
      res.sendFile(path.join(libDir, t.file));
    });

    app.patch('/api/autodj/tracks/:id', admin, json, (req, res) => {
      const t = data.tracks[req.params.id];
      if (!t) return res.status(404).json({ error: 'Not found' });
      if (typeof req.body.title === 'string') t.title = req.body.title.slice(0, 200);
      if (typeof req.body.artist === 'string') t.artist = req.body.artist.slice(0, 200);
      save();
      res.json({ ok: true, track: t });
    });

    app.delete('/api/autodj/tracks/:id', admin, (req, res) => {
      res.json({ ok: deleteTrack(req.params.id) });
    });

    app.post('/api/autodj/playlists', admin, json, (req, res) => {
      const pl = { id: genId(), name: String(req.body.name || 'New playlist').slice(0, 80), trackIds: [], shuffle: !!req.body.shuffle };
      data.playlists[pl.id] = pl; save();
      res.json({ ok: true, playlist: pl });
    });

    app.put('/api/autodj/playlists/:id', admin, json, (req, res) => {
      const pl = data.playlists[req.params.id];
      if (!pl) return res.status(404).json({ error: 'Not found' });
      if (typeof req.body.name === 'string') pl.name = req.body.name.slice(0, 80) || pl.name;
      if (Array.isArray(req.body.trackIds)) pl.trackIds = req.body.trackIds.filter(t => data.tracks[t]);
      if (typeof req.body.shuffle === 'boolean') pl.shuffle = req.body.shuffle;
      save();
      res.json({ ok: true, playlist: pl });
    });

    app.delete('/api/autodj/playlists/:id', admin, (req, res) => {
      const id = req.params.id;
      if (!data.playlists[id]) return res.status(404).json({ error: 'Not found' });
      delete data.playlists[id];
      for (const conf of Object.values(data.channels)) {
        if (conf.fallbackPlaylistId === id) conf.fallbackPlaylistId = null;
        conf.slots = conf.slots.filter(s => s.playlistId !== id || s.type === 'live');
      }
      save();
      res.json({ ok: true });
    });

    app.put('/api/autodj/channels/:ch', admin, json, (req, res) => {
      if (!getChannel(req.params.ch)) return res.status(404).json({ error: 'Channel not found' });
      const conf = chConf(req.params.ch);
      if (typeof req.body.enabled === 'boolean') conf.enabled = req.body.enabled;
      if ('fallbackPlaylistId' in req.body) {
        conf.fallbackPlaylistId = data.playlists[req.body.fallbackPlaylistId] ? req.body.fallbackPlaylistId : null;
      }
      save();
      scheduleTick();
      res.json({ ok: true, channel: conf, status: status(req.params.ch) });
    });

    app.post('/api/autodj/channels/:ch/slots', admin, json, (req, res) => {
      if (!getChannel(req.params.ch)) return res.status(404).json({ error: 'Channel not found' });
      const err = validateSlot(req.body);
      if (err) return res.status(400).json({ error: err });
      const slot = cleanSlot(req.body);
      chConf(req.params.ch).slots.push(slot);
      save(); scheduleTick();
      res.json({ ok: true, slot });
    });

    app.put('/api/autodj/channels/:ch/slots/:id', admin, json, (req, res) => {
      const conf = chConf(req.params.ch);
      const i = conf.slots.findIndex(s => s.id === req.params.id);
      if (i < 0) return res.status(404).json({ error: 'Not found' });
      const err = validateSlot(req.body);
      if (err) return res.status(400).json({ error: err });
      conf.slots[i] = cleanSlot(req.body, conf.slots[i].id);
      save(); scheduleTick();
      res.json({ ok: true, slot: conf.slots[i] });
    });

    app.delete('/api/autodj/channels/:ch/slots/:id', admin, (req, res) => {
      const conf = chConf(req.params.ch);
      conf.slots = conf.slots.filter(s => s.id !== req.params.id);
      save(); scheduleTick();
      res.json({ ok: true });
    });

    app.post('/api/autodj/channels/:ch/skip', admin, (req, res) => {
      res.json({ ok: skip(req.params.ch) });
    });

    // public: what's on now / next, for listener pages
    app.get('/api/schedule/:ch?', (req, res) => {
      const chId = req.params.ch || 'main';
      if (!getChannel(chId)) return res.status(404).json({ error: 'Channel not found' });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json(publicSchedule(chId));
    });
  }

  // clean leftovers from interrupted uploads
  try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch (e) {}

  return { onLiveStart, onLiveEnd, claims, mountRoutes, status, _parseFrames: parseFrames, _nowIn: nowIn };
}

module.exports = { createAutoDJ, parseFrames };
