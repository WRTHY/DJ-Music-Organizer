import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipcContract';
import type {
  ExecuteOrganizeArgs,
  PlanOrganizeArgs,
  ScanCrateDatabaseArgs,
} from '../shared/ipcContract';
import * as handlers from './ipcHandlers';

/**
 * The only file that imports both Electron (`ipcMain`) and the plain
 * handler functions. Deliberately thin: each entry validates nothing
 * beyond what TypeScript already gives us and just forwards to a handler,
 * so there's exactly one place to look when a channel's wiring is wrong.
 */
export function registerIpc(window: BrowserWindow): void {
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

  ipcMain.handle(IPC_CHANNELS.scanFolderTree, async (_event, rootPath: string) => {
    return handlers.scanFolderTree(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.scanCrateDatabase, async (_event, args: ScanCrateDatabaseArgs) => {
    return handlers.scanCrateDatabase(args);
  });

  ipcMain.handle(IPC_CHANNELS.planOrganize, async (_event, args: PlanOrganizeArgs) => {
    return handlers.planOrganize(args);
  });

  ipcMain.handle(IPC_CHANNELS.executeOrganize, async (_event, args: ExecuteOrganizeArgs) => {
    return handlers.executeOrganize(args);
  });
}
