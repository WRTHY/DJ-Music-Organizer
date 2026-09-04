export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.aiff',
  '.aif',
  '.flac',
  '.m4a',
  '.ogg',
]);

/** A single audio file, as located on disk right now. */
export interface TrackRef {
  /** Stable id derived from the source path (see serato/hash.ts). */
  id: string;
  /** Absolute path to the file where it currently lives. */
  sourcePath: string;
  filename: string;
  ext: string;
}

/** One folder in the canonical, tool-agnostic tree. */
export interface CanonicalNode {
  name: string;
  /** Path segments from the tree root down to (and including) this node. */
  path: string[];
  children: CanonicalNode[];
  /** Tracks that live directly in this node (not in a child). */
  tracks: TrackRef[];
}

export type SeratoSourceType = 'serato-folders' | 'serato-crates' | 'mixed';

export interface CanonicalTree {
  root: CanonicalNode;
  generatedAt: string;
  sourceType: SeratoSourceType;
}

/**
 * Progress reported mid-scan, so a caller (the desktop UI, ultimately)
 * can show something better than "nothing happened for a while." `total`
 * is only set when it's known up front -- a crate-database scan knows how
 * many .crate files there are before it starts, so it can report a real
 * percentage; a folder-tree scan doesn't know its folder count without a
 * separate full pass, so it stays indeterminate (a running count only).
 */
export interface ScanProgress {
  /** What's being processed right now -- a folder path or a crate filename. */
  current: string;
  processed: number;
  total?: number;
  tracksFound: number;
}

export type ScanProgressCallback = (progress: ScanProgress) => void;

export function emptyNode(name: string, path: string[]): CanonicalNode {
  return { name, path, children: [], tracks: [] };
}

/** Depth-first walk over every node in a tree, root first. */
export function walkTree(
  node: CanonicalNode,
  visit: (node: CanonicalNode) => void
): void {
  visit(node);
  for (const child of node.children) {
    walkTree(child, visit);
  }
}

/** Flattened list of every track in the tree, with its node path attached. */
export function allTracks(
  tree: CanonicalTree
): Array<{ track: TrackRef; path: string[] }> {
  const out: Array<{ track: TrackRef; path: string[] }> = [];
  walkTree(tree.root, (node) => {
    for (const track of node.tracks) {
      out.push({ track, path: node.path });
    }
  });
  return out;
}
