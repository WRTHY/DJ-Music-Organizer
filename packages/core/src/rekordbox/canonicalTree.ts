import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../types';
// idForPath lives under serato/ for historical reasons (it predates this
// module) but is a generic path-hashing utility, not Serato-specific --
// same minor, deliberate cross-module dependency organizer/diff.ts
// already has, for the same reason (see docs/decisions.md, decision 18).
import { idForPath } from '../serato/hash';
import { RekordboxPlaylistEntry, RekordboxPlaylistNode, RekordboxTrack } from './pdbReader';

/**
 * Assembles the three raw `pdbReader.ts` tables (tracks, playlist_tree,
 * playlist_entries) into this project's tool-agnostic CanonicalTree --
 * the Rekordbox equivalent of `serato/crateDatabaseReader.ts`.
 *
 * Rekordbox's playlist_tree is a genuine parent/child hierarchy (real
 * `parentId` pointers), unlike Serato's crates, which fake nesting via
 * `%%`-separated filenames with no real parent links. That makes this
 * side simpler in one way -- no filename convention to reverse -- but it
 * introduces a real quirk Serato doesn't have: Rekordbox's own data
 * model has no way to attach a track directly to a folder, so its UI
 * fakes it by creating a hidden child playlist named "_FolderTracks"
 * under any folder that has tracks dropped straight into it. Confirmed
 * against a real 3,549-track / 431-node export (2026-09-10, see
 * docs/decisions.md): every folder with tracks placed directly in it in
 * the Rekordbox UI has exactly one such child. Left as its own visible
 * subfolder, it would just expose that implementation detail rather than
 * anything James actually organized -- so its tracks are folded into the
 * parent folder node itself, and the node is dropped from the tree. This
 * is a real judgment call, not something the format states outright --
 * flagged here (and in docs/decisions.md) in case it's ever wrong for an
 * export shaped differently than the one this was checked against.
 *
 * Same multi-membership caveat as the Serato crate reader: a track can
 * belong to more than one playlist at once, and this function keeps it
 * in every one of them rather than picking a single "owning" node --
 * see serato/crateDatabaseReader.ts's module doc for the fuller
 * reasoning (it's the same reasoning here).
 */

export interface RekordboxTreeOptions {
  /**
   * The folder that a track's stored path (e.g.
   * "/Open Decks/Chill Trap House/track.mp3") is relative to -- the
   * parent of the `PIONEER` folder on the export volume. Confirmed
   * 2026-09-10 against a real flash-drive export: the same "parent of
   * the tool's own metadata folder" convention as Serato's `volumeRoot`
   * (see crateDatabaseReader.ts).
   */
  volumeRoot: string;
}

export interface RekordboxTreeResult extends CanonicalTree {
  /**
   * playlist_entries rows referencing a track id or playlist id this
   * export doesn't actually have. playlist_entries rows carry no
   * validity marker of their own (see pdbReader.ts), so this is where
   * a bogus row would actually get caught -- dropped and counted here
   * rather than silently included or guessed at. 0 on a clean export.
   */
  orphanedEntryCount: number;
}

const FOLDER_TRACKS_PLAYLIST_NAME = '_FolderTracks';

export function buildCanonicalTreeFromPlaylists(
  tracks: RekordboxTrack[],
  playlistTree: RekordboxPlaylistNode[],
  playlistEntries: RekordboxPlaylistEntry[],
  options: RekordboxTreeOptions
): RekordboxTreeResult {
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const nodesById = new Map(playlistTree.map((n) => [n.id, n]));

  const entriesByPlaylistId = new Map<number, RekordboxPlaylistEntry[]>();
  let orphanedEntryCount = 0;
  for (const entry of playlistEntries) {
    if (!nodesById.has(entry.playlistId) || !trackById.has(entry.trackId)) {
      orphanedEntryCount += 1;
      continue;
    }
    const list = entriesByPlaylistId.get(entry.playlistId) ?? [];
    list.push(entry);
    entriesByPlaylistId.set(entry.playlistId, list);
  }

  const childrenByParentId = new Map<number, RekordboxPlaylistNode[]>();
  for (const node of playlistTree) {
    const list = childrenByParentId.get(node.parentId) ?? [];
    list.push(node);
    childrenByParentId.set(node.parentId, list);
  }
  for (const list of childrenByParentId.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  function toTrackRef(rbTrack: RekordboxTrack): TrackRef {
    // Stored paths are volume-root-relative with a leading "/" (e.g.
    // "/Open Decks/Chill Trap House/track.mp3"). Stripping the slash
    // before resolving -- rather than handing it to path.resolve/join
    // as-is -- matters: an untouched leading "/" reads as a POSIX
    // absolute path and would make path.resolve silently DISCARD
    // volumeRoot and return the wrong location outright, not just a
    // slightly-off one.
    const relative = rbTrack.filePath.startsWith('/') ? rbTrack.filePath.slice(1) : rbTrack.filePath;
    const resolved = path.resolve(options.volumeRoot, relative);
    return {
      id: idForPath(resolved),
      sourcePath: resolved,
      filename: path.basename(resolved),
      ext: path.extname(resolved).toLowerCase(),
    };
  }

  function tracksForPlaylist(playlistId: number): TrackRef[] {
    const entries = (entriesByPlaylistId.get(playlistId) ?? [])
      .slice()
      .sort((a, b) => a.entryIndex - b.entryIndex);
    return entries.map((e) => toTrackRef(trackById.get(e.trackId)!));
  }

  function buildNode(rbNode: RekordboxPlaylistNode, segments: string[]): CanonicalNode {
    const node = emptyNode(rbNode.name, segments);

    for (const child of childrenByParentId.get(rbNode.id) ?? []) {
      if (!child.isFolder && child.name === FOLDER_TRACKS_PLAYLIST_NAME) {
        node.tracks.push(...tracksForPlaylist(child.id)); // see FOLDER_TRACKS_PLAYLIST_NAME's doc above
        continue;
      }
      node.children.push(buildNode(child, [...segments, child.name]));
    }

    if (!rbNode.isFolder) {
      node.tracks.push(...tracksForPlaylist(rbNode.id));
    }

    return node;
  }

  const root = emptyNode('', []);
  for (const rbNode of childrenByParentId.get(0) ?? []) {
    if (!rbNode.isFolder && rbNode.name === FOLDER_TRACKS_PLAYLIST_NAME) {
      // Unusual (this convention is normally per-folder, not top-level)
      // but handled the same way for consistency rather than left to
      // show up as a stray top-level "_FolderTracks" playlist.
      root.tracks.push(...tracksForPlaylist(rbNode.id));
      continue;
    }
    root.children.push(buildNode(rbNode, [rbNode.name]));
  }

  return {
    root,
    generatedAt: new Date().toISOString(),
    sourceType: 'rekordbox-playlists',
    orphanedEntryCount,
  };
}
