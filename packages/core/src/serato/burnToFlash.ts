import path from 'node:path';
import { CanonicalTree, allTracks } from '../types';
import { TrackIndexStore } from '../trackIndex';
import {
  DiffSummary,
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

export interface BurnOptions {
  store: TrackIndexStore;
  /** Defaults to 'copy' -- burning duplicates the library onto a target volume, it doesn't relocate the source. */
  mode?: OrganizeMode;
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

export interface BurnReport {
  diffSummary: DiffSummary;
  organizeReport: OrganizeReport;
  crateWriteResult: CrateWriteResult;
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
  const subcratesDir = path.join(resolvedVolumeRoot, '_Serato_', 'Subcrates');
  const crateWriteResult = await writeCrateDatabase(destinationTree, subcratesDir, {
    volumeRoot: resolvedVolumeRoot,
  });

  const verification = await verifyBurn(destinationTree, subcratesDir, resolvedVolumeRoot);

  return {
    diffSummary: summarizeDiff(diff),
    organizeReport,
    crateWriteResult,
    verification,
    completedAt: new Date().toISOString(),
  };
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
