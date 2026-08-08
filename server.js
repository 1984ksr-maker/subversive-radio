const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
  pingTimeout: 120000,
  pingInterval: 15000,
  connectTimeout: 30000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  perMessageDeflate: false,
  httpCompression: false,
  serveClient: true,
  cookie: false
});

const PORT = process.env.PORT || 3333;
const IS_CLOUD = !!process.env.RENDER || !!process.env.RAILWAY_STATIC_URL || !!process.env.FLY_APP_NAME;
let tunnelUrl = null;
const MAX_CHANNELS = 10;

// ========== AUTH & ADMIN SYSTEM ==========
let adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const activeSessions = new Map();
const accessCodes = new Map();

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
}

function getSession(req) {
  const cookies = parseCookies(req);
  if (cookies['br_electron'] === 'subversive-local-bypass' && !IS_CLOUD) return { role: 'admin' };
  const t = req.query.token || req.headers['x-auth-token'] || cookies['br_token'];
  if (!t) return null;
  const session = activeSessions.get(t);
  if (!session) return null;
  if (Date.now() > session.expiry) { activeSessions.delete(t); return null; }
  return session;
}

function isAuthenticated(req) { return !!getSession(req); }

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isAdmin(req) {
  const s = getSession(req);
  return s && s.role === 'admin';
}

// Login page HTML
function loginPageHTML(error = '', redirectTo = '/broadcaster') {
  redirectTo = escapeHtml(redirectTo);
  error = escapeHtml(error);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subversive Radio — Access</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --red: #ff2d2d; --red-glow: rgba(255,45,45,0.4); --green: #00ff88; --amber: #ffaa00; --bg: #0a0a0a; --surface: #141414; --surface2: #1e1e1e; --text: #e0e0e0; --text-dim: #666; }
    body { font-family: 'SF Mono','Fira Code','Courier New',monospace; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: var(--surface); border: 1px solid #222; border-radius: 16px; padding: 48px 36px; width: 100%; max-width: 420px; margin: 20px; text-align: center; }
    .logo { font-size: 22px; font-weight: bold; letter-spacing: 5px; text-transform: uppercase; color: var(--red); margin-bottom: 8px; }
    .subtitle { font-size: 11px; color: var(--text-dim); letter-spacing: 2px; margin-bottom: 32px; }
    .lock-icon { font-size: 40px; margin-bottom: 20px; }
    .input-group { margin-bottom: 16px; }
    .input-group input { width: 100%; padding: 14px 16px; background: var(--bg); border: 1px solid #333; border-radius: 8px; color: var(--text); font-family: inherit; font-size: 14px; letter-spacing: 2px; text-align: center; outline: none; transition: border-color 0.2s; }
    .input-group input:focus { border-color: var(--red); }
    .input-group input::placeholder { color: #444; letter-spacing: 1px; }
    .submit-btn { width: 100%; padding: 14px; border: 2px solid var(--red); border-radius: 8px; background: rgba(255,45,45,0.1); color: var(--red); font-family: inherit; font-size: 13px; font-weight: bold; letter-spacing: 3px; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
    .submit-btn:hover { background: var(--red); color: #fff; box-shadow: 0 0 30px var(--red-glow); }
    .error { color: #ff4444; font-size: 11px; margin-bottom: 16px; padding: 10px; border: 1px solid #ff4444; border-radius: 6px; background: rgba(255,68,68,0.1); display: ${error ? 'block' : 'none'}; }
    .back-link { display: inline-block; margin-top: 20px; color: var(--text-dim); font-size: 10px; text-decoration: none; letter-spacing: 1px; }
    .back-link:hover { color: var(--text); }
    .divider { display: flex; align-items: center; gap: 12px; margin: 24px 0; color: var(--text-dim); font-size: 10px; letter-spacing: 2px; }
    .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid #333; }
    .admin-btn { width: 100%; padding: 12px; border: 1px solid #333; border-radius: 8px; background: transparent; color: var(--text-dim); font-family: inherit; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
    .admin-btn:hover { border-color: var(--amber); color: var(--amber); }
    .admin-form { display: none; margin-top: 16px; }
    .admin-form.active { display: block; }
    .admin-submit { width: 100%; padding: 12px; border: 2px solid var(--amber); border-radius: 8px; background: rgba(255,170,0,0.1); color: var(--amber); font-family: inherit; font-size: 12px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
    .admin-submit:hover { background: var(--amber); color: #000; }
    .label { font-size: 10px; color: var(--text-dim); letter-spacing: 1px; margin-bottom: 6px; text-align: left; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="lock-icon">🔒</div>
    <div class="logo">Subversive Radio</div>
    <div class="subtitle">BROADCASTER ACCESS</div>
    <div class="error">${error}</div>
    <form method="POST" action="/auth/login">
      <input type="hidden" name="redirect" value="${redirectTo}">
      <input type="hidden" name="mode" value="code">
      <div class="label">ACCESS CODE</div>
      <div class="input-group">
        <input type="text" name="code" placeholder="Enter access code" autofocus autocomplete="off" style="text-transform:uppercase">
      </div>
      <button type="submit" class="submit-btn">Enter</button>
    </form>
    <div class="divider">OR</div>
    <button class="admin-btn" onclick="document.getElementById('adminForm').classList.toggle('active')">🔑 Admin Login</button>
    <form method="POST" action="/auth/login" class="admin-form" id="adminForm">
      <input type="hidden" name="redirect" value="${redirectTo}">
      <input type="hidden" name="mode" value="admin">
      <div class="label">ADMIN PASSWORD</div>
      <div class="input-group">
        <input type="password" name="password" placeholder="Admin password">
      </div>
      <button type="submit" class="admin-submit">Admin Login</button>
    </form>
    <a href="/" class="back-link">&larr; Back to radio</a>
  </div>
</body>
</html>`;
}

// ========== END AUTH ==========

// ========== MULTI-CHANNEL SYSTEM ==========
const channels = new Map();
const CHANNELS_FILE = path.join(__dirname, 'channels.json');

function saveChannels() {
  const data = [];
  for (const [id, ch] of channels) {
    data.push({
      id,
      name: ch.name,
      stationName: ch.stationInfo.name,
      tagline: ch.stationInfo.tagline,
      serverRadioUrl: ch.serverRadioUrl || null
    });
  }
  try { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

function loadChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    for (const saved of data) {
      const ch = createChannel(saved.id, saved.name);
      if (saved.stationName) ch.stationInfo.name = saved.stationName;
      if (saved.tagline) ch.stationInfo.tagline = saved.tagline;
      if (saved.serverRadioUrl) ch.serverRadioUrl = saved.serverRadioUrl;
    }
  } catch (e) { console.error('Failed to load channels:', e.message); }
}

// ========== SCHEDULE SYSTEM ==========
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
let scheduleEntries = [];
let activeScheduleId = null;
let scheduleProcess = null;

function saveSchedule() {
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleEntries, null, 2)); } catch (e) {}
}

function loadSchedule() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return;
    scheduleEntries = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load schedule:', e.message); }
}

function resolveAudioUrl(url, callback) {
  // Direct stream URLs pass through, SoundCloud/Mixcloud use yt-dlp
  if (/soundcloud\.com|mixcloud\.com|youtube\.com|youtu\.be/.test(url)) {
    const proc = spawn('yt-dlp', ['--no-download', '-g', '-f', 'bestaudio', url]);
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      const resolved = output.trim().split('\n')[0];
      callback(code === 0 && resolved ? resolved : null);
    });
    proc.on('error', () => callback(null));
  } else {
    callback(url);
  }
}

const SCHEDULE_CACHE_DIR = path.join(__dirname, '.schedule-cache');
if (!fs.existsSync(SCHEDULE_CACHE_DIR)) fs.mkdirSync(SCHEDULE_CACHE_DIR, { recursive: true });

function getCachedFile(entryId) {
  const files = fs.readdirSync(SCHEDULE_CACHE_DIR).filter(f => f.startsWith(entryId + '_'));
  return files.length ? path.join(SCHEDULE_CACHE_DIR, files[0]) : null;
}

function downloadScheduleAudio(entry, callback) {
  const cached = getCachedFile(entry.id);
  if (cached) {
    console.log(`📅 Schedule: using cached file for "${entry.title}"`);
    return callback(cached);
  }

  const outFile = path.join(SCHEDULE_CACHE_DIR, entry.id + '_%(title)s.%(ext)s');
  console.log(`📅 Schedule: downloading "${entry.title}"...`);
  const dl = spawn('yt-dlp', ['-f', 'bestaudio', '-o', outFile, '--no-part', '--no-playlist', entry.url]);

  dl.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.startsWith('WARNING') && !msg.startsWith('[download]')) {
      console.error(`📅 Schedule download:`, msg);
    }
  });

  dl.on('close', (code) => {
    if (code !== 0) {
      console.error(`📅 Schedule: download failed for "${entry.title}" (code ${code})`);
      return callback(null);
    }
    const file = getCachedFile(entry.id);
    if (file) {
      console.log(`📅 Schedule: downloaded "${entry.title}" → ${path.basename(file)}`);
      callback(file);
    } else {
      console.error(`📅 Schedule: download completed but file not found`);
      callback(null);
    }
  });

  dl.on('error', (err) => {
    console.error(`📅 Schedule download error:`, err.message);
    callback(null);
  });

  return dl;
}

function startScheduleStream(entry, ch) {
  if (ch.broadcasterSocketId) return;
  if (scheduleProcess) {
    try { scheduleProcess.kill('SIGTERM'); } catch (e) {}
    scheduleProcess = null;
  }
  stopServerRadio(ch);

  const rate = ch.stationInfo.sampleRate || 44100;
  const needsYtdlp = /soundcloud\.com|mixcloud\.com|youtube\.com|youtu\.be/.test(entry.url);

  function playFile(filePath) {
    if (ch.broadcasterSocketId) return;
    const proc = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate),
      '-v', 'error',
      'pipe:1'
    ]);

    scheduleProcess = proc;
    activeScheduleId = entry.id;
    ch.stationInfo.isLive = true;
    ch.stationInfo.serverRadio = true;
    ch.stationInfo.currentTransmission = entry.title;
    io.to('listeners-' + ch.id).emit('station-live', ch.stationInfo);
    console.log(`📅 Schedule playing on [${ch.id}]: "${entry.title}"`);

    proc.stdout.on('data', (data) => {
      if (scheduleProcess !== proc) return;
      if (ch.broadcasterSocketId) return;
      io.to('listeners-' + ch.id).volatile.emit('audio-stream', data);
      writeToChannelStreamClients(ch, data);
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`📅 Schedule ffmpeg [${ch.id}]:`, msg);
    });

    proc.on('close', () => {
      if (scheduleProcess === proc) {
        scheduleProcess = null;
        activeScheduleId = null;
        ch.stationInfo.currentTransmission = null;
        if (!ch.broadcasterSocketId) {
          setTimeout(() => checkSchedule(), 2000);
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`📅 Schedule spawn error:`, err.message);
      scheduleProcess = null;
      activeScheduleId = null;
    });
  }

  if (needsYtdlp) {
    // Download first, then play from local file (fast start, no buffering)
    activeScheduleId = entry.id;
    ch.stationInfo.currentTransmission = '⏳ ' + entry.title;
    io.to('listeners-' + ch.id).emit('station-info', ch.stationInfo);

    const dlProc = downloadScheduleAudio(entry, (filePath) => {
      if (activeScheduleId !== entry.id) return;
      if (!filePath) {
        console.error(`📅 Schedule: cannot play "${entry.title}" — download failed`);
        activeScheduleId = null;
        ch.stationInfo.currentTransmission = null;
        return;
      }
      playFile(filePath);
    });
    // Store download process so stopScheduleStream can kill it
    scheduleProcess = dlProc;
    scheduleProcess._isDownloading = true;
  } else {
    // Direct URL — use ffmpeg directly with reconnect
    const proc = spawn('ffmpeg', [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', entry.url,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate),
      '-v', 'error',
      'pipe:1'
    ]);

    scheduleProcess = proc;
    activeScheduleId = entry.id;
    ch.stationInfo.isLive = true;
    ch.stationInfo.serverRadio = true;
    ch.stationInfo.currentTransmission = entry.title;
    io.to('listeners-' + ch.id).emit('station-live', ch.stationInfo);
    console.log(`📅 Schedule playing on [${ch.id}]: "${entry.title}"`);

    proc.stdout.on('data', (data) => {
      if (scheduleProcess !== proc) return;
      if (ch.broadcasterSocketId) return;
      io.to('listeners-' + ch.id).volatile.emit('audio-stream', data);
      writeToChannelStreamClients(ch, data);
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`📅 Schedule ffmpeg [${ch.id}]:`, msg);
    });

    proc.on('close', () => {
      if (scheduleProcess === proc) {
        scheduleProcess = null;
        activeScheduleId = null;
        ch.stationInfo.currentTransmission = null;
        if (!ch.broadcasterSocketId) {
          setTimeout(() => checkSchedule(), 2000);
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`📅 Schedule spawn error:`, err.message);
      scheduleProcess = null;
      activeScheduleId = null;
    });
  }
}

function stopScheduleStream() {
  if (scheduleProcess) {
    if (scheduleProcess._ytdlpProc) {
      try { scheduleProcess._ytdlpProc.kill('SIGTERM'); } catch (e) {}
    }
    try { scheduleProcess.kill('SIGTERM'); } catch (e) {}
    scheduleProcess = null;
  }
  activeScheduleId = null;
}

function checkSchedule() {
  const ch = getChannel('main');
  if (!ch) return;
  if (ch.broadcasterSocketId) return;

  const now = new Date();
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
  const minutes = now.getHours() * 60 + now.getMinutes();

  let matchedEntry = null;
  for (const entry of scheduleEntries) {
    if (!entry.enabled) continue;
    if (!entry.days.includes(day)) continue;
    const [sh, sm] = entry.startTime.split(':').map(Number);
    const [eh, em] = entry.endTime.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (end > start) {
      if (minutes >= start && minutes < end) { matchedEntry = entry; break; }
    } else {
      // Overnight: e.g. 22:00–02:00
      if (minutes >= start || minutes < end) { matchedEntry = entry; break; }
    }
  }

  if (matchedEntry) {
    if (activeScheduleId !== matchedEntry.id) {
      startScheduleStream(matchedEntry, ch);
    }
  } else {
    if (scheduleProcess) {
      stopScheduleStream();
      ch.stationInfo.isLive = false;
      ch.stationInfo.currentTransmission = null;
      io.to('listeners-' + ch.id).emit('station-offline');
      flushChannelStreamClients(ch);
      // Fall back to server radio
      if (ch.serverRadioUrl && !ch.serverRadioProcess) {
        setTimeout(() => startServerRadio(ch), 2000);
      }
    }
  }
}

// Check schedule every 30 seconds
setInterval(checkSchedule, 30000);

function createChannel(id, name) {
  if (channels.has(id)) return channels.get(id);
  const ch = {
    id,
    name: name || id.toUpperCase(),
    stationInfo: {
      name: name || 'SUBVERSIVE RADIO',
      tagline: 'Broadcasting from the underground',
      isLive: false,
      listenerCount: 0,
      currentTransmission: null,
      channelId: id
    },
    broadcasterSocketId: null,
    cohostSocketId: null,
    cohostMicAllowed: false,
    cohostAccessOpen: false,
    djInputSocketId: null,
    djInputAllowed: false,
    djInputAccessOpen: false,
    mutedUsers: new Set(),
    transmissions: [],
    streamClients: new Set(),
    mp3Encoder: null,
    mp3EncoderRate: 0,
    serverRadioUrl: null,
    serverRadioProcess: null
  };
  channels.set(id, ch);
  return ch;
}

// ========== SERVER RADIO (autopilot) ==========
function startServerRadio(ch) {
  if (!ch.serverRadioUrl || ch.serverRadioProcess) return;
  if (ch.broadcasterSocketId) return; // broadcaster is live, don't start
  const url = ch.serverRadioUrl;
  const rate = ch.stationInfo.sampleRate || 44100;

  console.log(`📻 Server radio starting on [${ch.id}]: ${url}`);
  const proc = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(rate),
    '-v', 'error',
    'pipe:1'
  ]);

  ch.serverRadioProcess = proc;
  ch.stationInfo.isLive = true;
  ch.stationInfo.serverRadio = true;
  io.to('listeners-' + ch.id).emit('station-live', ch.stationInfo);

  proc.stdout.on('data', (data) => {
    if (ch.serverRadioProcess !== proc) return;
    if (ch.broadcasterSocketId) return;
    io.to('listeners-' + ch.id).volatile.emit('audio-stream', data);
    writeToChannelStreamClients(ch, data);
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`📻 Server radio [${ch.id}] ffmpeg:`, msg);
  });

  proc.on('close', (code) => {
    if (ch.serverRadioProcess !== proc) return;
    ch.serverRadioProcess = null;
    console.log(`📻 Server radio stopped on [${ch.id}] (code ${code})`);
    // Auto-restart after 5s if no broadcaster and URL still set
    if (ch.serverRadioUrl && !ch.broadcasterSocketId) {
      ch.stationInfo.isLive = false;
      ch.stationInfo.serverRadio = false;
      io.to('listeners-' + ch.id).emit('station-offline');
      setTimeout(() => {
        if (ch.serverRadioUrl && !ch.broadcasterSocketId && !ch.serverRadioProcess) {
          startServerRadio(ch);
        }
      }, 5000);
    } else {
      ch.stationInfo.isLive = false;
      ch.stationInfo.serverRadio = false;
      io.to('listeners-' + ch.id).emit('station-offline');
    }
  });

  proc.on('error', (err) => {
    console.error(`📻 Server radio [${ch.id}] spawn error:`, err.message);
    ch.serverRadioProcess = null;
  });
}

function stopServerRadio(ch) {
  if (!ch.serverRadioProcess) return;
  console.log(`📻 Server radio stopping on [${ch.id}]`);
  const proc = ch.serverRadioProcess;
  ch.serverRadioProcess = null;
  ch.stationInfo.serverRadio = false;
  try { proc.kill('SIGTERM'); } catch(e) {}
}

// Create default channel, then load saved channels on top
createChannel('main', 'SUBVERSIVE RADIO');
loadChannels();
loadSchedule();

for (const [id, ch] of channels) {
  if (ch.serverRadioUrl) {
    console.log(`Auto-starting server radio for channel "${id}": ${ch.serverRadioUrl}`);
    startServerRadio(ch);
  }
}

// Run initial schedule check after 5s (let server radio start first, schedule overrides if needed)
setTimeout(checkSchedule, 5000);

function getChannel(id) {
  return channels.get(id || 'main');
}

function getChannelListenerCount(channelId) {
  const room = io.sockets.adapter.rooms.get('listeners-' + channelId);
  return room ? room.size : 0;
}

function getTotalListenerCount() {
  let total = 0;
  for (const [id] of channels) {
    total += getChannelListenerCount(id);
  }
  return total;
}

// backward compat
function getListenerCount() {
  return getTotalListenerCount();
}

let transmissions = []; // kept for backward compat with main channel

// ========== MP3 ENCODER ==========
let Mp3Encoder = null;
import('@breezystack/lamejs')
  .then(m => { Mp3Encoder = m.Mp3Encoder; })
  .catch(e => console.error('MP3 encoder failed to load — /stream disabled:', e.message));

function getChannelMp3Encoder(ch) {
  if (!Mp3Encoder) return null;
  const rate = ch.stationInfo.sampleRate || 44100;
  if (!ch.mp3Encoder || ch.mp3EncoderRate !== rate) {
    ch.mp3Encoder = new Mp3Encoder(1, rate, 192);
    ch.mp3EncoderRate = rate;
  }
  return ch.mp3Encoder;
}

function writeToChannelStreamClients(ch, data) {
  if (!ch.streamClients.size) return;
  let chunk;
  try {
    const enc = getChannelMp3Encoder(ch);
    if (!enc) return;
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.byteOffset % 2 !== 0) buf = Buffer.from(buf);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const mp3 = enc.encodeBuffer(pcm);
    if (!mp3 || !mp3.length) return;
    chunk = Buffer.from(mp3.buffer, mp3.byteOffset, mp3.byteLength);
  } catch (e) {
    console.error('MP3 encode error (chunk dropped):', e.message);
    ch.mp3Encoder = null;
    return;
  }
  for (const res of ch.streamClients) {
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); ch.streamClients.delete(res); continue; }
    try { res.write(chunk); } catch (e) { ch.streamClients.delete(res); }
  }
}

function flushChannelStreamClients(ch) {
  if (!ch.mp3Encoder) return;
  try {
    const tail = ch.mp3Encoder.flush();
    if (tail && tail.length) {
      const chunk = Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength);
      for (const res of ch.streamClients) { try { res.write(chunk); } catch (e) {} }
    }
  } catch (e) {}
  ch.mp3Encoder = null;
}

// ========== STATIC & MIDDLEWARE ==========
app.get('/lamejs.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@breezystack/lamejs/dist/lamejs.iife.js'));
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== AUTH ROUTES ==========
app.get('/auth/login', (req, res) => {
  const redirect = req.query.redirect || '/broadcaster';
  res.send(loginPageHTML('', redirect));
});

app.post('/auth/login', (req, res) => {
  const { mode, code, password, redirect } = req.body;
  const redirectTo = redirect || '/broadcaster';

  if (mode === 'admin') {
    if (password === adminPassword) {
      const token = generateToken();
      activeSessions.set(token, { expiry: Date.now() + 24 * 60 * 60 * 1000, role: 'admin', label: 'Admin' });
      res.setHeader('Set-Cookie', `br_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      res.redirect(redirectTo);
    } else {
      res.send(loginPageHTML('Wrong admin password.', redirectTo));
    }
  } else {
    const upperCode = (code || '').trim().toUpperCase();
    const entry = accessCodes.get(upperCode);
    if (!entry) return res.send(loginPageHTML('Invalid access code.', redirectTo));
    if (entry.expiresAt && Date.now() > entry.expiresAt) return res.send(loginPageHTML('This code has expired.', redirectTo));
    if (entry.maxUses && entry.uses >= entry.maxUses) return res.send(loginPageHTML('This code has reached its use limit.', redirectTo));
    entry.uses++;
    entry.lastUsed = new Date().toISOString();
    const token = generateToken();
    activeSessions.set(token, { expiry: Date.now() + 24 * 60 * 60 * 1000, role: 'user', label: entry.label || upperCode, channel: entry.channel || null });
    res.setHeader('Set-Cookie', `br_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    // If code is locked to a channel, redirect to that channel's broadcaster
    if (entry.channel && redirectTo === '/broadcaster') {
      return res.redirect('/broadcaster?channel=' + encodeURIComponent(entry.channel));
    }
    res.redirect(redirectTo);
  }
});

app.get('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.br_token) activeSessions.delete(cookies.br_token);
  res.setHeader('Set-Cookie', 'br_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

app.post('/api/change-password', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== adminPassword) return res.status(403).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  adminPassword = newPassword;
  res.json({ ok: true, message: 'Admin password changed' });
});

// ========== ADMIN API ==========
app.post('/api/admin/codes', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { label, maxUses, expiresIn, channel } = req.body;
  const code = generateCode();
  accessCodes.set(code, {
    label: label || 'Guest',
    createdAt: new Date().toISOString(),
    maxUses: maxUses || 0,
    uses: 0,
    expiresAt: expiresIn ? Date.now() + expiresIn * 60 * 60 * 1000 : null,
    lastUsed: null,
    channel: channel || null
  });
  res.json({ ok: true, code });
});

app.get('/api/admin/codes', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const codes = [];
  for (const [code, info] of accessCodes) {
    codes.push({ code, ...info, expired: info.expiresAt ? Date.now() > info.expiresAt : false });
  }
  res.json(codes);
});

app.delete('/api/admin/codes/:code', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  accessCodes.delete(req.params.code.toUpperCase());
  res.json({ ok: true });
});

app.get('/api/admin/sessions', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const sessions = [];
  for (const [token, info] of activeSessions) {
    if (Date.now() < info.expiry) {
      sessions.push({ token: token.slice(0, 8) + '...', role: info.role, label: info.label, expiresIn: Math.round((info.expiry - Date.now()) / 60000) + ' min' });
    }
  }
  res.json(sessions);
});

app.post('/api/admin/revoke-all', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const adminTokens = [];
  for (const [token, info] of activeSessions) {
    if (info.role === 'admin') adminTokens.push([token, info]);
  }
  activeSessions.clear();
  adminTokens.forEach(([t, i]) => activeSessions.set(t, i));
  res.json({ ok: true, message: 'All user sessions revoked' });
});

// ========== CHANNEL API ==========
app.get('/api/channels', (req, res) => {
  const session = getSession(req);
  const admin = session && session.role === 'admin';
  const lockedChannel = session && session.channel ? session.channel : null;
  const list = [];
  for (const [id, ch] of channels) {
    if (!admin) {
      // Locked to a channel: only see that channel
      if (lockedChannel && id !== lockedChannel) continue;
    }

    const entry = {
      id,
      name: ch.name,
      isLive: ch.stationInfo.isLive,
      listeners: getChannelListenerCount(id),
      hasBroadcaster: !!ch.broadcasterSocketId,
      stationName: ch.stationInfo.name,
      tagline: ch.stationInfo.tagline
    };
    // Only expose server radio info to admin
    if (admin) {
      entry.serverRadioUrl = ch.serverRadioUrl || null;
      entry.serverRadioActive = !!ch.serverRadioProcess;
    }
    list.push(entry);
  }
  res.json(list);
});

app.post('/api/channels', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  if (channels.size >= MAX_CHANNELS) return res.status(400).json({ error: 'Max ' + MAX_CHANNELS + ' channels' });
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Channel name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
  if (channels.has(id)) return res.status(400).json({ error: 'Channel already exists' });
  createChannel(id, name);
  saveChannels();
  res.json({ ok: true, id, name });
});

app.delete('/api/channels/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = req.params.id;
  if (id === 'main') return res.status(400).json({ error: 'Cannot delete main channel' });
  const ch = channels.get(id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  stopServerRadio(ch);
  if (ch.broadcasterSocketId) {
    io.to(ch.broadcasterSocketId).emit('channel-deleted');
  }
  io.to('listeners-' + id).emit('station-offline');
  channels.delete(id);
  saveChannels();
  res.json({ ok: true });
});

// ========== SERVER RADIO API ==========
app.post('/api/server-radio', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { channel, url, start } = req.body;
  const channelId = channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (url === '' || url === null || url === undefined) {
    stopServerRadio(ch);
    ch.serverRadioUrl = null;
    saveChannels();
    return res.json({ ok: true, channel: channelId, url: null, active: false });
  }
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Valid stream URL required' });
  }
  stopServerRadio(ch);
  ch.serverRadioUrl = url.trim();
  saveChannels();
  if (start !== false) {
    startServerRadio(ch);
  }
  res.json({ ok: true, channel: channelId, url: ch.serverRadioUrl, active: !!ch.serverRadioProcess });
});

app.delete('/api/server-radio/:channel?', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const channelId = req.params.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  stopServerRadio(ch);
  if (!ch.broadcasterSocketId) {
    ch.stationInfo.isLive = false;
    ch.stationInfo.serverRadio = false;
    io.to('listeners-' + channelId).emit('station-offline');
    flushChannelStreamClients(ch);
  }
  res.json({ ok: true });
});

// ========== SCHEDULE API ==========
app.get('/api/schedule', (req, res) => {
  // Public: anyone can see the schedule (for timetable display)
  const publicList = scheduleEntries.map(e => ({
    id: e.id,
    title: e.title,
    artist: e.artist || '',
    days: e.days,
    startTime: e.startTime,
    endTime: e.endTime,
    enabled: e.enabled,
    isPlaying: activeScheduleId === e.id
  }));
  // Admin gets the URLs too
  if (isAdmin(req)) {
    publicList.forEach((e, i) => { e.url = scheduleEntries[i].url; });
  }
  res.json(publicList);
});

app.post('/api/schedule', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { title, artist, url, days, startTime, endTime } = req.body;
  if (!title || !url || !days || !startTime || !endTime) {
    return res.status(400).json({ error: 'title, url, days, startTime, endTime required' });
  }
  const entry = {
    id: uuidv4().slice(0, 8),
    title: String(title).slice(0, 100),
    artist: String(artist || '').slice(0, 100),
    url: String(url).trim(),
    days: Array.isArray(days) ? days : [days],
    startTime: String(startTime),
    endTime: String(endTime),
    enabled: true,
    createdAt: new Date().toISOString()
  };
  scheduleEntries.push(entry);
  saveSchedule();
  checkSchedule();
  res.json({ ok: true, entry });
});

app.put('/api/schedule/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const entry = scheduleEntries.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { title, artist, url, days, startTime, endTime, enabled } = req.body;
  if (title !== undefined) entry.title = String(title).slice(0, 100);
  if (artist !== undefined) entry.artist = String(artist || '').slice(0, 100);
  if (url !== undefined) entry.url = String(url).trim();
  if (days !== undefined) entry.days = Array.isArray(days) ? days : [days];
  if (startTime !== undefined) entry.startTime = String(startTime);
  if (endTime !== undefined) entry.endTime = String(endTime);
  if (enabled !== undefined) entry.enabled = !!enabled;
  saveSchedule();
  checkSchedule();
  res.json({ ok: true, entry });
});

app.delete('/api/schedule/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const idx = scheduleEntries.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (activeScheduleId === scheduleEntries[idx].id) {
    stopScheduleStream();
  }
  scheduleEntries.splice(idx, 1);
  saveSchedule();
  res.json({ ok: true });
});

// ========== PROTECTED PAGES ==========
app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/auth/login?redirect=/admin');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/broadcaster', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/auth/login?redirect=/broadcaster');
  // If user is locked to a channel but URL doesn't have it, redirect
  const session = getSession(req);
  if (session && session.channel && req.query.channel !== session.channel) {
    return res.redirect('/broadcaster?channel=' + encodeURIComponent(session.channel));
  }
  res.sendFile(path.join(__dirname, 'broadcaster.html'));
});

app.get('/dj-input', (req, res) => {
  const channelId = req.query.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch || !ch.djInputAccessOpen) {
    return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DJ Input — Subversive Radio</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}.msg{max-width:320px}.msg h1{font-size:14px;letter-spacing:3px;color:#ff3333;margin-bottom:16px}.msg p{font-size:13px;color:#666;line-height:1.6}</style></head><body><div class="msg"><h1>DJ INPUT CLOSED</h1><p>The host hasn't opened DJ input access yet. Ask them to enable it from the broadcaster panel.</p></div></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'dj-input.html'));
});

app.get('/cohost', (req, res) => {
  const channelId = req.query.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch || !ch.cohostAccessOpen) {
    return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Co-Host — Subversive Radio</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}.msg{max-width:320px}.msg h1{font-size:14px;letter-spacing:3px;color:#ff3333;margin-bottom:16px}.msg p{font-size:13px;color:#666;line-height:1.6}</style></head><body><div class="msg"><h1>CO-HOST ACCESS CLOSED</h1><p>The host hasn't opened co-host access yet. Ask them to enable it from the broadcaster panel.</p></div></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'cohost.html'));
});

app.get('/download', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/auth/login?redirect=/download');
  res.sendFile(path.join(__dirname, 'download.html'));
});

app.get('/download/mac', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).send('Unauthorized');
  const dmgPath = path.join(__dirname, 'dist', 'Subversive Radio-1.0.0-arm64.dmg');
  if (fs.existsSync(dmgPath)) {
    res.download(dmgPath, 'Subversive-Radio-Installer.dmg');
  } else {
    res.status(404).send('DMG not available');
  }
});

app.get('/health', (req, res) => {
  const channelStats = [];
  for (const [id, ch] of channels) {
    channelStats.push({ id, live: ch.stationInfo.isLive, listeners: getChannelListenerCount(id) });
  }
  res.json({
    status: 'ok',
    channels: channelStats,
    totalListeners: getTotalListenerCount(),
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// Current user's session info (used by broadcaster to check channel lock)
app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ role: session.role, label: session.label, channel: session.channel || null });
});

// Station API — supports ?channel= query param
app.get('/api/station', (req, res) => {
  const channelId = req.query.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  const broadcastUrl = tunnelUrl || `${req.protocol}://${req.get('host')}`;
  res.json({ ...ch.stationInfo, tunnelUrl: broadcastUrl, listenerCount: getChannelListenerCount(channelId) });
});

app.get('/api/transmissions', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const channelId = req.query.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  res.json(ch.transmissions.map(t => ({
    id: t.id, title: t.title, duration: t.duration,
    createdAt: t.createdAt, played: t.played
  })));
});

app.post('/api/transmissions', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { title, audioData, duration, channel } = req.body;
  const channelId = channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!audioData || typeof audioData !== 'string') return res.status(400).json({ error: 'Missing audio data' });
  if (audioData.length > 40 * 1024 * 1024) return res.status(413).json({ error: 'Transmission too large (max 40MB)' });
  const transmission = {
    id: uuidv4(),
    title: title || `Transmission #${ch.transmissions.length + 1}`,
    audioData, duration,
    createdAt: new Date().toISOString(),
    played: 0
  };
  ch.transmissions.push(transmission);
  io.to('broadcaster-' + channelId).emit('transmissions-updated', ch.transmissions.length);
  res.json({ id: transmission.id });
});

app.delete('/api/transmissions/:id', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const channelId = req.query.channel || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  ch.transmissions = ch.transmissions.filter(t => t.id !== req.params.id);
  res.json({ ok: true });
});

// Stream proxy
app.get('/api/stream-proxy', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const streamUrl = req.query.url;
  if (!streamUrl || !streamUrl.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

  const proto = streamUrl.startsWith('https') ? require('https') : require('http');
  const request = proto.get(streamUrl, { headers: { 'User-Agent': 'SubversiveRadio/1.0' } }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      return res.redirect('/api/stream-proxy?url=' + encodeURIComponent(upstream.headers.location));
    }
    if (upstream.statusCode !== 200) return res.status(502).json({ error: 'Stream returned ' + upstream.statusCode });
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.pipe(res);
    req.on('close', () => upstream.destroy());
  });
  request.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: 'Stream unreachable' }); });
  request.setTimeout(10000, () => { request.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Stream timeout' }); });
});

// Per-channel MP3 stream: /stream or /stream/main or /stream/reggae etc.
app.get('/stream/:channelId?', (req, res) => {
  const channelId = req.params.channelId || 'main';
  const ch = getChannel(channelId);
  if (!ch) return res.status(404).end('Channel not found');
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
    'Connection': 'keep-alive',
  });
  ch.streamClients.add(res);
  req.on('close', () => ch.streamClients.delete(res));
});

// Embeddable mini player — supports ?channel=
app.get('/embed', (req, res) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', '');
  res.send(embedPlayerHTML(req));
});

function embedPlayerHTML(req) {
  const host = `${req.protocol}://${req.get('host')}`;
  const channelId = req.query.channel || 'main';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subversive Radio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'SF Mono','Courier New',monospace;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.player{background:#141414;border:1px solid #222;border-radius:14px;padding:24px;width:100%;max-width:360px;text-align:center}
.status{display:inline-block;padding:4px 12px;border:1px solid #333;border-radius:16px;font-size:9px;letter-spacing:2px;color:#666;text-transform:uppercase;margin-bottom:12px}
.status.live{border-color:#ff2d2d;color:#ff2d2d;box-shadow:0 0 10px rgba(255,45,45,0.3);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.title{font-size:18px;font-weight:700;letter-spacing:4px;color:#ff2d2d;margin-bottom:6px}
.tagline{font-size:11px;color:#666;letter-spacing:1px;margin-bottom:20px}
.play-btn{width:80px;height:80px;border-radius:50%;border:2px solid #333;background:transparent;color:#e0e0e0;font-size:11px;letter-spacing:2px;cursor:pointer;transition:all .3s;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}
.play-btn:hover{border-color:#ff2d2d;color:#ff2d2d;box-shadow:0 0 20px rgba(255,45,45,0.2)}
.play-btn.listening{border-color:#00ff88;color:#00ff88;box-shadow:0 0 20px rgba(0,255,136,0.2)}
.vol-row{display:flex;align-items:center;gap:8px;margin-top:18px}
.vol-row label{font-size:9px;color:#666;letter-spacing:1px}
.vol-row input[type=range]{flex:1;-webkit-appearance:none;background:#222;height:3px;border-radius:2px;outline:none}
.vol-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#ff2d2d;cursor:pointer}
.listeners{font-size:9px;color:#444;margin-top:12px;letter-spacing:1px}
.offline-msg{font-size:11px;color:#444;margin-top:8px}
</style>
</head>
<body>
<div class="player">
  <div class="status" id="badge">OFFLINE</div>
  <div class="title" id="stName">SUBVERSIVE RADIO</div>
  <div class="tagline" id="stTag">Broadcasting from the underground</div>
  <button class="play-btn" id="playBtn" onclick="toggle()">TUNE IN</button>
  <div class="offline-msg" id="offMsg">Station is offline</div>
  <div class="vol-row" style="display:none" id="volRow">
    <label>VOL</label>
    <input type="range" id="vol" min="0" max="1" step="0.05" value="1" oninput="setVol(this.value)">
  </div>
  <div class="listeners" id="lCount"></div>
</div>
<script src="${host}/socket.io/socket.io.js"></script>
<script>
const SERVER='${host}';
const CHANNEL='${channelId}';
let socket,player=null,isListening=false,isLive=false,vol=1;

fetch(SERVER+'/api/station?channel='+CHANNEL).then(r=>r.json()).then(d=>{
  document.getElementById('stName').textContent=d.name||'SUBVERSIVE RADIO';
  document.getElementById('stTag').textContent=d.tagline||'';
  if(d.isLive){isLive=true;goLive();}
  if(d.listenerCount)document.getElementById('lCount').textContent=d.listenerCount+' listening';
}).catch(()=>{});

socket=io(SERVER,{transports:['websocket','polling']});
socket.on('connect',()=>{socket.emit('join-listener',{channel:CHANNEL});});
socket.on('station-live',d=>{isLive=true;goLive();});
socket.on('station-offline',()=>{isLive=false;goOff();if(isListening)toggle();});
socket.on('station-info',d=>{if(d&&d.isLive&&!isLive){isLive=true;goLive();}});
socket.on('listener-count',c=>{document.getElementById('lCount').textContent=c>0?c+' listening':'';});

function goLive(){
  document.getElementById('badge').textContent='LIVE';
  document.getElementById('badge').classList.add('live');
  document.getElementById('offMsg').style.display='none';
}
function goOff(){
  document.getElementById('badge').textContent='OFFLINE';
  document.getElementById('badge').classList.remove('live');
  document.getElementById('offMsg').style.display='';
}

function toggle(){
  const btn=document.getElementById('playBtn');
  if(!isListening){
    if(!isLive)return;
    player=new Audio(SERVER+'/stream/'+CHANNEL);
    player.volume=vol;
    player.play().catch(()=>{});
    isListening=true;
    btn.textContent='LISTENING';btn.classList.add('listening');
    document.getElementById('volRow').style.display='flex';
  }else{
    if(player){player.pause();player.src='';player=null;}
    isListening=false;
    btn.textContent='TUNE IN';btn.classList.remove('listening');
    document.getElementById('volRow').style.display='none';
  }
}
function setVol(v){vol=parseFloat(v);if(player)player.volume=vol;}
</script>
</body>
</html>`;
}

// ========== SOCKET.IO — MULTI-CHANNEL ==========

io.on('connection', (socket) => {
  let isBroadcaster = false;
  let isCoHost = false;
  let isListener = false;
  let isDjInput = false;
  let myChannelId = null;

  function myChannel() { return getChannel(myChannelId); }

  // BROADCASTER — now includes channelId with channel lock enforcement
  socket.on('join-broadcaster', (opts) => {
    const channelId = (opts && opts.channel) || 'main';
    const ch = getChannel(channelId);
    if (!ch) return socket.emit('error-msg', 'Channel not found');

    // Must be authenticated to broadcast
    const sessionToken = parseCookies(socket.handshake).br_token;
    const session = sessionToken ? activeSessions.get(sessionToken) : null;
    if (!session) {
      return socket.emit('error-msg', 'Not authenticated — please log in first');
    }

    // Server-side channel lock: check if this user's session is locked to a different channel
    if (session.channel && session.channel !== channelId) {
      return socket.emit('error-msg', 'Your access code is locked to channel: ' + session.channel);
    }

    socket.join('broadcaster-' + channelId);
    isBroadcaster = true;
    myChannelId = channelId;
    stopServerRadio(ch);
    stopScheduleStream();
    ch.broadcasterSocketId = socket.id;
    console.log(`🎙️  Broadcaster connected to [${channelId}]`);
    socket.emit('listener-count', getChannelListenerCount(channelId));
    socket.emit('channel-joined', { channelId, channelName: ch.name });
    const url = tunnelUrl || `http://${socket.handshake.headers.host}`;
    socket.emit('tunnel-url', url);
  });

  // CO-HOST
  socket.on('join-cohost', (info) => {
    const channelId = (info && info.channel) || 'main';
    const ch = getChannel(channelId);
    if (!ch) return;
    if (!ch.cohostAccessOpen) {
      socket.emit('cohost-kicked');
      return;
    }

    if (ch.cohostSocketId && ch.cohostSocketId !== socket.id) {
      io.to(ch.cohostSocketId).emit('cohost-kicked');
    }

    isCoHost = true;
    myChannelId = channelId;
    ch.cohostSocketId = socket.id;
    ch.cohostMicAllowed = false;
    const name = (info && info.name) ? info.name.slice(0, 20) : 'Co-Host';
    console.log(`🎙️  Co-host connected to [${channelId}]:`, name);
    socket.emit('listener-count', getChannelListenerCount(channelId));
    socket.emit('station-info', ch.stationInfo);
    socket.emit('cohost-mic-state', false);
    if (ch.broadcasterSocketId) {
      io.to(ch.broadcasterSocketId).emit('cohost-joined', { id: socket.id, name });
    }
  });

  socket.on('cohost-access-toggle', (open) => {
    if (!isBroadcaster) return;
    const ch = myChannel();
    if (!ch) return;
    ch.cohostAccessOpen = !!open;
    console.log(`🎙️  Co-host access [${myChannelId}]:`, ch.cohostAccessOpen ? 'OPEN' : 'CLOSED');
    if (!ch.cohostAccessOpen && ch.cohostSocketId) {
      io.to(ch.cohostSocketId).emit('cohost-kicked');
      ch.cohostSocketId = null;
      ch.cohostMicAllowed = false;
      io.to(ch.broadcasterSocketId).emit('cohost-left');
    }
  });

  socket.on('cohost-mic-toggle', (allowed) => {
    if (!isBroadcaster) return;
    const ch = myChannel();
    if (!ch) return;
    ch.cohostMicAllowed = !!allowed;
    if (ch.cohostSocketId) {
      io.to(ch.cohostSocketId).emit('cohost-mic-state', ch.cohostMicAllowed);
    }
  });

  // DJ INPUT
  socket.on('join-dj-input', (info) => {
    const channelId = (info && info.channel) || 'main';
    const ch = getChannel(channelId);
    if (!ch) return;
    if (!ch.djInputAccessOpen) {
      socket.emit('dj-input-kicked');
      return;
    }

    if (ch.djInputSocketId && ch.djInputSocketId !== socket.id) {
      io.to(ch.djInputSocketId).emit('dj-input-kicked');
    }

    isDjInput = true;
    myChannelId = channelId;
    ch.djInputSocketId = socket.id;
    ch.djInputAllowed = false;
    const name = (info && info.name) ? info.name.slice(0, 20) : 'DJ Input';
    console.log(`🎧  DJ input connected to [${channelId}]:`, name);
    socket.emit('dj-input-state', false);
    socket.emit('station-info', ch.stationInfo);
    if (ch.broadcasterSocketId) {
      io.to(ch.broadcasterSocketId).emit('dj-input-joined', { id: socket.id, name });
    }
  });

  socket.on('dj-input-access-toggle', (open) => {
    if (!isBroadcaster) return;
    const ch = myChannel();
    if (!ch) return;
    ch.djInputAccessOpen = !!open;
    console.log(`🎧  DJ input access [${myChannelId}]:`, ch.djInputAccessOpen ? 'OPEN' : 'CLOSED');
    if (!ch.djInputAccessOpen && ch.djInputSocketId) {
      io.to(ch.djInputSocketId).emit('dj-input-kicked');
      ch.djInputSocketId = null;
      ch.djInputAllowed = false;
      io.to(ch.broadcasterSocketId).emit('dj-input-left');
    }
  });

  socket.on('dj-input-toggle', (allowed) => {
    if (!isBroadcaster) return;
    const ch = myChannel();
    if (!ch) return;
    ch.djInputAllowed = !!allowed;
    if (ch.djInputSocketId) {
      io.to(ch.djInputSocketId).emit('dj-input-state', ch.djInputAllowed);
    }
  });

  // LISTENER — now includes channelId
  socket.on('join-listener', (opts) => {
    const channelId = (opts && opts.channel) || 'main';
    const ch = getChannel(channelId);
    if (!ch) return;

    // Leave any previous channel
    if (myChannelId && myChannelId !== channelId) {
      socket.leave('listeners-' + myChannelId);
      const oldCh = getChannel(myChannelId);
      if (oldCh) {
        const oldCount = getChannelListenerCount(myChannelId);
        io.to('broadcaster-' + myChannelId).emit('listener-count', oldCount);
      }
    }

    socket.join('listeners-' + channelId);
    isListener = true;
    myChannelId = channelId;
    const count = getChannelListenerCount(channelId);
    console.log(`👤 Listener joined [${channelId}] (${count} total)`);
    io.to('broadcaster-' + channelId).emit('listener-count', count);
    socket.emit('station-info', ch.stationInfo);
    socket.emit('channel-joined', { channelId, channelName: ch.name });
  });

  // AUDIO STREAM — routed per channel
  socket.on('audio-stream', (data) => {
    if (!myChannelId) return;
    const ch = myChannel();
    if (!ch) return;

    if (!isBroadcaster && !isCoHost && !isDjInput) return;
    if (isCoHost && !ch.cohostMicAllowed) return;
    if (isDjInput && !ch.djInputAllowed) return;

    if (isCoHost) {
      if (ch.broadcasterSocketId) {
        io.to(ch.broadcasterSocketId).volatile.emit('cohost-audio', data);
      }
      return;
    }

    if (isDjInput) {
      if (ch.broadcasterSocketId) {
        io.to(ch.broadcasterSocketId).volatile.emit('dj-input-audio', data);
      }
      return;
    }

    // Broadcaster audio — send to this channel's listeners only
    io.to('listeners-' + myChannelId).volatile.emit('audio-stream', data);
    writeToChannelStreamClients(ch, data);
  });

  // STATION CONTROLS — per channel (broadcaster only)
  socket.on('go-live', (info) => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    // Stop server radio and schedule — live broadcaster takes over
    stopServerRadio(ch);
    stopScheduleStream();
    ch.stationInfo.isLive = true;
    ch.stationInfo.serverRadio = false;
    if (info) {
      ch.stationInfo.name = info.name || ch.stationInfo.name;
      ch.stationInfo.tagline = info.tagline || ch.stationInfo.tagline;
      ch.stationInfo.sampleRate = info.sampleRate || 44100;
    }
    io.to('listeners-' + myChannelId).emit('station-live', ch.stationInfo);
    console.log(`🔴 LIVE [${myChannelId}]: ${ch.stationInfo.name} (${getChannelListenerCount(myChannelId)} listeners)`);
  });

  socket.on('go-offline', () => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    ch.stationInfo.isLive = false;
    ch.stationInfo.currentTransmission = null;
    io.to('listeners-' + myChannelId).emit('station-offline');
    flushChannelStreamClients(ch);
    console.log(`⭕ [${myChannelId}] Station offline`);
    // Resume schedule or server radio
    setTimeout(() => {
      if (!ch.broadcasterSocketId) {
        checkSchedule();
        if (!activeScheduleId && ch.serverRadioUrl && !ch.serverRadioProcess) {
          startServerRadio(ch);
        }
      }
    }, 3000);
  });

  socket.on('play-transmission', (id) => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    const t = ch.transmissions.find(tr => tr.id === id);
    if (t) {
      t.played++;
      ch.stationInfo.currentTransmission = t.title;
      io.to('listeners-' + myChannelId).emit('transmission-start', {
        title: t.title, audioData: t.audioData, duration: t.duration
      });
      io.to('broadcaster-' + myChannelId).emit('transmission-playing', t.id);
    }
  });

  socket.on('transmission-ended', () => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    ch.stationInfo.currentTransmission = null;
    io.to('listeners-' + myChannelId).emit('transmission-end');
  });

  socket.on('update-station', (info) => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    ch.stationInfo.name = info.name || ch.stationInfo.name;
    ch.stationInfo.tagline = info.tagline || ch.stationInfo.tagline;
    saveChannels();
    io.to('listeners-' + myChannelId).emit('station-info', ch.stationInfo);
  });

  // LIVE CHAT — per channel
  socket.on('chat-message', (msg) => {
    if (!myChannelId) return;
    const ch = myChannel();
    if (!ch) return;
    if (!msg || !msg.text || typeof msg.text !== 'string') return;
    const text = msg.text.trim().slice(0, 500);
    if (!text) return;
    const from = (isBroadcaster || isCoHost) ? 'DJ' : (msg.name || 'Listener').slice(0, 20);
    if (ch.mutedUsers.has(from)) return;
    const chatMsg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text, from,
      isDJ: isBroadcaster || isCoHost,
      time: new Date().toISOString()
    };
    io.to('listeners-' + myChannelId).emit('chat-message', chatMsg);
    io.to('broadcaster-' + myChannelId).emit('chat-message', chatMsg);
  });

  socket.on('chat-pin', (msgId) => {
    if (!isBroadcaster || !myChannelId) return;
    io.to('listeners-' + myChannelId).emit('chat-pin', msgId);
  });

  socket.on('chat-delete', (msgId) => {
    if (!isBroadcaster || !myChannelId) return;
    io.to('listeners-' + myChannelId).emit('chat-delete', msgId);
    io.to('broadcaster-' + myChannelId).emit('chat-delete', msgId);
  });

  socket.on('chat-mute', (userName) => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (ch) ch.mutedUsers.add(userName);
    io.to('broadcaster-' + myChannelId).emit('chat-muted', userName);
  });

  socket.on('chat-unmute', (userName) => {
    if (!isBroadcaster || !myChannelId) return;
    const ch = myChannel();
    if (ch) ch.mutedUsers.delete(userName);
    io.to('broadcaster-' + myChannelId).emit('chat-unmuted', userName);
  });

  socket.on('chat-clear', () => {
    if (!isBroadcaster || !myChannelId) return;
    io.to('listeners-' + myChannelId).emit('chat-clear');
    io.to('broadcaster-' + myChannelId).emit('chat-clear');
  });

  // DISCONNECT — clean up channel state
  socket.on('disconnect', () => {
    if (!myChannelId) return;
    const ch = myChannel();
    if (!ch) return;

    if (isListener) {
      const count = getChannelListenerCount(myChannelId);
      io.to('broadcaster-' + myChannelId).emit('listener-count', count);
    }
    if (isBroadcaster && ch.broadcasterSocketId === socket.id) {
      ch.stationInfo.isLive = false;
      ch.stationInfo.currentTransmission = null;
      ch.broadcasterSocketId = null;
      io.to('listeners-' + myChannelId).emit('station-offline');
      flushChannelStreamClients(ch);
      console.log(`🎙️  Broadcaster disconnected from [${myChannelId}]`);
      // Resume scheduled content or server radio
      setTimeout(() => {
        if (!ch.broadcasterSocketId) {
          checkSchedule();
          if (!scheduleProcess && ch.serverRadioUrl && !ch.serverRadioProcess) {
            startServerRadio(ch);
          }
        }
      }, 3000);
    }
    if (isCoHost && ch.cohostSocketId === socket.id) {
      ch.cohostSocketId = null;
      ch.cohostMicAllowed = false;
      if (ch.broadcasterSocketId) {
        io.to(ch.broadcasterSocketId).emit('cohost-left');
      }
      console.log(`🎙️  Co-host disconnected from [${myChannelId}]`);
    }
    if (isDjInput && ch.djInputSocketId === socket.id) {
      ch.djInputSocketId = null;
      ch.djInputAllowed = false;
      if (ch.broadcasterSocketId) {
        io.to(ch.broadcasterSocketId).emit('dj-input-left');
      }
      console.log(`🎧  DJ input disconnected from [${myChannelId}]`);
    }
  });

  socket.on('error', (err) => {
    console.error(`Socket error (${socket.id}):`, err.message);
  });
});

// ========== MEMORY CLEANUP ==========
setInterval(() => {
  for (const [id, ch] of channels) {
    if (ch.transmissions.length > 20) {
      ch.transmissions = ch.transmissions.slice(-20);
    }
  }

  for (const [token, session] of activeSessions) {
    if (Date.now() > session.expiry) activeSessions.delete(token);
  }

  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const total = getTotalListenerCount();
  const liveChannels = [...channels.values()].filter(ch => ch.stationInfo.isLive);
  if (total > 0 || liveChannels.length > 0) {
    console.log(`📊 Channels: ${channels.size} | Live: ${liveChannels.length} | Listeners: ${total} | Memory: ${mem}MB`);
  }
}, 60000);

// ========== TUNNEL ==========
let tunnelRetryDelay = 3000;
function startTunnel() {
  const localBin = path.join(__dirname, 'cloudflared');
  const tmpBin = '/tmp/cloudflared';
  let cfPath = null;

  if (fs.existsSync(localBin)) cfPath = localBin;
  else if (fs.existsSync(tmpBin)) cfPath = tmpBin;
  else { console.log('⚠️  cloudflared not found — no public link'); return; }

  console.log('🔗 Opening tunnel...');
  const cf = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  function checkOutput(data) {
    const match = data.toString().match(urlRegex);
    if (match && !tunnelUrl) {
      tunnelRetryDelay = 3000;
      tunnelUrl = match[0];
      console.log(`\n🔴 BROADCAST: ${tunnelUrl}`);
      console.log(`🎙️  STUDIO:    ${tunnelUrl}/broadcaster\n`);
      for (const [id] of channels) {
        io.to('broadcaster-' + id).emit('tunnel-url', tunnelUrl);
      }
    }
  }
  cf.stdout.on('data', checkOutput);
  cf.stderr.on('data', checkOutput);
  cf.on('close', () => { tunnelUrl = null; tunnelRetryDelay = Math.min(tunnelRetryDelay * 2, 60000); setTimeout(startTunnel, tunnelRetryDelay); });
  cf.on('error', (err) => console.error('Tunnel error:', err.message));
}

// ========== START ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 Subversive Radio v2.0 — Multi-Channel`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Channels: ${channels.size} (max ${MAX_CHANNELS})`);
  console.log(`   🔑 Admin: password set (${adminPassword.length} chars)`);
  if (IS_CLOUD) {
    console.log('   ☁️  Cloud mode (no tunnel needed)');
  } else {
    console.log(`   🎧 Listen:    http://localhost:${PORT}`);
    console.log(`   🎙️  Broadcast: http://localhost:${PORT}/broadcaster`);
    startTunnel();
  }
  console.log('');
});

module.exports = { server, io };
