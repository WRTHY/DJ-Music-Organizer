import path from 'node:path';
import fs from 'node:fs/promises';
import {
  type BurnProgressCallback,
  type CanonicalTree,
  type DatabaseV2Source,
  type RekordboxBurnProgressCallback,
  type RekordboxBurnReport,
  type RekordboxWriteOptions,
  JsonTrackIndexStore,
  burnToFlash,
  burnToRekordbox,
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
import {
  DEFAULT_SOURCE_DATABASE_V2,
  type BurnArgs,
  type BurnExecuteArgs,
  type BurnRekordboxArgs,
  type DetectSeratoSourceResult,
  type ExecuteOrganizeArgs,
  type PlanOrganizeArgs,
  type ScanCrateDatabaseArgs,
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
 *
 * `onProgress` -- same dependency-injection shape as scanFolderTree's
 * above -- is optional here for the same reason it's optional on
 * `diffAgainstDestination` itself: a caller (a test, or a future non-UI
 * consumer) that doesn't care about live progress shouldn't have to
 * supply a no-op callback just to call this function.
 */
export async function diffBurn(args: BurnArgs, storePath: string, onProgress?: BurnProgressCallback) {
  const store = new JsonTrackIndexStore(storePath);
  await store.load();
  const tree = applySelection(args.tree, args.excludedKeys);
  const diff = await diffAgainstDestination(tree, args.targetRoot, store, args.mode ?? 'copy', onProgress);
  await store.save();
  return summarizeDiff(diff);
}

/**
 * Resolves what `sourceDatabaseV2` a real burn should actually use
 * (Phase 3b UI wiring, docs/decisions.md 2026-09-14). Two different
 * trust levels on purpose:
 *
 * - An explicit value from the caller is passed through completely
 *   unchecked -- if it points at a file that doesn't exist, `burnToFlash`
 *   throws and the burn fails loudly. That's deliberate: an explicit
 *   path is a deliberate choice, and this project's whole posture is
 *   "fail loudly on a bad explicit input" (path-safety checks, the
 *   `database V2`-already-exists refusal, etc.) rather than silently
 *   doing something else instead.
 * - The default is a convenience, not a deliberate per-burn choice -- so
 *   it's only ever applied when that file actually exists. A burn on a
 *   machine without that exact backup path (a fresh checkout, this
 *   project's own test suite, or James's backup folder someday getting
 *   renamed/moved) should still complete normally with the ordinary
 *   minimal synthesis, never hard-fail just because a convenience
 *   default wasn't there.
 *
 * `defaultSource` is a parameter rather than reading
 * `DEFAULT_SOURCE_DATABASE_V2` directly here for the same reason
 * `storePath` is a parameter on `diffBurn`/`burn` rather than this file
 * computing it itself: it's real, environment-specific state (a real
 * path on James's actual machine), and hardcoding it into this function
 * would make its behavior depend on whatever machine happens to run the
 * test suite -- exactly the bug an earlier version of this test caught
 * for real (see `__tests__/ipcHandlers.test.ts`: it passed in this
 * session's Linux sandbox, where no `E:\` drive exists, and failed on
 * James's own machine, where the real backup does).
 */
async function resolveSourceDatabaseV2(
  explicit: DatabaseV2Source | undefined,
  defaultSource: DatabaseV2Source
): Promise<DatabaseV2Source | undefined> {
  if (explicit) return explicit;
  const defaultExists = await fs
    .access(defaultSource.filePath)
    .then(() => true)
    .catch(() => false);
  return defaultExists ? defaultSource : undefined;
}

/**
 * The real burn: copies whatever's new/changed onto `args.targetRoot`,
 * regenerates the full crate database there, and verifies the result by
 * reading it back. See @mlo/core's serato/burnToFlash.ts for the full
 * design -- this is a thin pass-through, same shape as every other
 * handler in this file, plus the sourceDatabaseV2 default-resolution
 * above.
 *
 * `defaultSourceDatabaseV2` defaults to the real
 * `DEFAULT_SOURCE_DATABASE_V2` constant so `registerIpc.ts` doesn't need
 * to pass anything -- but, like `storePath`, it's still a real parameter
 * a test can override with a controlled path instead of the real one.
 *
 * `onProgress` is threaded straight through to `burnToFlash` -- it fires
 * across every phase of the burn (diffing, copying, writing the crate
 * database, writing database V2, verifying), not just the copy step, so
 * it's accepted here rather than wrapped around just one sub-step.
 */
export async function burn(
  args: BurnExecuteArgs,
  storePath: string,
  defaultSourceDatabaseV2: DatabaseV2Source = DEFAULT_SOURCE_DATABASE_V2,
  onProgress?: BurnProgressCallback
) {
  const store = new JsonTrackIndexStore(storePath);
  await store.load();
  const tree = applySelection(args.tree, args.excludedKeys);
  const sourceDatabaseV2 = await resolveSourceDatabaseV2(args.sourceDatabaseV2, defaultSourceDatabaseV2);
  const report = await burnToFlash(tree, args.targetRoot, {
    store,
    mode: args.mode ?? 'copy',
    sourceDatabaseV2,
    onProgress,
  });
  await store.save();
  return report;
}

/**
 * Derives the real Rekordbox paths a device root implies, by the same
 * convention this project's reader has trusted since decision 21 and
 * real Rekordbox exports already use: `<deviceRoot>/PIONEER/rekordbox/
 * export.pdb` as the template, `deviceRoot` itself as the volume root.
 * `outputPath` is a sibling `.mlo-candidate` file, never `templatePath`
 * itself -- `writeRekordboxPdb` already refuses to touch its template,
 * this just keeps the candidate visibly separate and obviously-not-live
 * on disk too, so promoting it to be the drive's real export.pdb stays
 * the deliberate, separate, human-gated step decision 33 left it as.
 * Exported for the same reason `applySelection` above isn't: a test can
 * exercise this path convention on its own, without spinning up a real
 * burn.
 */
export function resolveRekordboxPaths(deviceRoot: string): {
  templatePath: string;
  outputPath: string;
  volumeRoot: string;
} {
  const rekordboxDir = path.join(deviceRoot, 'PIONEER', 'rekordbox');
  return {
    templatePath: path.join(rekordboxDir, 'export.pdb'),
    outputPath: path.join(rekordboxDir, 'export.pdb.mlo-candidate'),
    volumeRoot: deviceRoot,
  };
}

/**
 * Phase 5 (docs/roadmap.md): the Rekordbox counterpart to `burn` above.
 * No diff-only preview split -- see BurnRekordboxArgs's doc in
 * ipcContract.ts for why -- so this always performs the real write
 * (into a `.mlo-candidate` output, never the device's real export.pdb;
 * see resolveRekordboxPaths above). Shares the same `storePath`-backed
 * `TrackIndexStore` cache as the Serato burn handlers -- keyed by
 * absolute file path and content hash, so there's no correctness reason
 * to keep two separate caches for two burn targets.
 *
 * `writerOptions` carries the real per-platform Python invocation
 * (`registerIpc.ts` resolves it via @mlo/core's
 * `resolveDefaultPythonInvocation`, the same dependency-injection shape
 * as `defaultSourceDatabaseV2` on `burn` above) -- a plain parameter
 * here, not computed in this file, so a test can supply its own instead
 * of depending on whatever Python happens to be on the machine running
 * the suite.
 */
export async function burnRekordbox(
  args: BurnRekordboxArgs,
  storePath: string,
  writerOptions?: RekordboxWriteOptions,
  onProgress?: RekordboxBurnProgressCallback
): Promise<RekordboxBurnReport> {
  const store = new JsonTrackIndexStore(storePath);
  await store.load();
  const tree = applySelection(args.tree, args.excludedKeys);
  const { templatePath, outputPath, volumeRoot } = resolveRekordboxPaths(args.deviceRoot);
  const report = await burnToRekordbox(tree, {
    store,
    templatePath,
    outputPath,
    volumeRoot,
    writerOptions,
    onProgress,
  });
  await store.save();
  return report;
}
