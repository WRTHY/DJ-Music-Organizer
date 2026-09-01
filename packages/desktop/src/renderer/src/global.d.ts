/// <reference types="vite/client" />

import type { MloApi } from '../../shared/ipcContract';

// Declares the shape of what the preload script attached via
// contextBridge.exposeInMainWorld('mlo', ...). This is the ONE place the
// renderer's type-checker learns that window.mlo exists — without it,
// `window.mlo.scanFolderTree(...)` would just be a type error.
declare global {
  interface Window {
    mlo: MloApi;
  }
}

export {};
