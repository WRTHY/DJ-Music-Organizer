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
  /** Track ids the canonical tree expects at the destination that the read-back crate database doesn't contain. Should always be empty. */
  missingTrackIds: string[];
  /** Track ids the read-back crate database has that the canonical tree didn't expect. Should always be empty -- crates are always regenerated fully from the tree -- but checked rather than assumed. */
  unexpectedTrackIds: string[];
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

  // Compared as sets of track ids rather than tree shape deliberately: a
  // fully-empty subtree writes no crate file and so doesn't survive a
  // round trip (decision 15, Phase 2) -- that's a known, harmless
  // property of the format, not a verification failure, and comparing
  // flattened track ids sidesteps it entirely rather than needing to
  // special-case it here too.
  const expectedIds = new Set(allTracks(expectedTree).map(({ track }) => track.id));
  const actualIds = new Set(allTracks(readBack).map(({ track }) => track.id));

  const missingTrackIds = [...expectedIds].filter((id) => !actualIds.has(id));
  const unexpectedTrackIds = [...actualIds].filter((id) => !expectedIds.has(id));

  return {
    ok: readBack.unresolvedCount === 0 && missingTrackIds.length === 0 && unexpectedTrackIds.length === 0,
    unresolvedCount: readBack.unresolvedCount,
    missingTrackIds,
    unexpectedTrackIds,
  };
}
