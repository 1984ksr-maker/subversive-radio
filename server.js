const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

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

// Pages
app.get('/broadcaster', (req, res) => {
  res.sendFile(path.join(__dirname, 'broadcaster.html'));
});

app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

app.get('/download/mac', (req, res) => {
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
  res.json({ ...stationInfo, tunnelUrl, listenerCount: getListenerCount() });
});

app.get('/api/transmissions', (req, res) => {
  res.json(transmissions.map(t => ({
    id: t.id, title: t.title, duration: t.duration,
    createdAt: t.createdAt, played: t.played
  })));
});

app.post('/api/transmissions', (req, res) => {
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
