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

  const items: OrganizePlanItem[] = allTracks(tree).map(({ track, path: segments }) => {
    const targetPath = path.join(resolvedTargetRoot, ...segments, track.filename);
    assertStaysUnderRoot(targetPath, resolvedTargetRoot, segments, track.filename);
    return {
      trackId: track.id,
      sourcePath: track.sourcePath,
      targetPath,
      mode,
    };
  });

  return {
    items,
    createdAt: new Date().toISOString(),
    mode,
    targetRoot: resolvedTargetRoot,
  };
}

/**
 * A tree's folder segments should never be able to point outside
 * targetRoot -- but "should never" isn't a guarantee by construction.
 * `readFolderTree` can't produce this (folder names come straight from
 * `fs.readdir`, which never returns "..", a separator, or an absolute
 * path as an entry name), but `readCrateDatabase` builds segments by
 * splitting a `.crate` FILENAME on "%%" (segmentsFromCrateFilename),
 * with no validation of what falls out the other side. A corrupted or
 * maliciously named file like "..%%Evil.crate" would otherwise produce a
 * segment of literally ".." and silently plan a copy one directory above
 * targetRoot -- onto whatever happens to be there. This check is the
 * actual safety boundary: whatever produced the tree, a computed target
 * path that would land outside targetRoot is refused outright, not
 * written. See __tests__/planner.test.ts for the exact attack this
 * closes, including the real .crate-filename version of it.
 */
function assertStaysUnderRoot(
  targetPath: string,
  resolvedTargetRoot: string,
  segments: string[],
  filename: string
): void {
  const relative = path.relative(resolvedTargetRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to plan a copy to "${targetPath}" -- it falls outside the target root ` +
        `"${resolvedTargetRoot}". This means a folder name or filename in the source tree ` +
        `(path: ${JSON.stringify([...segments, filename])}) contains "..", a path separator, or ` +
        'an absolute path, none of which should ever end up in a canonical tree.'
    );
  }
}
