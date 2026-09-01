import react from '@vitejs/plugin-react';
import { externalizeDepsPlugin } from 'electron-vite';
import { defineConfig } from 'electron-vite';

// electron-vite builds three separate bundles from one config: main and
// preload are plain Node/Electron code (externalizeDepsPlugin keeps
// node_modules out of the bundle — no point inlining them into a Node
// process that can just require() them), renderer is a normal Vite/React
// app. `electron-vite dev` runs all three together with HMR for the
// renderer and auto-restart for main/preload changes.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
    plugins: [react()],
  },
});
