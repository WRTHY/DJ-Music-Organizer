import fs from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTENSIONS, CanonicalNode, CanonicalTree, ScanProgressCallback, emptyNode } from '../types';
import { idForPath } from './hash';

/**
 * Reads a real, already-existing folder tree from disk and turns it into a
 * CanonicalTree. This is the reader to use when Serato's organization is
 * literally reflected as folders on disk (see docs/decisions.md).
 *
 * `onProgress`, if given, fires once per folder visited (not once per
 * file -- a flat folder with thousands of tracks would otherwise flood
 * the caller with events for no benefit). There's no known total here:
 * counting every folder up front would mean walking the tree twice, so
 * progress is a running count, not a percentage.
 */
export async function readFolderTree(
  rootPath: string,
  onProgress?: ScanProgressCallback
): Promise<CanonicalTree> {
  const resolvedRoot = path.resolve(rootPath);
  const state = { foldersScanned: 0, tracksFound: 0 };
  const root = await scanDir(resolvedRoot, resolvedRoot, [], state, onProgress);
  return {
    root,
    generatedAt: new Date().toISOString(),
    sourceType: 'serato-folders',
  };
}

interface ScanState {
  foldersScanned: number;
  tracksFound: number;
}

async function scanDir(
  rootPath: string,
  dirPath: string,
  segments: string[],
  state: ScanState,
  onProgress?: ScanProgressCallback
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

  state.foldersScanned += 1;
  onProgress?.({ current: dirPath, processed: state.foldersScanned, tracksFound: state.tracksFound });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files/dirs (e.g. _Serato_ sibling metadata)
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      node.children.push(await scanDir(rootPath, fullPath, [...segments, entry.name], state, onProgress));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        node.tracks.push({
          id: idForPath(fullPath),
          sourcePath: fullPath,
          filename: entry.name,
          ext,
        });
        state.tracksFound += 1;
      }
    }
  }

  return node;
}
