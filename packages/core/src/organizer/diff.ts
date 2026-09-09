import fs from 'node:fs/promises';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef } from '../types';
import { TrackIndexStore, hashWithCache } from '../trackIndex';
// idForPath is a plain sha1-of-absolute-path helper that happens to live
// under serato/ historically (see docs/decisions.md, "Phase 3, burn
// orchestration") -- organizer/ pulling it in for treeAtDestination below
// is a small, deliberate cross-module dependency, not an oversight; a
// future cleanup could relocate it to types/ since it isn't actually
// Serato-specific.
import { idForPath } from '../serato/hash';
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


/**
 * Rebuilds a tree with the exact same shape as `tree`, but with every
 * track's `sourcePath` (and derived `id`/`filename`/`ext`) replaced by
 * where the diff says that track now lives (or will live) at the
 * destination, rather than where it lives in the source library.
 *
 * This exists for exactly one reason: writing a destination-side format
 * that encodes track paths (e.g. Serato's crate database via
 * `writeCrateDatabase`) needs those paths to be relative to the
 * *destination* volume, not the source library -- but only a `new`/
 * `changed` track was actually just copied there. A track that's
 * `unchanged` already exists at the destination from an earlier run and
 * must still be represented at its destination path, or it would
 * silently vanish from a regenerated crate database despite its audio
 * file being untouched and perfectly fine on disk. Uses every item in
 * `diff` (not just the ones `planFromDiff` would keep) specifically to
 * avoid that.
 */
export function treeAtDestination(tree: CanonicalTree, diff: OrganizeDiff): CanonicalTree {
  const targetPathByTrackId = new Map(diff.items.map((item) => [item.trackId, item.targetPath]));

  function remapNode(node: CanonicalNode): CanonicalNode {
    const tracks: TrackRef[] = node.tracks.map((track) => {
      const targetPath = targetPathByTrackId.get(track.id);
      if (!targetPath) {
        throw new Error(
          `treeAtDestination: no target path recorded for track "${track.sourcePath}" (id ${track.id}). ` +
            'This should be impossible -- diffAgainstDestination computes a target path for every track ' +
            'in the tree it was given, so this diff must not have been produced from this tree.'
        );
      }
      return {
        id: idForPath(targetPath),
        sourcePath: targetPath,
        filename: path.basename(targetPath),
        ext: path.extname(targetPath).toLowerCase(),
      };
    });

    return {
      ...node,
      tracks,
      children: node.children.map(remapNode),
    };
  }

  return {
    ...tree,
    root: remapNode(tree.root),
  };
}
