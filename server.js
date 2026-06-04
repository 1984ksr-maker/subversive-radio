const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Use environment port (cloud hosting) or default 3333 (local)
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// Broadcaster page
app.get('/broadcaster', (req, res) => {
  res.sendFile(path.join(__dirname, 'broadcaster.html'));
});

// Download page
app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// Serve the DMG file
app.get('/download/mac', (req, res) => {
  const dmgPath = path.join(__dirname, 'dist', 'Subversive Radio-1.0.0-arm64.dmg');
  const fs = require('fs');
  if (fs.existsSync(dmgPath)) {
    res.download(dmgPath, 'Subversive-Radio-Installer.dmg');
  } else {
    res.status(404).send('DMG not available. Build with: npm run build-dmg');
  }
});

// Health check for hosting platforms
app.get('/health', (req, res) => {
  res.json({ status: 'ok', live: stationInfo.isLive, listeners: getListenerCount() });
});

// API
app.get('/api/station', (req, res) => {
  res.json({ ...stationInfo, tunnelUrl, listenerCount: getListenerCount() });
});

app.get('/api/transmissions', (req, res) => {
  res.json(transmissions.map(t => ({
    id: t.id,
    title: t.title,
    duration: t.duration,
    createdAt: t.createdAt,
    played: t.played
  })));
});

app.post('/api/transmissions', (req, res) => {
  const { title, audioData, duration } = req.body;
  const transmission = {
    id: uuidv4(),
    title: title || `Transmission #${transmissions.length + 1}`,
    audioData,
    duration,
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

// Socket.IO
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('join-broadcaster', () => {
    socket.join('broadcaster');
    console.log('Broadcaster connected');
    socket.emit('listener-count', getListenerCount());
    if (tunnelUrl) socket.emit('tunnel-url', tunnelUrl);
  });

  socket.on('join-listener', () => {
    socket.join('listeners');
    const count = getListenerCount();
    console.log(`Listener joined. Total: ${count}`);
    io.to('broadcaster').emit('listener-count', count);
    socket.emit('station-info', stationInfo);
  });

  socket.on('audio-stream', (data) => {
    socket.to('listeners').emit('audio-stream', data);
  });

  socket.on('go-live', (info) => {
    stationInfo.isLive = true;
    if (info) {
      stationInfo.name = info.name || stationInfo.name;
      stationInfo.tagline = info.tagline || stationInfo.tagline;
    }
    io.to('listeners').emit('station-live', stationInfo);
    console.log('STATION IS LIVE');
  });

  socket.on('go-offline', () => {
    stationInfo.isLive = false;
    stationInfo.currentTransmission = null;
    io.to('listeners').emit('station-offline');
    console.log('Station went offline');
  });

  socket.on('play-transmission', (id) => {
    const t = transmissions.find(tr => tr.id === id);
    if (t) {
      t.played++;
      stationInfo.currentTransmission = t.title;
      io.to('listeners').emit('transmission-start', {
        title: t.title,
        audioData: t.audioData,
        duration: t.duration
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

  socket.on('disconnect', () => {
    if (socket.rooms.has('listeners')) {
      const count = getListenerCount();
      io.to('broadcaster').emit('listener-count', count);
    }
    if (socket.rooms.has('broadcaster')) {
      stationInfo.isLive = false;
      io.to('listeners').emit('station-offline');
    }
  });
});

function startTunnel() {
  const fs = require('fs');
  // Look for cloudflared in the project folder, or in /tmp, or in PATH
  const localBin = path.join(__dirname, 'cloudflared');
  const tmpBin = '/tmp/cloudflared';
  let cfPath = null;

  if (fs.existsSync(localBin)) cfPath = localBin;
  else if (fs.existsSync(tmpBin)) cfPath = tmpBin;
  else {
    console.log('⚠️  cloudflared not found — no public link. Place cloudflared binary in the app folder.');
    return;
  }

  console.log('🔗 Opening tunnel for public broadcast link...');

  const cf = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  function checkOutput(data) {
    const output = data.toString();
    const match = output.match(urlRegex);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      console.log(`\n🔴 YOUR BROADCAST LINK: ${tunnelUrl}`);
      console.log(`🎙️  Broadcaster:         ${tunnelUrl}/broadcaster\n`);
      io.to('broadcaster').emit('tunnel-url', tunnelUrl);
    }
  }

  cf.stdout.on('data', checkOutput);
  cf.stderr.on('data', checkOutput);

  cf.on('close', (code) => {
    console.log('Tunnel closed. Restarting in 3s...');
    tunnelUrl = null;
    setTimeout(startTunnel, 3000);
  });

  cf.on('error', (err) => {
    console.error('Tunnel error:', err.message);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📡 Subversive Radio server running on port ${PORT}`);
  if (IS_CLOUD) {
    console.log('☁️  Running in cloud mode');
  } else {
    console.log(`🎧 Local listener:    http://localhost:${PORT}`);
    console.log(`🎙️  Local broadcaster: http://localhost:${PORT}/broadcaster`);
    startTunnel();
  }
  console.log('');
});

module.exports = { server, io };
