import fs from 'node:fs/promises';
import { CanonicalTree } from '../types';
import { TrackIndexStore, hashWithCache } from '../trackIndex';
import { OrganizeMode, OrganizePlan, OrganizePlanItem, planFromCanonicalTree } from './planner';

/**
 * `new` — nothing exists yet at the track's target path.
 * `unchanged` — a file already exists there and its content hash matches
 * the source track's, so nothing needs to be (re)written.
 * `changed` — a file already exists there, but its content differs from
 * the source track's -- something needs to be (re)written.
 *
 * There is deliberately no `orphaned`/`deleted` status: diffing here is
 * additive-only (see docs/decisions.md, "Phase 3 design", 2026-09-09) --
 * a destination file with no corresponding source track just isn't
 * mentioned at all, never flagged for removal.
 */
export type DiffStatus = 'new' | 'unchanged' | 'changed';

export interface DiffItem {
  trackId: string;
  sourcePath: string;
  targetPath: string;
  status: DiffStatus;
}

export interface OrganizeDiff {
  items: DiffItem[];
  targetRoot: string;
  generatedAt: string;
}

export interface DiffSummary {
  new: number;
  unchanged: number;
  changed: number;
}

/**
 * Compares a canonical source tree against whatever already exists at
 * `targetRoot` -- a burn-to-flash target, or the ordinary copy-to-
 * canonical-tree target; the same logic covers both (see
 * docs/roadmap.md, Phase 3). Reuses `planFromCanonicalTree` for the
 * expected target path of every track, which is also where the
 * path-traversal safety check (decision 16) already lives -- a diff
 * can't compute an unsafe path that the planner itself would refuse.
 *
 * Content hashes are looked up through `store` (see trackIndex/), so a
 * previously-hashed, unchanged file is not re-read from disk on every
 * diff -- only a file whose size or mtime has actually changed since it
 * was last hashed costs a real read.
 */
export async function diffAgainstDestination(
  tree: CanonicalTree,
  targetRoot: string,
  store: TrackIndexStore,
  mode: OrganizeMode = 'copy'
): Promise<OrganizeDiff> {
  const plan = planFromCanonicalTree(tree, targetRoot, mode);

  const items: DiffItem[] = [];
  for (const planItem of plan.items) {
    const status = await classify(planItem.sourcePath, planItem.targetPath, store);
    items.push({
      trackId: planItem.trackId,
      sourcePath: planItem.sourcePath,
      targetPath: planItem.targetPath,
      status,
    });
  }

  return {
    items,
    targetRoot: plan.targetRoot,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Turns a diff into a plan containing only the tracks that actually need
 * to be written -- `new` and `changed`, never `unchanged`. This is the
 * whole point of diffing: re-burning (or re-copying to an
 * already-organized target) a 5-year library should copy nothing that
 * hasn't actually changed.
 */
export function planFromDiff(diff: OrganizeDiff, mode: OrganizeMode = 'copy'): OrganizePlan {
  const items: OrganizePlanItem[] = diff.items
    .filter((item) => item.status !== 'unchanged')
    .map((item) => ({
      trackId: item.trackId,
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      mode,
    }));

  return {
    items,
    createdAt: new Date().toISOString(),
    mode,
    targetRoot: diff.targetRoot,
  };
}

export function summarizeDiff(diff: OrganizeDiff): DiffSummary {
  const summary: DiffSummary = { new: 0, unchanged: 0, changed: 0 };
  for (const item of diff.items) {
    summary[item.status] += 1;
  }
  return summary;
}

async function classify(sourcePath: string, targetPath: string, store: TrackIndexStore): Promise<DiffStatus> {
  const destinationExists = await pathExists(targetPath);
  if (!destinationExists) return 'new';

  const [sourceHash, destinationHash] = await Promise.all([
    hashWithCache(store, sourcePath),
    hashWithCache(store, targetPath),
  ]);
  return sourceHash === destinationHash ? 'unchanged' : 'changed';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
