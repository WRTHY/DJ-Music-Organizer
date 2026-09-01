import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, MloApi } from '../shared/ipcContract';

/**
 * The renderer's entire view of the outside world. `contextIsolation:
 * true` means the renderer's JS and this script's JS run in separate
 * contexts even though they share a window — the only thing that crosses
 * between them is whatever we explicitly attach here via
 * contextBridge.exposeInMainWorld. The renderer gets `window.mlo.scan(...)`,
 * never `window.require('electron')` or raw `ipcRenderer` — it cannot
 * invoke a channel we didn't define below, no matter what code runs in
 * the page.
 */
const api: MloApi = {
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectFolder),
  detectSeratoSource: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.detectSeratoSource, rootPath),
  scanFolderTree: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.scanFolderTree, rootPath),
  scanCrateDatabase: (args) => ipcRenderer.invoke(IPC_CHANNELS.scanCrateDatabase, args),
  planOrganize: (args) => ipcRenderer.invoke(IPC_CHANNELS.planOrganize, args),
  executeOrganize: (args) => ipcRenderer.invoke(IPC_CHANNELS.executeOrganize, args),
};

contextBridge.exposeInMainWorld('mlo', api);
