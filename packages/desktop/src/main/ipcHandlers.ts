import {
  detectSourceType,
  executePlan,
  planFromCanonicalTree,
  readCrateDatabase,
  readFolderTree,
} from '@mlo/core';
import type {
  DetectSeratoSourceResult,
  ExecuteOrganizeArgs,
  PlanOrganizeArgs,
  ScanCrateDatabaseArgs,
} from '../shared/ipcContract';

/**
 * Plain, dependency-injected functions — no `ipcMain`/Electron import here
 * at all. This is what makes them testable with ordinary Jest (see
 * __tests__/ipcHandlers.test.ts): they're just async functions that call
 * into @mlo/core, identical in spirit to the Express route handlers this
 * replaced. registerIpc.ts is the only file that knows these are wired to
 * IPC channels.
 */

export async function detectSeratoSource(rootPath: string): Promise<DetectSeratoSourceResult> {
  return detectSourceType(rootPath);
}

export async function scanFolderTree(rootPath: string) {
  return readFolderTree(rootPath);
}

export async function scanCrateDatabase(args: ScanCrateDatabaseArgs) {
  return readCrateDatabase(args.subcratesDir, { volumeRoot: args.volumeRoot });
}

export async function planOrganize(args: PlanOrganizeArgs) {
  // Takes the tree the renderer already scanned (folder-tree or
  // crate-database — plan doesn't care which) rather than re-scanning a
  // path itself. The old Express version re-read rootPath here and only
  // ever used the folder-tree reader, which meant crate-mode scans could
  // never actually be planned. Fixed while porting.
  return planFromCanonicalTree(args.tree, args.targetRoot, args.mode);
}

export async function executeOrganize(args: ExecuteOrganizeArgs) {
  return executePlan(args.plan, { dryRun: args.dryRun });
}
