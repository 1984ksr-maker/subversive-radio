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

// ========== PASSWORD PROTECTION ==========
let broadcasterPassword = process.env.BROADCASTER_PASSWORD || '123456';
const activeSessions = new Map(); // token → expiry timestamp

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isAuthenticated(req) {
  const token = req.query.token || req.headers['x-auth-token'];
  // Check cookie
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const cookieToken = cookies['br_token'];
  const t = token || cookieToken;
  if (!t) return false;
  const session = activeSessions.get(t);
  if (!session) return false;
  if (Date.now() > session.expiry) {
    activeSessions.delete(t);
    return false;
  }
  return true;
}

// Login page HTML
function loginPageHTML(error = '', redirectTo = '/broadcaster') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subversive Radio — Access</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --red: #ff2d2d; --red-glow: rgba(255,45,45,0.4); --green: #00ff88; --bg: #0a0a0a; --surface: #141414; --surface2: #1e1e1e; --text: #e0e0e0; --text-dim: #666; }
    body { font-family: 'SF Mono','Fira Code','Courier New',monospace; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: var(--surface); border: 1px solid #222; border-radius: 16px; padding: 48px 36px; width: 100%; max-width: 400px; margin: 20px; text-align: center; }
    .logo { font-size: 22px; font-weight: bold; letter-spacing: 5px; text-transform: uppercase; color: var(--red); margin-bottom: 8px; }
    .subtitle { font-size: 11px; color: var(--text-dim); letter-spacing: 2px; margin-bottom: 32px; }
    .lock-icon { font-size: 40px; margin-bottom: 20px; }
    .input-group { margin-bottom: 20px; }
    .input-group input { width: 100%; padding: 14px 16px; background: var(--bg); border: 1px solid #333; border-radius: 8px; color: var(--text); font-family: inherit; font-size: 14px; letter-spacing: 2px; text-align: center; outline: none; transition: border-color 0.2s; }
    .input-group input:focus { border-color: var(--red); }
    .input-group input::placeholder { color: #444; letter-spacing: 1px; }
    .submit-btn { width: 100%; padding: 14px; border: 2px solid var(--red); border-radius: 8px; background: rgba(255,45,45,0.1); color: var(--red); font-family: inherit; font-size: 13px; font-weight: bold; letter-spacing: 3px; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
    .submit-btn:hover { background: var(--red); color: #fff; box-shadow: 0 0 30px var(--red-glow); }
    .error { color: #ff4444; font-size: 11px; margin-bottom: 16px; padding: 10px; border: 1px solid #ff4444; border-radius: 6px; background: rgba(255,68,68,0.1); display: ${error ? 'block' : 'none'}; }
    .back-link { display: inline-block; margin-top: 20px; color: var(--text-dim); font-size: 10px; text-decoration: none; letter-spacing: 1px; }
    .back-link:hover { color: var(--text); }
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
      <div class="input-group">
        <input type="password" name="password" placeholder="Enter password" autofocus required>
      </div>
      <button type="submit" class="submit-btn">Enter</button>
    </form>
    <a href="/" class="back-link">← Back to radio</a>
  </div>
</body>
</html>`;
}

// ========== END PASSWORD ==========

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

// Login POST
app.post('/auth/login', (req, res) => {
  const { password, redirect } = req.body;
  const redirectTo = redirect || '/broadcaster';

  if (password === broadcasterPassword) {
    const token = generateToken();
    // Session lasts 24 hours
    activeSessions.set(token, { expiry: Date.now() + 24 * 60 * 60 * 1000 });
    res.setHeader('Set-Cookie', `br_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.redirect(redirectTo);
  } else {
    res.send(loginPageHTML('Wrong password. Try again.', redirectTo));
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  if (cookies.br_token) activeSessions.delete(cookies.br_token);
  res.setHeader('Set-Cookie', 'br_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// Change password API
app.post('/api/change-password', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  if (currentPassword !== broadcasterPassword) {
    return res.status(403).json({ error: 'Current password is wrong' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  broadcasterPassword = newPassword;
  // Invalidate all sessions so everyone re-logs with new password
  activeSessions.clear();
  const token = generateToken();
  activeSessions.set(token, { expiry: Date.now() + 24 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `br_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true, message: 'Password changed' });
});

// ========== PROTECTED PAGES ==========

app.get('/broadcaster', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect('/auth/login?redirect=/broadcaster');
  }
  res.sendFile(path.join(__dirname, 'broadcaster.html'));
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

function getListenerCount() {
  const listeners = io.sockets.adapter.rooms.get('listeners');
  return listeners ? listeners.size : 0;
}

// ========== SOCKET.IO — OPTIMIZED FOR 100+ LISTENERS ==========

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  // BROADCASTER
  socket.on('join-broadcaster', () => {
    socket.join('broadcaster');
    console.log('🎙️  Broadcaster connected');
    socket.emit('listener-count', getListenerCount());
    if (tunnelUrl) socket.emit('tunnel-url', tunnelUrl);
  });

  // LISTENER
  socket.on('join-listener', () => {
    socket.join('listeners');
    const count = getListenerCount();
    console.log(`👤 Listener joined (${count} total)`);
    io.to('broadcaster').emit('listener-count', count);
    socket.emit('station-info', stationInfo);
  });

  // AUDIO STREAM — uses volatile emit to DROP packets instead of queuing
  // This prevents memory buildup when listeners have slow connections
  socket.on('audio-stream', (data) => {
    io.to('listeners').volatile.emit('audio-stream', data);
  });

  // STATION CONTROLS
  socket.on('go-live', (info) => {
    stationInfo.isLive = true;
    if (info) {
      stationInfo.name = info.name || stationInfo.name;
      stationInfo.tagline = info.tagline || stationInfo.tagline;
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

  socket.on('disconnect', (reason) => {
    if (socket.rooms.has('listeners') || !socket.rooms.has('broadcaster')) {
      const count = getListenerCount();
      io.to('broadcaster').emit('listener-count', count);
    }
    if (socket.rooms.has('broadcaster')) {
      stationInfo.isLive = false;
      io.to('listeners').emit('station-offline');
      console.log('🎙️  Broadcaster disconnected');
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
      tunnelUrl = match[0];
      console.log(`\n🔴 BROADCAST: ${tunnelUrl}`);
      console.log(`🎙️  STUDIO:    ${tunnelUrl}/broadcaster\n`);
      io.to('broadcaster').emit('tunnel-url', tunnelUrl);
    }
  }
  cf.stdout.on('data', checkOutput);
  cf.stderr.on('data', checkOutput);
  cf.on('close', () => { tunnelUrl = null; setTimeout(startTunnel, 3000); });
  cf.on('error', (err) => console.error('Tunnel error:', err.message));
}

// ========== START ==========
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 Subversive Radio v1.0 — optimized for 100+ listeners`);
  console.log(`   Port: ${PORT}`);
  console.log(`   🔒 Broadcaster password: ${broadcasterPassword}`);
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
