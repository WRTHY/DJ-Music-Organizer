import {
  detectSourceType,
  executePlan,
  filterTreeBySelection,
  planFromCanonicalTree,
  readCrateDatabase,
  readFolderTree,
  type ScanProgressCallback,
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

// `onProgress` is plumbed through as a plain optional callback -- same
// dependency-injection shape as everything else here. registerIpc.ts is
// the only place that ever supplies one for real (a closure that calls
// event.sender.send(...)); tests can pass a mock and assert on it with no
// Electron involved at all.
export async function scanFolderTree(rootPath: string, onProgress?: ScanProgressCallback) {
  return readFolderTree(rootPath, onProgress);
}

export async function scanCrateDatabase(args: ScanCrateDatabaseArgs, onProgress?: ScanProgressCallback) {
  return readCrateDatabase(args.subcratesDir, { volumeRoot: args.volumeRoot }, onProgress);
}

export async function planOrganize(args: PlanOrganizeArgs) {
  // Takes the tree the renderer already scanned (folder-tree or
  // crate-database — plan doesn't care which) rather than re-scanning a
  // path itself. The old Express version re-read rootPath here and only
  // ever used the folder-tree reader, which meant crate-mode scans could
  // never actually be planned. Fixed while porting.
  //
  // excludedKeys, when present, is applied here rather than trusted from
  // the renderer as a pre-filtered tree -- keeps the actual filtering
  // logic in one tested place (core), with the renderer only ever
  // managing which keys are checked/unchecked.
  const tree =
    args.excludedKeys && args.excludedKeys.length > 0
      ? filterTreeBySelection(args.tree, new Set(args.excludedKeys))
      : args.tree;
  return planFromCanonicalTree(tree, args.targetRoot, args.mode);
}

export async function executeOrganize(args: ExecuteOrganizeArgs) {
  return executePlan(args.plan, { dryRun: args.dryRun });
}
