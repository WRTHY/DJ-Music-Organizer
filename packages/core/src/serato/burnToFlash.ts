import fs from 'node:fs/promises';
import path from 'node:path';
import { CanonicalTree, allTracks } from '../types';
import { TrackIndexStore } from '../trackIndex';
import {
  DiffSummary,
  OrganizeDiff,
  OrganizeMode,
  OrganizeReport,
  diffAgainstDestination,
  executePlan,
  planFromDiff,
  summarizeDiff,
  treeAtDestination,
} from '../organizer';
import { readCrateDatabase } from './crateDatabaseReader';
import { CrateWriteResult, writeCrateDatabase } from './crateDatabaseWriter';
import { DATABASE_V2_FILENAME, DatabaseV2WriteResult, writeDatabaseV2 } from './databaseV2Writer';
import { readRawDatabaseV2Records } from './databaseV2Reader';

export interface BurnOptions {
  store: TrackIndexStore;
  /** Defaults to 'copy' -- burning duplicates the library onto a target volume, it doesn't relocate the source. */
  mode?: OrganizeMode;
  /**
   * An already-analyzed `database V2` to carry per-track analysis-state
   * records forward from, so a fresh blank-drive burn doesn't force
   * Serato to re-analyze every track from scratch -- see
   * `DatabaseV2WriteOptions.sourceRecords`'s doc for the hardware
   * evidence behind why this matters (docs/decisions.md, 2026-09-14).
   *
   * Optional and deliberately explicit rather than inferred: this
   * project has observed at least two candidate files on James's own
   * machine (the live `E:\_Serato_\database V2` and the backup copy
   * under `E:\LIBRARY BACKUP 9_10_2026\_Serato_`), and guessing which one
   * is "the" source risks silently reading a stale one. When omitted,
   * `burnToFlash` falls back to the minimal `pfil`+`ttyp` synthesis for
   * every track, exactly as before this option existed.
   */
  sourceDatabaseV2?: {
    /** Path to the source `database V2` file. Read-only -- never modified. */
    filePath: string;
    /** volumeRoot the source file's own `pfil` paths resolve against (i.e. the parent of ITS `_Serato_`, not necessarily the burn destination's). */
    volumeRoot: string;
  };
}

export interface BurnVerification {
  /** The single flag a caller should gate "the burn actually worked" on. */
  ok: boolean;
  /** From reading the just-written crate database back: a crate references a track path that doesn't exist on disk. Should always be 0 -- anything else means a copy silently failed or didn't complete. */
  unresolvedCount: number;
  /** Track ids the canonical tree expects (anywhere) that the read-back crate database doesn't have anywhere. Should always be empty. */
  missingTrackIds: string[];
  /** Track ids the read-back crate database has (anywhere) that the canonical tree didn't expect anywhere. Should always be empty -- crates are always regenerated fully from the tree -- but checked rather than assumed. */
  unexpectedTrackIds: string[];
  /**
   * Track ids that exist in the read-back crate database, and exist in
   * the canonical tree too, but under a *different* crate than the tree
   * says they should be in. Should always be empty. Deliberately tracked
   * separately from missing/unexpected: a track silently reassigned from
   * one crate to another changes neither set (it's still present exactly
   * once, library-wide), so a flat "does this track id exist somewhere"
   * check -- which is all this used to compare -- cannot catch it. This
   * is exactly the "the burn looked fine but a folder was missing/wrong
   * once I got to the club" failure mode; see docs/decisions.md.
   */
  misplacedTrackIds: string[];
}

/**
 * Every track id found in `tree`, grouped by the crate path it lives
 * under (path segments joined with "/"). A track in more than one crate
 * appears under each of those paths -- same multi-membership behavior as
 * everywhere else in this codebase, not a bug.
 */
function trackIdsByPath(tree: CanonicalTree): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const { track, path: nodePath } of allTracks(tree)) {
    const key = nodePath.join('/');
    const set = byPath.get(key) ?? new Set<string>();
    set.add(track.id);
    byPath.set(key, set);
  }
  return byPath;
}

/**
 * Compares two trees track-by-track AND crate-by-crate -- not just "is
 * every expected track id present somewhere," which a track silently
 * moved to the wrong crate would still pass. Pure and filesystem-free
 * deliberately, so the placement-comparison logic itself can be unit
 * tested against hand-built trees without needing a real burn -- see
 * `__tests__/burnToFlash.test.ts`.
 */
export function diffTrackPlacement(
  expectedTree: CanonicalTree,
  actualTree: CanonicalTree
): Pick<BurnVerification, 'missingTrackIds' | 'unexpectedTrackIds' | 'misplacedTrackIds'> {
  const expectedByPath = trackIdsByPath(expectedTree);
  const actualByPath = trackIdsByPath(actualTree);

  const expectedIds = new Set([...expectedByPath.values()].flatMap((set) => [...set]));
  const actualIds = new Set([...actualByPath.values()].flatMap((set) => [...set]));

  const missingTrackIds = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpectedTrackIds = [...actualIds].filter((id) => !expectedIds.has(id));

  const misplacedTrackIds: string[] = [];
  for (const [pathKey, expectedSet] of expectedByPath) {
    const actualSet = actualByPath.get(pathKey) ?? new Set<string>();
    for (const id of expectedSet) {
      // Present in the library overall, just not under the crate this
      // path says it should be in -- distinct from missing entirely.
      if (actualIds.has(id) && !actualSet.has(id)) {
        misplacedTrackIds.push(id);
      }
    }
  }

  return { missingTrackIds, unexpectedTrackIds, misplacedTrackIds };
}

/**
 * What happened to the `database V2` file on this burn (Phase 3b,
 * docs/roadmap.md Deliverable 4). Deliberately kept separate from
 * `BurnVerification` above rather than folded into its `ok` flag -- that
 * flag is Phase 3's already-established trust gate (decisions 17-20,
 * 22, 24), and Phase 3b has its own, later hardware checkpoint
 * (Deliverable 5) rather than inheriting Phase 3's. A burn to a target
 * that already has a `database V2` is not a failure -- it's this
 * writer's own out-of-scope-for-now case (see databaseV2Writer.ts's
 * module doc) working as designed, so `written: false` is an expected,
 * normal outcome, not an error.
 */
export type DatabaseV2BurnOutcome =
  | ({ written: true } & DatabaseV2WriteResult)
  | { written: false; reason: 'already-exists' };

export interface BurnReport {
  diffSummary: DiffSummary;
  organizeReport: OrganizeReport;
  crateWriteResult: CrateWriteResult;
  databaseV2: DatabaseV2BurnOutcome;
  verification: BurnVerification;
  completedAt: string;
}

/**
 * Writes a fresh, complete `_Serato_` structure onto `volumeRoot` (Phase 3
 * of docs/roadmap.md, "burn to flash"): copies whatever's new or changed
 * since the last burn against this exact volume, then regenerates the
 * *entire* crate database from the canonical tree.
 *
 * Every burn rewrites every crate file, even ones with no changed
 * tracks underneath them -- crate files are small and cheap to write,
 * and doing this guarantees the crate *structure* on the target volume
 * can never silently drift from the canonical tree (e.g. a track that
 * moved to a different crate since the last burn), even though the
 * underlying audio files are only ever re-copied when their content has
 * actually changed. This is why `treeAtDestination` is built from the
 * *full* diff, not just the filtered copy plan -- see its doc comment.
 *
 * Copies use `allowOverwrite: true` deliberately: a `changed` diff item
 * here has already been confirmed, by content hash against that exact
 * destination file, to be the same track's slot with different content
 * now, not an incidental collision -- see ExecuteOptions.allowOverwrite
 * in organizer/executor.ts for the full reasoning (and the bug this
 * closed).
 *
 * Never mutates `tree` or any of its tracks' `sourcePath` values -- those
 * keep pointing at the source library throughout. The verification pass
 * reads the real crate files back off disk and checks their content
 * against what was intended, rather than trusting that the write
 * succeeded just because no error was thrown.
 *
 * **Phase 3b, Deliverable 4 (docs/roadmap.md)**: alongside the crate
 * database, also writes a fresh `database V2` -- but only when the
 * target's `_Serato_` folder doesn't already have one. This is the same
 * "blank-drive case only" boundary `databaseV2Writer.ts` enforces itself
 * (see its module doc); it's checked here too, before calling the
 * writer, so a burn to a volume that already has a real, in-use
 * `database V2` reports a normal, expected skip (`databaseV2.written
 * === false`) rather than the writer's own refusal throwing and aborting
 * an otherwise-successful burn. Deliberately NOT part of
 * `BurnVerification`/`verifyBurn` -- see `DatabaseV2BurnOutcome`'s doc
 * comment for why the two trust gates stay separate.
 */
export async function burnToFlash(
  tree: CanonicalTree,
  volumeRoot: string,
  options: BurnOptions
): Promise<BurnReport> {
  const resolvedVolumeRoot = path.resolve(volumeRoot);
  const mode = options.mode ?? 'copy';

  const diff = await diffAgainstDestination(tree, resolvedVolumeRoot, options.store, mode);
  const plan = planFromDiff(diff, mode);
  const organizeReport = await executePlan(plan, { allowOverwrite: true });

  const destinationTree = treeAtDestination(tree, diff);
  const seratoDir = path.join(resolvedVolumeRoot, '_Serato_');
  const subcratesDir = path.join(seratoDir, 'Subcrates');
  const crateWriteResult = await writeCrateDatabase(destinationTree, subcratesDir, {
    volumeRoot: resolvedVolumeRoot,
  });

  const sourceRecords = options.sourceDatabaseV2
    ? await buildSourceRecordsByDestinationPath(options.sourceDatabaseV2, diff)
    : undefined;
  const databaseV2 = await writeDatabaseV2IfBlank(destinationTree, seratoDir, resolvedVolumeRoot, sourceRecords);

  const verification = await verifyBurn(destinationTree, subcratesDir, resolvedVolumeRoot);

  return {
    diffSummary: summarizeDiff(diff),
    organizeReport,
    crateWriteResult,
    databaseV2,
    verification,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Writes `database V2` only when the target's `_Serato_` folder doesn't
 * already have one -- checked here, ahead of calling the writer, so the
 * expected "there's already a real one, this phase doesn't touch it"
 * case comes back as a normal outcome on the report instead of the
 * writer's own defense-in-depth throw aborting a burn that otherwise
 * completed fine (crate database written, files copied). See
 * `DatabaseV2BurnOutcome`'s doc comment for why this stays out of
 * `BurnVerification`'s `ok` flag.
 */
/**
 * Re-keys the source database's raw records (keyed by resolved absolute
 * path on the SOURCE library -- see `readRawDatabaseV2Records`) into a
 * map keyed by resolved absolute path on the BURN DESTINATION instead --
 * which is what `writeDatabaseV2`'s own lookup needs, since it's given
 * `destinationTree`, whose tracks' `sourcePath` has already been remapped
 * to point at the destination (see `treeAtDestination` in
 * organizer/diff.ts: every track's `sourcePath`/`id` there is recomputed
 * from its `targetPath`, not the original source library path).
 *
 * `diff.items` is the bridge: each item still carries both the original
 * `sourcePath` (what a `sourceRecords` entry is keyed by) and the
 * `targetPath` (what `destinationTree`'s corresponding track's
 * `sourcePath` will equal) for the same track, computed from the
 * original `tree` before any remapping happened. A track whose original
 * path has no matching source record (never analyzed anywhere, or not
 * covered by `sourceDatabaseV2`) is simply absent from the result --
 * `writeDatabaseV2` already falls back to its minimal synthesis for any
 * track it can't find here.
 */
async function buildSourceRecordsByDestinationPath(
  sourceDatabaseV2: NonNullable<BurnOptions['sourceDatabaseV2']>,
  diff: OrganizeDiff
): Promise<Map<string, Buffer>> {
  const recordsBySourcePath = await readRawDatabaseV2Records(
    sourceDatabaseV2.filePath,
    path.resolve(sourceDatabaseV2.volumeRoot)
  );

  const recordsByDestinationPath = new Map<string, Buffer>();
  for (const item of diff.items) {
    const record = recordsBySourcePath.get(path.resolve(item.sourcePath));
    if (record) {
      recordsByDestinationPath.set(path.resolve(item.targetPath), record);
    }
  }
  return recordsByDestinationPath;
}

async function writeDatabaseV2IfBlank(
  tree: CanonicalTree,
  seratoDir: string,
  volumeRoot: string,
  sourceRecords?: Map<string, Buffer>
): Promise<DatabaseV2BurnOutcome> {
  const filePath = path.join(seratoDir, DATABASE_V2_FILENAME);
  const alreadyExists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    return { written: false, reason: 'already-exists' };
  }

  const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot, sourceRecords });
  return { written: true, ...result };
}

async function verifyBurn(
  expectedTree: CanonicalTree,
  subcratesDir: string,
  volumeRoot: string
): Promise<BurnVerification> {
  const readBack = await readCrateDatabase(subcratesDir, { volumeRoot });

  // Compared per-crate-path, not just as a flat set of track ids that
  // exist "somewhere" -- a fully-empty subtree writing no crate file at
  // all is still a known, harmless property of the format (decision 15,
  // Phase 2: an expected path with zero direct tracks simply won't
  // appear as a key on either side, so it can't cause a false mismatch
  // here), but a track silently reassigned to the *wrong* crate is a
  // real bug a flat id-set comparison could never catch -- see
  // `diffTrackPlacement`'s doc and docs/decisions.md.
  const placement = diffTrackPlacement(expectedTree, readBack);

  return {
    ok:
      readBack.unresolvedCount === 0 &&
      placement.missingTrackIds.length === 0 &&
      placement.unexpectedTrackIds.length === 0 &&
      placement.misplacedTrackIds.length === 0,
    unresolvedCount: readBack.unresolvedCount,
    ...placement,
  };
}
