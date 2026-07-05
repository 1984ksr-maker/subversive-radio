const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// OPTIMIZED for 100+ concurrent listeners
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
  // Stable connection settings
  pingTimeout: 120000,        // 2 min before considering disconnected
  pingInterval: 15000,        // check every 15s
  connectTimeout: 30000,      // 30s to connect
  // Transport optimization
  transports: ['websocket', 'polling'], // prefer websocket, fallback to polling
  allowUpgrades: true,
  perMessageDeflate: false,   // disable compression for audio (already compressed)
  httpCompression: false,
  // Memory optimization for many listeners
  serveClient: true,
  cookie: false
});

const PORT = process.env.PORT || 3333;
const IS_CLOUD = !!process.env.RENDER || !!process.env.RAILWAY_STATIC_URL || !!process.env.FLY_APP_NAME;
let tunnelUrl = null;

// ========== AUTH & ADMIN SYSTEM ==========
let adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const activeSessions = new Map(); // token → { expiry, role, label }
const accessCodes = new Map();    // code → { label, createdAt, usedBy, maxUses, uses, expiresAt }

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

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

function isAuthenticated(req) {
  return !!getSession(req);
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function isAdmin(req) {
  const s = getSession(req);
  return s && s.role === 'admin';
}

// Login page HTML — supports access code and admin login
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

let stationInfo = {
  name: 'SUBVERSIVE RADIO',
  tagline: 'Broadcasting from the underground',
  isLive: false,
  listenerCount: 0,
  currentTransmission: null
};

let transmissions = [];

// Serve static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== AUTH ROUTES ==========

// Login page
app.get('/auth/login', (req, res) => {
  const redirect = req.query.redirect || '/broadcaster';
  res.send(loginPageHTML('', redirect));
});

// Login POST — handles both access code and admin login
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
    if (!entry) {
      return res.send(loginPageHTML('Invalid access code.', redirectTo));
    }
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      return res.send(loginPageHTML('This code has expired.', redirectTo));
    }
    if (entry.maxUses && entry.uses >= entry.maxUses) {
      return res.send(loginPageHTML('This code has reached its use limit.', redirectTo));
    }
    entry.uses++;
    entry.lastUsed = new Date().toISOString();
    const token = generateToken();
    activeSessions.set(token, { expiry: Date.now() + 24 * 60 * 60 * 1000, role: 'user', label: entry.label || upperCode });
    res.setHeader('Set-Cookie', `br_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.redirect(redirectTo);
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.br_token) activeSessions.delete(cookies.br_token);
  res.setHeader('Set-Cookie', 'br_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// Change admin password (admin only)
app.post('/api/change-password', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== adminPassword) {
    return res.status(403).json({ error: 'Current password is wrong' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  adminPassword = newPassword;
  res.json({ ok: true, message: 'Admin password changed' });
});

// ========== ADMIN API ==========

// Create access code
app.post('/api/admin/codes', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { label, maxUses, expiresIn } = req.body;
  const code = generateCode();
  accessCodes.set(code, {
    label: label || 'Guest',
    createdAt: new Date().toISOString(),
    maxUses: maxUses || 0,
    uses: 0,
    expiresAt: expiresIn ? Date.now() + expiresIn * 60 * 60 * 1000 : null,
    lastUsed: null
  });
  res.json({ ok: true, code });
});

// List access codes
app.get('/api/admin/codes', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const codes = [];
  for (const [code, info] of accessCodes) {
    codes.push({ code, ...info, expired: info.expiresAt ? Date.now() > info.expiresAt : false });
  }
  res.json(codes);
});

// Delete access code
app.delete('/api/admin/codes/:code', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  accessCodes.delete(req.params.code.toUpperCase());
  res.json({ ok: true });
});

// List active sessions
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

// Revoke all non-admin sessions
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

// ========== PROTECTED PAGES ==========

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/auth/login?redirect=/admin');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/broadcaster', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/auth/login?redirect=/broadcaster');
  }
  res.sendFile(path.join(__dirname, 'broadcaster.html'));
});

app.get('/cohost', (req, res) => {
  if (!cohostAccessOpen) {
    return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Co-Host — Subversive Radio</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}.msg{max-width:320px}.msg h1{font-size:14px;letter-spacing:3px;color:#ff3333;margin-bottom:16px}.msg p{font-size:13px;color:#666;line-height:1.6}</style></head><body><div class="msg"><h1>CO-HOST ACCESS CLOSED</h1><p>The host hasn't opened co-host access yet. Ask them to enable it from the broadcaster panel.</p></div></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'cohost.html'));
});

app.get('/download', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/auth/login?redirect=/download');
  }
  res.sendFile(path.join(__dirname, 'download.html'));
});

app.get('/download/mac', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).send('Unauthorized');
  const dmgPath = path.join(__dirname, 'dist', 'Subversive Radio-1.0.0-arm64.dmg');
  const fs = require('fs');
  if (fs.existsSync(dmgPath)) {
    res.download(dmgPath, 'Subversive-Radio-Installer.dmg');
  } else {
    res.status(404).send('DMG not available');
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    live: stationInfo.isLive,
    listeners: getListenerCount(),
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// API
app.get('/api/station', (req, res) => {
  // On cloud, use the request host as the broadcast URL
  const broadcastUrl = tunnelUrl || (IS_CLOUD ? `${req.protocol}://${req.get('host')}` : null);
  res.json({ ...stationInfo, tunnelUrl: broadcastUrl, listenerCount: getListenerCount() });
});

app.get('/api/transmissions', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(transmissions.map(t => ({
    id: t.id, title: t.title, duration: t.duration,
    createdAt: t.createdAt, played: t.played
  })));
});

app.post('/api/transmissions', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { title, audioData, duration } = req.body;
  if (!audioData || typeof audioData !== 'string') return res.status(400).json({ error: 'Missing audio data' });
  if (audioData.length > 40 * 1024 * 1024) return res.status(413).json({ error: 'Transmission too large (max 30MB)' });
  const transmission = {
    id: uuidv4(),
    title: title || `Transmission #${transmissions.length + 1}`,
    audioData, duration,
    createdAt: new Date().toISOString(),
    played: 0
  };
  transmissions.push(transmission);
  io.to('broadcaster').emit('transmissions-updated', transmissions.length);
  res.json({ id: transmission.id });
});

app.delete('/api/transmissions/:id', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  transmissions = transmissions.filter(t => t.id !== req.params.id);
  res.json({ ok: true });
});

// Audio stream proxy — bypasses CORS for radio streams
app.get('/api/stream-proxy', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  const streamUrl = req.query.url;
  if (!streamUrl || !streamUrl.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

  const proto = streamUrl.startsWith('https') ? require('https') : require('http');
  const request = proto.get(streamUrl, { headers: { 'User-Agent': 'SubversiveRadio/1.0' } }, (upstream) => {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      return res.redirect('/api/stream-proxy?url=' + encodeURIComponent(upstream.headers.location));
    }
    if (upstream.statusCode !== 200) {
      return res.status(502).json({ error: 'Stream returned ' + upstream.statusCode });
    }
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.pipe(res);
    req.on('close', () => upstream.destroy());
  });
  request.on('error', (e) => {
    if (!res.headersSent) res.status(502).json({ error: 'Stream unreachable' });
  });
  request.setTimeout(10000, () => {
    request.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Stream timeout' });
  });
});

// Embeddable mini player
app.get('/embed', (req, res) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', '');
  res.send(embedPlayerHTML(req));
});

function embedPlayerHTML(req) {
  const host = `${req.protocol}://${req.get('host')}`;
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
let socket,audioContext,gainNode,isListening=false,nextPlayTime=0,activeSources=[],isLive=false;

fetch(SERVER+'/api/station').then(r=>r.json()).then(d=>{
  document.getElementById('stName').textContent=d.name||'SUBVERSIVE RADIO';
  document.getElementById('stTag').textContent=d.tagline||'';
  if(d.isLive){isLive=true;goLive();}
  if(d.listenerCount)document.getElementById('lCount').textContent=d.listenerCount+' listening';
}).catch(()=>{});

socket=io(SERVER,{transports:['websocket','polling']});
socket.on('connect',()=>{socket.emit('join-listener');});
socket.on('station-live',d=>{isLive=true;goLive();});
socket.on('station-off',()=>{isLive=false;goOff();if(isListening)toggle();});
socket.on('listener-count',c=>{document.getElementById('lCount').textContent=c>0?c+' listening':'';});
socket.on('audio-chunk',(buf)=>{if(!isListening||!audioContext)return;try{audioContext.decodeAudioData(buf.slice(0),(decoded)=>{const src=audioContext.createBufferSource();src.buffer=decoded;src.connect(gainNode);const now=audioContext.currentTime;if(nextPlayTime<now)nextPlayTime=now+0.05;src.start(nextPlayTime);activeSources.push(src);src.onended=()=>{activeSources=activeSources.filter(s=>s!==src);};nextPlayTime+=decoded.duration;});} catch(e){}});

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
    audioContext=new(window.AudioContext||window.webkitAudioContext)();
    gainNode=audioContext.createGain();gainNode.connect(audioContext.destination);
    isListening=true;nextPlayTime=0;
    btn.textContent='LISTENING';btn.classList.add('listening');
    document.getElementById('volRow').style.display='flex';
  }else{
    isListening=false;nextPlayTime=0;
    activeSources.forEach(s=>{try{s.stop();}catch(e){}});activeSources=[];
    if(audioContext){audioContext.close();audioContext=null;}
    btn.textContent='TUNE IN';btn.classList.remove('listening');
    document.getElementById('volRow').style.display='none';
  }
}
function setVol(v){if(gainNode)gainNode.gain.value=parseFloat(v);}
</script>
</body>
</html>`;
}

function getListenerCount() {
  const listeners = io.sockets.adapter.rooms.get('listeners');
  return listeners ? listeners.size : 0;
}

// ========== SOCKET.IO — OPTIMIZED FOR 100+ LISTENERS ==========
let broadcasterSocketId = null;
let cohostSocketId = null;
let cohostMicAllowed = false;
let cohostAccessOpen = false;
let cohostBuffer = null;
const mutedUsers = new Set();


io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  let isBroadcaster = false;
  let isCoHost = false;
  let isListener = false;

  // BROADCASTER
  socket.on('join-broadcaster', () => {
    socket.join('broadcaster');
    isBroadcaster = true;
    broadcasterSocketId = socket.id;
    console.log('🎙️  Broadcaster connected');
    socket.emit('listener-count', getListenerCount());
    if (tunnelUrl) socket.emit('tunnel-url', tunnelUrl);
  });

  // CO-HOST — remote mic controlled by host
  socket.on('join-cohost', (info) => {
    isCoHost = true;
    cohostSocketId = socket.id;
    cohostMicAllowed = false;
    const name = (info && info.name) ? info.name.slice(0, 20) : 'Co-Host';
    console.log('🎙️  Co-host connected:', name);
    socket.emit('listener-count', getListenerCount());
    socket.emit('station-info', stationInfo);
    socket.emit('cohost-mic-state', false);
    // Notify broadcaster directly (not via room, to avoid co-host receiving it)
    if (broadcasterSocketId) {
      io.to(broadcasterSocketId).emit('cohost-joined', { id: socket.id, name });
    }
  });

  socket.on('cohost-access-toggle', (open) => {
    if (!isBroadcaster) return;
    cohostAccessOpen = !!open;
    console.log('🎙️  Co-host access:', cohostAccessOpen ? 'OPEN' : 'CLOSED');
    if (!cohostAccessOpen && cohostSocketId) {
      io.to(cohostSocketId).emit('cohost-kicked');
      cohostSocketId = null;
      cohostMicAllowed = false;
      io.to(broadcasterSocketId).emit('cohost-left');
    }
  });

  socket.on('cohost-mic-toggle', (allowed) => {
    if (!isBroadcaster) return;
    cohostMicAllowed = !!allowed;
    if (cohostSocketId) {
      io.to(cohostSocketId).emit('cohost-mic-state', cohostMicAllowed);
    }
  });

  // LISTENER
  socket.on('join-listener', () => {
    socket.join('listeners');
    isListener = true;
    const count = getListenerCount();
    console.log(`👤 Listener joined (${count} total)`);
    io.to('broadcaster').emit('listener-count', count);
    socket.emit('station-info', stationInfo);
  });

  // AUDIO STREAM — co-host buffers, mixes into broadcaster's next chunk
  socket.on('audio-stream', (data) => {
    if (!isBroadcaster && !isCoHost) return;
    if (isCoHost && !cohostMicAllowed) return;

    if (isCoHost) {
      cohostBuffer = data;
      return;
    }

    // Broadcaster chunk — mix in co-host if buffered
    if (cohostBuffer && cohostMicAllowed) {
      const a = Buffer.isBuffer(data) ? new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2) : new Int16Array(data);
      const b = Buffer.isBuffer(cohostBuffer) ? new Int16Array(cohostBuffer.buffer, cohostBuffer.byteOffset, cohostBuffer.byteLength / 2) : new Int16Array(cohostBuffer);
      const len = Math.max(a.length, b.length);
      const out = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const mixed = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0);
        out[i] = Math.max(-32768, Math.min(32767, mixed));
      }
      cohostBuffer = null;
      io.to('listeners').volatile.emit('audio-stream', Buffer.from(out.buffer));
    } else {
      io.to('listeners').volatile.emit('audio-stream', data);
    }
  });

  // STATION CONTROLS
  socket.on('go-live', (info) => {
    stationInfo.isLive = true;
    if (info) {
      stationInfo.name = info.name || stationInfo.name;
      stationInfo.tagline = info.tagline || stationInfo.tagline;
      stationInfo.sampleRate = info.sampleRate || 44100;
    }
    io.to('listeners').emit('station-live', stationInfo);
    console.log(`🔴 LIVE: ${stationInfo.name} (${getListenerCount()} listeners)`);
  });

  socket.on('go-offline', () => {
    stationInfo.isLive = false;
    stationInfo.currentTransmission = null;
    io.to('listeners').emit('station-offline');
    console.log('⭕ Station offline');
  });

  socket.on('play-transmission', (id) => {
    const t = transmissions.find(tr => tr.id === id);
    if (t) {
      t.played++;
      stationInfo.currentTransmission = t.title;
      io.to('listeners').emit('transmission-start', {
        title: t.title, audioData: t.audioData, duration: t.duration
      });
      io.to('broadcaster').emit('transmission-playing', t.id);
    }
  });

  socket.on('transmission-ended', () => {
    stationInfo.currentTransmission = null;
    io.to('listeners').emit('transmission-end');
  });

  socket.on('update-station', (info) => {
    stationInfo.name = info.name || stationInfo.name;
    stationInfo.tagline = info.tagline || stationInfo.tagline;
    io.to('listeners').emit('station-info', stationInfo);
  });

  // LIVE CHAT
  socket.on('chat-message', (msg) => {
    if (!msg || !msg.text || typeof msg.text !== 'string') return;
    const text = msg.text.trim().slice(0, 500);
    if (!text) return;
    const from = (isBroadcaster || isCoHost) ? 'DJ' : (msg.name || 'Listener').slice(0, 20);
    if (mutedUsers.has(from)) return;
    const chatMsg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text,
      from,
      isDJ: isBroadcaster || isCoHost,
      time: new Date().toISOString()
    };
    io.to('listeners').emit('chat-message', chatMsg);
    io.to('broadcaster').emit('chat-message', chatMsg);
  });

  socket.on('chat-pin', (msgId) => {
    if (!isBroadcaster) return;
    io.to('listeners').emit('chat-pin', msgId);
  });

  socket.on('chat-delete', (msgId) => {
    if (!isBroadcaster) return;
    io.to('listeners').emit('chat-delete', msgId);
    io.to('broadcaster').emit('chat-delete', msgId);
  });

  socket.on('chat-mute', (userName) => {
    if (!isBroadcaster) return;
    mutedUsers.add(userName);
    io.to('broadcaster').emit('chat-muted', userName);
  });

  socket.on('chat-unmute', (userName) => {
    if (!isBroadcaster) return;
    mutedUsers.delete(userName);
    io.to('broadcaster').emit('chat-unmuted', userName);
  });

  socket.on('chat-clear', () => {
    if (!isBroadcaster) return;
    io.to('listeners').emit('chat-clear');
    io.to('broadcaster').emit('chat-clear');
  });

  socket.on('disconnect', (reason) => {
    if (isListener) {
      const count = getListenerCount();
      io.to('broadcaster').emit('listener-count', count);
    }
    if (isBroadcaster && broadcasterSocketId === socket.id) {
      stationInfo.isLive = false;
      broadcasterSocketId = null;
      io.to('listeners').emit('station-offline');
      console.log('🎙️  Broadcaster disconnected');
    }
    if (isCoHost && cohostSocketId === socket.id) {
      cohostSocketId = null;
      cohostMicAllowed = false;
      if (broadcasterSocketId) {
        io.to(broadcasterSocketId).emit('cohost-left');
      }
      console.log('🎙️  Co-host disconnected');
    }
  });

  // Handle connection errors gracefully
  socket.on('error', (err) => {
    console.error(`Socket error (${socket.id}):`, err.message);
  });
});

// ========== MEMORY CLEANUP ==========
// Clean up old transmissions to prevent memory leak (keep last 20)
setInterval(() => {
  if (transmissions.length > 20) {
    transmissions = transmissions.slice(-20);
    console.log('🧹 Cleaned old transmissions');
  }

  // Clean expired sessions
  for (const [token, session] of activeSessions) {
    if (Date.now() > session.expiry) activeSessions.delete(token);
  }

  // Log stats
  const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const listeners = getListenerCount();
  if (listeners > 0 || stationInfo.isLive) {
    console.log(`📊 Listeners: ${listeners} | Memory: ${mem}MB | Live: ${stationInfo.isLive}`);
  }
}, 60000);

// ========== TUNNEL ==========
let tunnelRetryDelay = 3000;
function startTunnel() {
  const fs = require('fs');
  const localBin = path.join(__dirname, 'cloudflared');
  const tmpBin = '/tmp/cloudflared';
  let cfPath = null;

  if (fs.existsSync(localBin)) cfPath = localBin;
  else if (fs.existsSync(tmpBin)) cfPath = tmpBin;
  else {
    console.log('⚠️  cloudflared not found — no public link');
    return;
  }

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
      io.to('broadcaster').emit('tunnel-url', tunnelUrl);
    }
  }
  cf.stdout.on('data', checkOutput);
  cf.stderr.on('data', checkOutput);
  cf.on('close', () => {
    tunnelUrl = null;
    tunnelRetryDelay = Math.min(tunnelRetryDelay * 2, 60000);
    setTimeout(startTunnel, tunnelRetryDelay);
  });
  cf.on('error', (err) => console.error('Tunnel error:', err.message));
}

// ========== START ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 Subversive Radio v1.0 — optimized for 100+ listeners`);
  console.log(`   Port: ${PORT}`);
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
