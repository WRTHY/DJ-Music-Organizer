import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './registerIpc';

// `electron-vite dev` sets this so the window can point at the Vite dev
// server (with HMR) instead of a built file. It's unset in a production
// build, which is what selects the loadFile() branch below.
const devServerUrl = process.env.ELECTRON_RENDERER_URL;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    webPreferences: {
      // The security-critical trio: no direct Node access in the
      // renderer, an isolated JS context for the preload bridge, and the
      // preload script itself (compiled alongside main by electron-vite).
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  registerIpc(window);

  window.once('ready-to-show', () => window.show());

  // Anything the app tries to open as a new window (e.g. a target="_blank"
  // link) opens in the OS browser instead of another Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // macOS convention: clicking the dock icon with no windows open
    // should reopen one rather than relaunching the app.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Windows/Linux convention: closing the last window quits the app.
  // macOS apps conventionally stay running in the dock (process.platform
  // !== 'darwin' guards that), but James is on Windows, so this matches
  // what he'll actually see day to day.
  if (process.platform !== 'darwin') app.quit();
});
