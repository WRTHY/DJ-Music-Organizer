import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, MloApi, ScanProgress } from '../shared/ipcContract';

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
  onScanProgress: (callback) => {
    // ipcRenderer itself is never exposed to the renderer (that's the
    // whole point of contextIsolation) -- this wraps subscribe/unsubscribe
    // so the renderer only ever sees a plain callback-in, cleanup-out API.
    const listener = (_event: IpcRendererEvent, progress: ScanProgress) => callback(progress);
    ipcRenderer.on(IPC_CHANNELS.scanProgress, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.scanProgress, listener);
  },
  planOrganize: (args) => ipcRenderer.invoke(IPC_CHANNELS.planOrganize, args),
  executeOrganize: (args) => ipcRenderer.invoke(IPC_CHANNELS.executeOrganize, args),
  diffBurn: (args) => ipcRenderer.invoke(IPC_CHANNELS.diffBurn, args),
  burn: (args) => ipcRenderer.invoke(IPC_CHANNELS.burn, args),
};

contextBridge.exposeInMainWorld('mlo', api);
