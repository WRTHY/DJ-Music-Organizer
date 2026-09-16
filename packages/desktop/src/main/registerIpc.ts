import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { resolveDefaultPythonInvocation, type RekordboxWriteOptions } from '@mlo/core';
import { IPC_CHANNELS } from '../shared/ipcContract';
import type {
  BurnArgs,
  BurnExecuteArgs,
  BurnProgress,
  BurnRekordboxArgs,
  ExecuteOrganizeArgs,
  PlanOrganizeArgs,
  RekordboxBurnProgress,
  ScanCrateDatabaseArgs,
  ScanProgress,
} from '../shared/ipcContract';
import * as handlers from './ipcHandlers';

/**
 * The only file that imports both Electron (`ipcMain`) and the plain
 * handler functions. Deliberately thin: each entry validates nothing
 * beyond what TypeScript already gives us and just forwards to a handler,
 * so there's exactly one place to look when a channel's wiring is wrong.
 */
export function registerIpc(window: BrowserWindow): void {
  // Where the Phase 3 content-hash cache lives -- Electron's per-user
  // app-data folder, the standard place for exactly this kind of local,
  // regenerable cache (see docs/decisions.md, "Phase 3 design", for why
  // it's a plain JSON file rather than something heavier). Computed once
  // here rather than inside ipcHandlers.ts specifically so that file stays
  // free of any Electron import -- see its module doc.
  const trackIndexStorePath = path.join(app.getPath('userData'), 'track-index.json');

  // Real per-platform Python invocation for the Rekordbox burn (Phase 5,
  // docs/decisions.md 2026-09-16 finding): resolved once, here, from the
  // real `process.platform` this app is actually running on -- same
  // dependency-injection shape as trackIndexStorePath above and
  // DEFAULT_SOURCE_DATABASE_V2 on the Serato burn, kept out of
  // ipcHandlers.ts so that file stays free of any platform-detection
  // logic a test would have to account for.
  const rekordboxWriterOptions: RekordboxWriteOptions = (() => {
    const { executable, args } = resolveDefaultPythonInvocation(process.platform);
    return { pythonExecutable: executable, pythonArgs: args };
  })();

  ipcMain.handle(IPC_CHANNELS.selectFolder, async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.detectSeratoSource, async (_event, rootPath: string) => {
    return handlers.detectSeratoSource(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.scanFolderTree, async (event, rootPath: string) => {
    // Forwards progress as it happens via event.sender.send -- a push,
    // separate from this handler's own return value, which is how
    // request/response IPC (invoke/handle) gets mid-call progress at all.
    return handlers.scanFolderTree(rootPath, (progress: ScanProgress) => {
      event.sender.send(IPC_CHANNELS.scanProgress, progress);
    });
  });

  ipcMain.handle(IPC_CHANNELS.scanCrateDatabase, async (event, args: ScanCrateDatabaseArgs) => {
    return handlers.scanCrateDatabase(args, (progress: ScanProgress) => {
      event.sender.send(IPC_CHANNELS.scanProgress, progress);
    });
  });

  ipcMain.handle(IPC_CHANNELS.planOrganize, async (_event, args: PlanOrganizeArgs) => {
    return handlers.planOrganize(args);
  });

  ipcMain.handle(IPC_CHANNELS.executeOrganize, async (_event, args: ExecuteOrganizeArgs) => {
    return handlers.executeOrganize(args);
  });

  ipcMain.handle(IPC_CHANNELS.diffBurn, async (event, args: BurnArgs) => {
    return handlers.diffBurn(args, trackIndexStorePath, (progress: BurnProgress) => {
      event.sender.send(IPC_CHANNELS.burnProgress, progress);
    });
  });

  ipcMain.handle(IPC_CHANNELS.burn, async (event, args: BurnExecuteArgs) => {
    return handlers.burn(args, trackIndexStorePath, undefined, (progress: BurnProgress) => {
      event.sender.send(IPC_CHANNELS.burnProgress, progress);
    });
  });

  ipcMain.handle(IPC_CHANNELS.burnRekordbox, async (event, args: BurnRekordboxArgs) => {
    return handlers.burnRekordbox(args, trackIndexStorePath, rekordboxWriterOptions, (progress: RekordboxBurnProgress) => {
      event.sender.send(IPC_CHANNELS.burnRekordboxProgress, progress);
    });
  });
}
