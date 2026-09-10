import {
  type CanonicalTree,
  JsonTrackIndexStore,
  burnToFlash,
  detectSourceType,
  diffAgainstDestination,
  executePlan,
  filterTreeBySelection,
  planFromCanonicalTree,
  readCrateDatabase,
  readFolderTree,
  summarizeDiff,
  type ScanProgressCallback,
} from '@mlo/core';
import type {
  BurnArgs,
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
 *
 * diffBurn/burn take a `storePath` parameter for the same reason: rather
 * than this file reaching into Electron's `app.getPath('userData')` to
 * find the track-index cache itself (which would mean importing Electron
 * here, breaking the whole point of this file), registerIpc.ts computes
 * that path once and passes it in -- same dependency-injection shape as
 * `onProgress` above. Each call loads a fresh `JsonTrackIndexStore` from
 * that path and saves it back at the end, rather than keeping one warm in
 * memory across calls; at personal-library scale that's cheap (see
 * docs/decisions.md, "Phase 3 design"), and it keeps this file free of
 * any hidden module-level state a test would have to know to reset.
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

// excludedKeys, when present, is applied here rather than trusted from
// the renderer as a pre-filtered tree -- keeps the actual filtering
// logic in one tested place (core), with the renderer only ever
// managing which keys are checked/unchecked. Shared by planOrganize and
// the two burn handlers below, since burning respects the same
// SelectionTree checkboxes as the ordinary copy flow rather than
// introducing a second selection concept.
function applySelection(tree: CanonicalTree, excludedKeys?: string[]): CanonicalTree {
  return excludedKeys && excludedKeys.length > 0
    ? filterTreeBySelection(tree, new Set(excludedKeys))
    : tree;
}

export async function planOrganize(args: PlanOrganizeArgs) {
  // Takes the tree the renderer already scanned (folder-tree or
  // crate-database — plan doesn't care which) rather than re-scanning a
  // path itself. The old Express version re-read rootPath here and only
  // ever used the folder-tree reader, which meant crate-mode scans could
  // never actually be planned. Fixed while porting.
  const tree = applySelection(args.tree, args.excludedKeys);
  return planFromCanonicalTree(tree, args.targetRoot, args.mode);
}

export async function executeOrganize(args: ExecuteOrganizeArgs) {
  return executePlan(args.plan, { dryRun: args.dryRun });
}

/**
 * Read-only preview for Phase 3's burn-to-flash (docs/roadmap.md): reports
 * what's new/unchanged/changed against `args.targetRoot` without copying
 * or writing anything there. Still hashes and caches via `storePath`
 * (loaded fresh and saved back at the end of every call, deliberately --
 * see the module doc below) -- a preview's hashing work isn't wasted, it
 * just means a burn run immediately afterward has a warm cache instead of
 * re-hashing files this call already touched.
 */
export async function diffBurn(args: BurnArgs, storePath: string) {
  const store = new JsonTrackIndexStore(storePath);
  await store.load();
  const tree = applySelection(args.tree, args.excludedKeys);
  const diff = await diffAgainstDestination(tree, args.targetRoot, store, args.mode ?? 'copy');
  await store.save();
  return summarizeDiff(diff);
}

/**
 * The real burn: copies whatever's new/changed onto `args.targetRoot`,
 * regenerates the full crate database there, and verifies the result by
 * reading it back. See @mlo/core's serato/burnToFlash.ts for the full
 * design -- this is a thin pass-through, same shape as every other
 * handler in this file.
 */
export async function burn(args: BurnArgs, storePath: string) {
  const store = new JsonTrackIndexStore(storePath);
  await store.load();
  const tree = applySelection(args.tree, args.excludedKeys);
  const report = await burnToFlash(tree, args.targetRoot, { store, mode: args.mode ?? 'copy' });
  await store.save();
  return report;
}
