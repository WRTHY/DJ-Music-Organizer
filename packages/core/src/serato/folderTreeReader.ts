import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTENSIONS, CanonicalNode, CanonicalTree, emptyNode } from '../types';
import { idForPath } from './hash';

/**
 * Reads a real, already-existing folder tree from disk and turns it into a
 * CanonicalTree. This is the reader to use when Serato's organization is
 * literally reflected as folders on disk (see docs/decisions.md).
 */
export async function readFolderTree(rootPath: string): Promise<CanonicalTree> {
  const resolvedRoot = path.resolve(rootPath);
  const root = await scanDir(resolvedRoot, resolvedRoot, []);
  return {
    root,
    generatedAt: new Date().toISOString(),
    sourceType: 'serato-folders',
  };
}

async function scanDir(
  rootPath: string,
  dirPath: string,
  segments: string[]
): Promise<CanonicalNode> {
  const name = segments.length > 0 ? segments[segments.length - 1] : path.basename(rootPath);
  const node = emptyNode(name, segments);

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Could not read directory "${dirPath}": ${(err as Error).message}`);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files/dirs (e.g. _Serato_ sibling metadata)
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      node.children.push(await scanDir(rootPath, fullPath, [...segments, entry.name]));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        node.tracks.push({
          id: idForPath(fullPath),
          sourcePath: fullPath,
          filename: entry.name,
          ext,
        });
      }
    }
  }

  return node;
}
