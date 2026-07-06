const { app, BrowserWindow, shell, session, powerSaveBlocker } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;
let sleepBlockerId = null;
const PORT = 3333;

function startServer() {
  return new Promise((resolve) => {
    serverProcess = fork(path.join(__dirname, 'server.js'), [], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    serverProcess.stdout.on('data', (data) => {
      console.log('[Server]', data.toString().trim());
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server]', data.toString().trim());
    });

    // Wait for server to be ready
    const check = setInterval(() => {
      const http = require('http');
      http.get(`http://localhost:${PORT}/health`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(check);
          resolve();
        }
      }).on('error', () => {});
    }, 300);

    // Timeout fallback
    setTimeout(() => { clearInterval(check); resolve(); }, 8000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 900,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    title: 'Subversive Radio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  // Auto-login: set the auth cookie so broadcaster loads without password prompt
  const cookie = {
    url: `http://localhost:${PORT}`,
    name: 'br_electron',
    value: 'subversive-local-bypass'
  };

  // Load the broadcaster through the local server
  mainWindow.loadURL(`http://localhost:${PORT}/broadcaster`);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  // Keep broadcasting through display sleep / app nap — audio capture dies
  // if macOS suspends the app, so block suspension for the app's lifetime.
  sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
