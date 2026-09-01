import path from 'node:path';
import { CanonicalTree, allTracks } from '../types';

export type OrganizeMode = 'copy' | 'move';

export interface OrganizePlanItem {
  trackId: string;
  sourcePath: string;
  targetPath: string;
  mode: OrganizeMode;
}

export interface OrganizePlan {
  items: OrganizePlanItem[];
  createdAt: string;
  mode: OrganizeMode;
  targetRoot: string;
}

/**
 * Builds a plan that mirrors a CanonicalTree's structure under a new
 * target root — this is "step one" from the project brief: reproduce
 * whatever structure Serato currently has, as real folders, without
 * touching the filesystem yet.
 */
export function planFromCanonicalTree(
  tree: CanonicalTree,
  targetRoot: string,
  mode: OrganizeMode = 'copy'
): OrganizePlan {
  const resolvedTargetRoot = path.resolve(targetRoot);

  const items: OrganizePlanItem[] = allTracks(tree).map(({ track, path: segments }) => ({
    trackId: track.id,
    sourcePath: track.sourcePath,
    targetPath: path.join(resolvedTargetRoot, ...segments, track.filename),
    mode,
  }));

  return {
    items,
    createdAt: new Date().toISOString(),
    mode,
    targetRoot: resolvedTargetRoot,
  };
}
