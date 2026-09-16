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

// Name predates Rekordbox support (originally Serato-only) -- kept as-is
// rather than renamed, to avoid rippling a cosmetic rename through every
// existing import for no functional benefit.
export type SeratoSourceType = 'serato-folders' | 'serato-crates' | 'mixed' | 'rekordbox-playlists';

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

/**
 * Progress reported mid-burn (Phase 3b, docs/roadmap.md, "burn progress
 * tracker" -- James, 2026-09-14: the single "Burning..." spinner was
 * ambiguous about whether anything was actually happening). Deliberately
 * NOT reusing `ScanProgress` even though the shape looks similar: a scan
 * is one loop over one kind of unit (folders, or crates), but a burn is
 * several genuinely different phases in sequence -- diffing, copying,
 * writing the crate database, writing `database V2`, verifying -- and
 * only two of those (diffing, copying) are itemized per-track the way a
 * scan is. Folding that into `ScanProgress` would mean either a fake
 * "current folder" for phases that have no per-item concept, or a type
 * where half the fields are meaningless depending on context; a distinct
 * type keeps every field honest about when it applies.
 *
 * `current`/`total` are only ever set during the two itemized phases
 * ('diffing', 'copying') -- one event per track, mirroring exactly how
 * `ScanProgress`/`readFolderTree` report one event per folder. The three
 * single-shot phases ('writingCrates', 'writingDatabaseV2', 'verifying')
 * fire exactly once each, with `processed: 0` and no `total` -- there's
 * no meaningful sub-progress within them (they're comparatively fast,
 * generated-file writes/reads), but firing an event on entry still lets
 * the UI update its label so a burn doesn't look stuck during the
 * (usually brief) time spent there after copying finishes.
 */
export type BurnPhase = 'diffing' | 'copying' | 'writingCrates' | 'writingDatabaseV2' | 'verifying';

export interface BurnProgress {
  phase: BurnPhase;
  /** The track path currently being diffed/copied. Only set during 'diffing'/'copying'. */
  current?: string;
  processed: number;
  /** Only known during 'diffing'/'copying' -- both operate over a plan whose item count is known up front. */
  total?: number;
}

export type BurnProgressCallback = (progress: BurnProgress) => void;

/**
 * Progress reported mid-burn for `rekordbox/burnToRekordbox.ts` (Phase 5
 * Deliverable 3, docs/roadmap.md). Deliberately its own type rather than
 * reusing `BurnPhase`/`BurnProgress` above, for the same reason those
 * don't reuse `ScanProgress`: a Rekordbox burn's phases don't match
 * Serato's one-for-one. There's no `writingCrates`/`writingDatabaseV2`
 * split -- the template-modify strategy (decision 30) writes everything
 * (new tracks, new/reused playlists, new playlist entries) in one
 * `PdbEditor` session -- so the write side collapses to a single
 * `writingPdb` phase instead of two. `diffing` and `copying` are shared
 * phase *names* with Serato's `BurnPhase` (this burn also diffs by
 * content hash and copies new audio files, via the same
 * `TrackIndexStore`/`executePlan` machinery) but are a genuinely
 * different type -- a Rekordbox burn's `copying` only ever includes
 * tracks classified `new` against the *template's own* existing content,
 * never a `changed` re-copy the way Serato's diff can produce, since
 * template-modify never rewrites a track that's already on the drive.
 */
export type RekordboxBurnPhase = 'diffing' | 'copying' | 'writingPdb' | 'verifying';

export interface RekordboxBurnProgress {
  phase: RekordboxBurnPhase;
  /** The track path currently being diffed/copied. Only set during 'diffing'/'copying'. */
  current?: string;
  processed: number;
  /** Only known during 'diffing'/'copying'. */
  total?: number;
}

export type RekordboxBurnProgressCallback = (progress: RekordboxBurnProgress) => void;

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
