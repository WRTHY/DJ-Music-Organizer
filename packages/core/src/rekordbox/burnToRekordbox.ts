import path from 'node:path';
import {
  CanonicalNode,
  CanonicalTree,
  RekordboxBurnProgressCallback,
  BurnProgressCallback,
  allTracks,
} from '../types';
import { TrackIndexStore, hashWithCache } from '../trackIndex';
import { OrganizePlan, OrganizeReport, executePlan, planFromCanonicalTree } from '../organizer';
import {
  RekordboxPlaylistEntry,
  RekordboxPlaylistNode,
  RekordboxTrack,
  readPdbPlaylistEntries,
  readPdbPlaylistTree,
  readPdbTracks,
} from './pdbReader';
import { FOLDER_TRACKS_PLAYLIST_NAME, buildCanonicalTreeFromPlaylists } from './canonicalTree';
import { RekordboxWriteOp, RekordboxWriteOptions, RekordboxWriteResult, writeRekordboxPdb } from './pdbWriter';

/**
 * Phase 5 Deliverable 3 (docs/roadmap.md): the Rekordbox counterpart to
 * `serato/burnToFlash.ts`, implementing decision 30's template-modify
 * strategy end to end. Everything here is this project's own TypeScript;
 * only the final row-writing step (`writeRekordboxPdb`, Deliverable 2)
 * delegates to the vendored `PdbEditor`.
 *
 * The one deliberate, load-bearing difference from `burnToFlash`: Serato's
 * burn *regenerates the entire crate database* from the canonical tree on
 * every run (decision 19's `treeAtDestination`) -- there's nothing else
 * on a burned volume's crate database worth preserving, since this
 * project fully owns that file's contents. A Rekordbox template drive is
 * the opposite: it already has real library content this project did not
 * put there and must never disturb (decision 30's whole reason for
 * choosing template-modify over a from-scratch writer). So this
 * orchestrator never regenerates anything -- it only ever *adds* tracks,
 * playlists, and playlist entries that the source canonical tree calls
 * for and the template doesn't already have (matched by content hash,
 * not by path or id, since a track's path/id on the template almost
 * certainly differs from its path/id in the source library -- and
 * decision 23 already found Rekordbox playlist ids aren't even stable
 * across re-exports). `writeRekordboxPdb` itself never touches
 * `templatePath` either way -- this always produces a distinct
 * `outputPath`, leaving the template untouched until a human decides (via
 * the still-ahead hardware-adjacent trust gate, Deliverable 5) to treat
 * that output as the drive's new `export.pdb`.
 */

export interface RekordboxDiffSummary {
  /** Source tracks with no content match anywhere in the template -- need a real `addTrack` op and a physical copy onto this drive. */
  new: number;
  /** Source tracks whose content already exists somewhere on the template (this drive, or an earlier MLO burn onto it) -- reused by id, never re-copied or re-added. */
  existing: number;
}

export interface RekordboxBurnVerification {
  ok: boolean;
  /**
   * Every (playlist path, content hash) pair the source tree calls for
   * that a fresh read-back of the written output could not find at that
   * same path. Should always be empty. Deliberately hash-based, not
   * id-based -- an `existing` track keeps whatever real numeric id the
   * template already gave it, and this project has no way (or need) to
   * predict that id ahead of a read-back.
   */
  missing: Array<{ path: string[]; contentHash: string }>;
}

export interface RekordboxBurnReport {
  diffSummary: RekordboxDiffSummary;
  /** From copying newly-classified tracks' audio onto the drive -- mirrors `BurnReport.organizeReport` on the Serato side. */
  organizeReport: OrganizeReport;
  /** Tracks classified `new` whose copy failed and were, as a result, deliberately left out of the write batch entirely -- see `burnToRekordbox`'s doc. Should always be 0 on a healthy drive. */
  skippedTrackCount: number;
  writeResult: RekordboxWriteResult;
  verification: RekordboxBurnVerification;
  completedAt: string;
}

export interface RekordboxBurnOptions {
  store: TrackIndexStore;
  /** The template drive's existing `export.pdb` -- read from, never written to (see `writeRekordboxPdb`). */
  templatePath: string;
  /** Where the modified copy is written. A distinct path from `templatePath` on purpose -- see this module's doc. */
  outputPath: string;
  /** The drive's volume root -- the parent of its `PIONEER` folder, same convention `canonicalTree.ts`'s reader already uses. */
  volumeRoot: string;
  /** Subfolder under `volumeRoot` newly-copied audio lands in. Defaults to `'Contents'`, matching the path shape real Rekordbox exports already use (see `pdbWriter.ts`'s `filePath` doc). */
  contentsSubdir?: string;
  writerOptions?: RekordboxWriteOptions;
  onProgress?: RekordboxBurnProgressCallback;
}

/** Where a source track stands relative to what's already on the template drive. */
export interface TrackClassification {
  status: 'new' | 'existing';
  /** Set only when `status === 'existing'`: the real numeric track id this source track's content already has on the template. */
  existingTrackId?: number;
}

/**
 * Matches every source track against every track the template already
 * has, purely by content hash -- never by path, filename, or id, since
 * none of those are expected to agree between the source library and a
 * Rekordbox export. Pure and I/O-free by design so this, the heart of
 * the "don't duplicate what's already on the drive" behavior, is directly
 * unit-testable against hand-built hash maps -- see
 * `__tests__/burnToRekordbox.test.ts`.
 */
export function classifyTracksAgainstTemplate(
  sourceHashByTrackId: Map<string, string>,
  existingHashByTrackId: Map<number, string>
): Map<string, TrackClassification> {
  const existingTrackIdByHash = new Map<string, number>();
  for (const [trackId, hash] of existingHashByTrackId) {
    // First one wins on a hash collision across multiple existing tracks
    // (real duplicate files already on the template drive) -- extremely
    // unlikely, but handled deterministically rather than left to
    // whatever Map iteration order happens to produce.
    if (!existingTrackIdByHash.has(hash)) existingTrackIdByHash.set(hash, trackId);
  }

  const result = new Map<string, TrackClassification>();
  for (const [trackId, hash] of sourceHashByTrackId) {
    const existingTrackId = existingTrackIdByHash.get(hash);
    result.set(trackId, existingTrackId !== undefined ? { status: 'existing', existingTrackId } : { status: 'new' });
  }
  return result;
}

/** What the template already has at a given playlist path (path segments joined with "/"), reusable for reattaching new content under it. */
export interface ExistingPlaylistInfo {
  isFolder: boolean;
  /** This node's own real id (a folder's id if `isFolder`, otherwise the playlist's own id). */
  playlistId: number;
  /** Set only when `isFolder` and this folder already has a `_FolderTracks` child (see `canonicalTree.ts`) -- where THIS node's own direct tracks, if any, actually live. */
  folderTracksPlaylistId?: number;
}

/**
 * Indexes the template's raw `playlist_tree` by path (the same path
 * shape `canonicalTree.ts` builds), but -- unlike
 * `buildCanonicalTreeFromPlaylists` -- keeping every node's real numeric
 * id, which the general-purpose reader deliberately discards (a
 * `CanonicalTree` is tool-agnostic and has no id concept at all). Diffing
 * needs those real ids to reuse an existing playlist/folder rather than
 * creating a duplicate at the same path.
 */
export function buildExistingPlaylistIndex(playlistTree: RekordboxPlaylistNode[]): Map<string, ExistingPlaylistInfo> {
  const childrenByParentId = new Map<number, RekordboxPlaylistNode[]>();
  for (const node of playlistTree) {
    const list = childrenByParentId.get(node.parentId) ?? [];
    list.push(node);
    childrenByParentId.set(node.parentId, list);
  }

  const index = new Map<string, ExistingPlaylistInfo>();

  function visit(node: RekordboxPlaylistNode, segments: string[]): void {
    const pathKey = segments.join('/');
    const info: ExistingPlaylistInfo = { isFolder: node.isFolder, playlistId: node.id };
    if (node.isFolder) {
      const folderTracksChild = (childrenByParentId.get(node.id) ?? []).find(
        (c) => !c.isFolder && c.name === FOLDER_TRACKS_PLAYLIST_NAME
      );
      if (folderTracksChild) info.folderTracksPlaylistId = folderTracksChild.id;
    }
    index.set(pathKey, info);

    for (const child of childrenByParentId.get(node.id) ?? []) {
      if (!child.isFolder && child.name === FOLDER_TRACKS_PLAYLIST_NAME) continue; // indexed via the parent's folderTracksPlaylistId, not as its own path
      visit(child, [...segments, child.name]);
    }
  }

  for (const node of childrenByParentId.get(0) ?? []) {
    if (!node.isFolder && node.name === FOLDER_TRACKS_PLAYLIST_NAME) continue; // unusual at the top level, but handled the same way for consistency
    visit(node, [node.name]);
  }

  return index;
}

/** playlistId -> the real track ids already linked to it, so a re-burn never re-adds a `playlist_entries` row that's already there. */
export function buildExistingMembership(playlistEntries: RekordboxPlaylistEntry[]): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (const entry of playlistEntries) {
    const set = map.get(entry.playlistId) ?? new Set<number>();
    set.add(entry.trackId);
    map.set(entry.playlistId, set);
  }
  return map;
}

export interface RekordboxWritePlan {
  ops: RekordboxWriteOp[];
  /** Source `TrackRef.id` -> the `localId` its `addTrack` op was given. Only set for `new` tracks. */
  newTrackLocalIds: Map<string, string>;
}

/**
 * The write-side counterpart to `classifyTracksAgainstTemplate`: turns a
 * source canonical tree plus what's already on the template into the
 * exact batch of ops `writeRekordboxPdb` needs. Pure and I/O-free --
 * every real id/hash it needs is passed in already computed, so this can
 * be (and is) unit-tested against small hand-built trees with no real
 * `.pdb` file involved.
 *
 * Three things this deliberately gets right, each one a real way this
 * could otherwise go wrong on a re-burn:
 * - A folder that already exists on the template (by path) is reused by
 *   id, never recreated -- a second burn of an unchanged library adds
 *   nothing at all, matching Serato's diff-driven "burning twice copies
 *   nothing" property (decision 18).
 * - A folder that needs to hold both a subfolder and direct tracks of its
 *   own gets Rekordbox's own `_FolderTracks` convention applied on write,
 *   not just recognized on read (`canonicalTree.ts`) -- otherwise a
 *   fresh read-back of what this just wrote would show the direct tracks
 *   as a stray visible "_FolderTracks" playlist instead of folding them
 *   into the parent, breaking the read/write symmetry the format itself
 *   doesn't enforce.
 * - A folder with nothing anywhere in its own subtree gets no playlist at
 *   all -- the same "an empty subtree writes nothing" property Serato's
 *   crate writer already has (decision 15) -- there being no
 *   currently-known Rekordbox row that could represent a folder with
 *   zero tracks in it either.
 */
export function planRekordboxWriteOps(
  tree: CanonicalTree,
  classification: Map<string, TrackClassification>,
  newTrackTargetPaths: Map<string, string>,
  volumeRoot: string,
  existingPlaylists: Map<string, ExistingPlaylistInfo>,
  existingMembership: Map<number, Set<number>>
): RekordboxWritePlan {
  const ops: RekordboxWriteOp[] = [];
  const newTrackLocalIds = new Map<string, string>();
  let counter = 0;
  const nextLocalId = (prefix: string) => `${prefix}${++counter}`;

  for (const { track } of allTracks(tree)) {
    if (newTrackLocalIds.has(track.id)) continue; // multi-membership: the same track can appear under more than one node
    const info = classification.get(track.id);
    if (!info || info.status !== 'new') continue;
    const targetPath = newTrackTargetPaths.get(track.id);
    if (!targetPath) continue; // its copy failed (or was never attempted) -- see burnToRekordbox's doc; deliberately left out of the write batch rather than referencing a file that isn't really there

    const localId = nextLocalId('t');
    newTrackLocalIds.set(track.id, localId);
    ops.push({
      op: 'addTrack',
      localId,
      // No real tag metadata is wired into the canonical tree yet (that's
      // Phase 6's still-future "audio tag reading/writing" work) -- same
      // "minimal now, let the tool's own pass backfill the rest" posture
      // already used for Serato's `database V2` writer (decision 26).
      // Real analysis (waveforms/beatgrids, and Rekordbox's own tag read)
      // still needs Rekordbox/CDJ to touch the track at least once either
      // way (decision 30).
      title: path.basename(track.filename, track.ext) || track.filename,
      filePath: toPdbPath(targetPath, volumeRoot),
      filename: track.filename,
    });
  }

  function trackRef(trackId: string): string | undefined {
    const localId = newTrackLocalIds.get(trackId);
    if (localId) return localId;
    const info = classification.get(trackId);
    return info?.existingTrackId !== undefined ? String(info.existingTrackId) : undefined;
  }

  // A track only counts toward "does this subtree have anything worth a
  // playlist" if it will actually get an op -- an 'existing' track always
  // will, but a 'new' one only counts once it has a real target path
  // (i.e. its copy didn't fail). Without this, a folder whose only track
  // failed to copy would still get an empty playlist created for it --
  // harmless clutter, but not the same "an empty subtree writes nothing"
  // property Serato's crate writer already has (decision 15).
  function trackIsWritable(trackId: string): boolean {
    const info = classification.get(trackId);
    if (!info) return false;
    return info.status === 'existing' || newTrackTargetPaths.has(trackId);
  }

  function subtreeHasTracks(node: CanonicalNode): boolean {
    if (node.tracks.some((t) => trackIsWritable(t.id))) return true;
    return node.children.some(subtreeHasTracks);
  }

  function visit(node: CanonicalNode, parentRef: string | undefined): void {
    for (const child of node.children) {
      if (!subtreeHasTracks(child)) continue;

      const pathKey = child.path.join('/');
      const existing = existingPlaylists.get(pathKey);
      const needsFolder = child.children.some(subtreeHasTracks);
      const hasOwnTracks = child.tracks.length > 0;

      let childParentRef: string;
      let ownPlaylistRef: string;
      let ownPlaylistNumericId: number | undefined;

      if (existing) {
        childParentRef = String(existing.playlistId);
        if (needsFolder && hasOwnTracks) {
          if (existing.folderTracksPlaylistId !== undefined) {
            ownPlaylistRef = String(existing.folderTracksPlaylistId);
            ownPlaylistNumericId = existing.folderTracksPlaylistId;
          } else {
            const localId = nextLocalId('p');
            ops.push({ op: 'createPlaylist', localId, name: FOLDER_TRACKS_PLAYLIST_NAME, parentRef: String(existing.playlistId) });
            ownPlaylistRef = localId;
          }
        } else {
          ownPlaylistRef = String(existing.playlistId);
          ownPlaylistNumericId = existing.playlistId;
        }
      } else {
        const localId = nextLocalId('p');
        ops.push({ op: 'createPlaylist', localId, name: child.name, parentRef, isFolder: needsFolder });
        childParentRef = localId;
        if (needsFolder && hasOwnTracks) {
          const folderTracksLocalId = nextLocalId('p');
          ops.push({ op: 'createPlaylist', localId: folderTracksLocalId, name: FOLDER_TRACKS_PLAYLIST_NAME, parentRef: localId });
          ownPlaylistRef = folderTracksLocalId;
        } else {
          ownPlaylistRef = localId;
        }
      }

      if (hasOwnTracks) {
        const alreadyLinked = ownPlaylistNumericId !== undefined ? existingMembership.get(ownPlaylistNumericId) : undefined;
        for (const track of child.tracks) {
          const ref = trackRef(track.id);
          if (!ref) continue; // its copy failed -- see the addTrack loop above
          if (alreadyLinked?.has(Number(ref))) continue; // Number(a localId) is NaN, so this only ever short-circuits for a reused, already-linked existing track
          ops.push({ op: 'addToPlaylist', playlistRef: ownPlaylistRef, trackRef: ref });
        }
      }

      visit(child, childParentRef);
    }
  }

  visit(tree.root, undefined);

  return { ops, newTrackLocalIds };
}

/** `"/Contents/Artist/Album/01 Track.mp3"` style path, as `writeRekordboxPdb`'s `addTrack.filePath` expects -- forward slashes, leading slash, relative to the drive's volume root. */
function toPdbPath(absolutePath: string, volumeRoot: string): string {
  const relative = path.relative(path.resolve(volumeRoot), absolutePath).split(path.sep).join('/');
  return `/${relative}`;
}

/**
 * Diffs `tree` against `templatePath`, copies whatever's genuinely new
 * onto the drive, applies the resulting write batch via `writeRekordboxPdb`
 * (Deliverable 2) to a fresh `outputPath`, and reads that output back to
 * confirm every source track actually landed where it was meant to --
 * same "never trust the writer's own success signal alone" posture as
 * `serato/burnToFlash.ts`'s `verifyBurn`.
 *
 * `templatePath` is never modified -- promoting `outputPath` to be the
 * drive's real `export.pdb` is a separate, later, human-gated decision
 * (Deliverable 5's hardware-adjacent trust gate), not something this
 * function ever does on its own.
 */
export async function burnToRekordbox(tree: CanonicalTree, options: RekordboxBurnOptions): Promise<RekordboxBurnReport> {
  const volumeRoot = path.resolve(options.volumeRoot);
  const contentsRoot = path.join(volumeRoot, options.contentsSubdir ?? 'Contents');
  const onProgress = options.onProgress;
  const store = options.store;

  const [existingTracks, playlistTree, playlistEntries] = await Promise.all([
    readPdbTracks(options.templatePath),
    readPdbPlaylistTree(options.templatePath),
    readPdbPlaylistEntries(options.templatePath),
  ]);

  const sourceItems = allTracks(tree);
  const sourceHashByTrackId = new Map<string, string>();
  let diffed = 0;
  for (const { track } of sourceItems) {
    if (!sourceHashByTrackId.has(track.id)) {
      sourceHashByTrackId.set(track.id, await hashWithCache(store, track.sourcePath));
    }
    diffed += 1;
    onProgress?.({ phase: 'diffing', current: track.sourcePath, processed: diffed, total: sourceItems.length });
  }

  const existingHashByTrackId = new Map<number, string>();
  for (const existingTrack of existingTracks) {
    const relative = existingTrack.filePath.startsWith('/') ? existingTrack.filePath.slice(1) : existingTrack.filePath;
    const absolute = path.resolve(volumeRoot, relative);
    try {
      existingHashByTrackId.set(existingTrack.id, await hashWithCache(store, absolute));
    } catch {
      // The template's pdb references a file this drive doesn't actually
      // have right now -- can't be matched by content, so it's simply
      // never a match target. Not something a read-only template reader
      // should ever try to fix.
    }
  }
  await store.save();

  const classification = classifyTracksAgainstTemplate(sourceHashByTrackId, existingHashByTrackId);

  const fullPlan = planFromCanonicalTree(tree, contentsRoot, 'copy');
  const newTrackIds = new Set([...classification.entries()].filter(([, c]) => c.status === 'new').map(([id]) => id));
  const copyPlan: OrganizePlan = { ...fullPlan, items: fullPlan.items.filter((item) => newTrackIds.has(item.trackId)) };

  const forwardCopyProgress: BurnProgressCallback | undefined = onProgress
    ? (p) => onProgress({ phase: 'copying', current: p.current, processed: p.processed, total: p.total })
    : undefined;
  const organizeReport = await executePlan(copyPlan, { allowOverwrite: false, onProgress: forwardCopyProgress });

  // A track's *final* location, not just what the plan intended -- a
  // collision at the planned path (rare; see planFromCanonicalTree) can
  // rename it aside, and the write batch must reference wherever the
  // file actually ended up, not where it was merely supposed to.
  const newTrackTargetPaths = new Map<string, string>();
  for (const result of organizeReport.results) {
    if (result.status !== 'error') newTrackTargetPaths.set(result.trackId, result.finalTargetPath);
  }

  const existingPlaylists = buildExistingPlaylistIndex(playlistTree);
  const existingMembership = buildExistingMembership(playlistEntries);
  const { ops } = planRekordboxWriteOps(tree, classification, newTrackTargetPaths, volumeRoot, existingPlaylists, existingMembership);

  onProgress?.({ phase: 'writingPdb', processed: 0 });
  const writeResult = await writeRekordboxPdb(options.templatePath, options.outputPath, ops, options.writerOptions);

  onProgress?.({ phase: 'verifying', processed: 0 });
  const skippedTrackCount = [...newTrackIds].filter((id) => !newTrackTargetPaths.has(id)).length;
  const verification = writeResult.ok
    ? await verifyRekordboxBurn(tree, sourceHashByTrackId, newTrackIds, newTrackTargetPaths, options.outputPath, volumeRoot, store)
    : { ok: false, missing: [] };

  return {
    diffSummary: {
      new: [...classification.values()].filter((c) => c.status === 'new').length,
      existing: [...classification.values()].filter((c) => c.status === 'existing').length,
    },
    organizeReport,
    skippedTrackCount,
    writeResult,
    verification,
    completedAt: new Date().toISOString(),
  };
}

async function verifyRekordboxBurn(
  tree: CanonicalTree,
  sourceHashByTrackId: Map<string, string>,
  newTrackIds: Set<string>,
  newTrackTargetPaths: Map<string, string>,
  outputPath: string,
  volumeRoot: string,
  store: TrackIndexStore
): Promise<RekordboxBurnVerification> {
  const [tracks, playlistTree, playlistEntries] = await Promise.all([
    readPdbTracks(outputPath),
    readPdbPlaylistTree(outputPath),
    readPdbPlaylistEntries(outputPath),
  ]);
  const actualTree = buildCanonicalTreeFromPlaylists(tracks, playlistTree, playlistEntries, { volumeRoot });

  // Only ever hash actual-tree tracks at a path the SOURCE tree itself
  // touches -- template-modify means the rest of the drive's real library
  // content (whatever was on it before this project ever saw it) is
  // deliberately untouched and none of this verification's business. This
  // also means a real pre-existing template track this source tree never
  // mentions never needs its bytes read here at all.
  const relevantPathKeys = new Set(allTracks(tree).map(({ path: nodePath }) => nodePath.join('/')));

  const actualHashesByPath = new Map<string, Set<string>>();
  for (const { track, path: nodePath } of allTracks(actualTree)) {
    const key = nodePath.join('/');
    if (!relevantPathKeys.has(key)) continue;
    const hash = await hashWithCache(store, track.sourcePath);
    const set = actualHashesByPath.get(key) ?? new Set<string>();
    set.add(hash);
    actualHashesByPath.set(key, set);
  }

  const missing: Array<{ path: string[]; contentHash: string }> = [];
  for (const { track, path: nodePath } of allTracks(tree)) {
    // A track whose copy failed was deliberately left out of the write
    // batch entirely (see planRekordboxWriteOps) -- checking for it here
    // would just re-report the same failure `organizeReport`/
    // `skippedTrackCount` already surfaced, under a more confusing name.
    if (newTrackIds.has(track.id) && !newTrackTargetPaths.has(track.id)) continue;

    const hash = sourceHashByTrackId.get(track.id);
    if (!hash) continue;
    const key = nodePath.join('/');
    if (!actualHashesByPath.get(key)?.has(hash)) {
      missing.push({ path: nodePath, contentHash: hash });
    }
  }

  return { ok: missing.length === 0, missing };
}
