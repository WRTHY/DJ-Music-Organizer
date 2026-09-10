import os from 'node:os';
import path from 'node:path';
import { buildCanonicalTreeFromPlaylists } from '../src/rekordbox/canonicalTree';
import { RekordboxPlaylistEntry, RekordboxPlaylistNode, RekordboxTrack } from '../src/rekordbox/pdbReader';
import { allTracks } from '../src/types';

/**
 * Unlike pdbReader.test.ts, this operates on plain typed arrays rather
 * than a synthetic binary buffer -- buildCanonicalTreeFromPlaylists's job
 * is joining and reshaping already-parsed data, not decoding the .pdb
 * format itself (that's what pdbReader.test.ts already covers). The
 * join/hierarchy/quirk-handling logic here was additionally sanity-
 * checked against a real 3,549-track / 431-node export before being
 * written -- see docs/decisions.md, 2026-09-10.
 */

const volumeRoot = path.resolve(os.tmpdir(), 'mlo-rekordbox-tree-test');

function track(id: number, filePath: string): RekordboxTrack {
  return { id, filePath, fileName: path.basename(filePath) };
}

function node(id: number, parentId: number, name: string, isFolder: boolean, sortOrder = 0): RekordboxPlaylistNode {
  return { id, parentId, name, isFolder, sortOrder };
}

function entry(playlistId: number, trackId: number, entryIndex: number): RekordboxPlaylistEntry {
  return { playlistId, trackId, entryIndex };
}

describe('buildCanonicalTreeFromPlaylists', () => {
  it('builds a top-level playlist with its tracks resolved against volumeRoot', () => {
    const tracks = [track(1, '/Open Decks/Chill Trap House/a.mp3')];
    const tree = buildCanonicalTreeFromPlaylists(
      tracks,
      [node(1, 0, 'Chill Trap House', false)],
      [entry(1, 1, 0)],
      { volumeRoot }
    );

    expect(tree.sourceType).toBe('rekordbox-playlists');
    expect(tree.orphanedEntryCount).toBe(0);
    expect(tree.root.children).toHaveLength(1);
    const playlist = tree.root.children[0];
    expect(playlist.name).toBe('Chill Trap House');
    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.tracks[0].sourcePath).toBe(
      path.resolve(volumeRoot, 'Open Decks/Chill Trap House/a.mp3')
    );
    expect(playlist.tracks[0].filename).toBe('a.mp3');
  });

  it('nests a folder and its child playlist to match parentId links', () => {
    const tracks = [track(1, '/Contents/a.mp3')];
    const tree = buildCanonicalTreeFromPlaylists(
      tracks,
      [node(5, 0, 'WRTHY_all', true), node(6, 5, 'Artists', true), node(7, 6, 'Lost Frequencies', false)],
      [entry(7, 1, 0)],
      { volumeRoot }
    );

    const wrthy = tree.root.children[0];
    expect(wrthy.name).toBe('WRTHY_all');
    const artists = wrthy.children[0];
    expect(artists.name).toBe('Artists');
    const lostFrequencies = artists.children[0];
    expect(lostFrequencies.name).toBe('Lost Frequencies');
    expect(lostFrequencies.tracks).toHaveLength(1);
    expect(lostFrequencies.path).toEqual(['WRTHY_all', 'Artists', 'Lost Frequencies']);
  });

  it("folds a folder's hidden _FolderTracks playlist into the folder itself, without showing it as a subfolder", () => {
    const tracks = [track(100, '/Contents/direct.mp3')];
    const tree = buildCanonicalTreeFromPlaylists(
      tracks,
      [
        node(9, 0, 'Unsorted New Music', true),
        node(28, 9, '_FolderTracks', false, 0),
        node(29, 9, 'Rave Booty', false, 1),
      ],
      [entry(28, 100, 0)],
      { volumeRoot }
    );

    const folder = tree.root.children[0];
    expect(folder.name).toBe('Unsorted New Music');
    expect(folder.tracks).toHaveLength(1);
    expect(folder.tracks[0].filename).toBe('direct.mp3');
    expect(folder.children.map((c) => c.name)).toEqual(['Rave Booty']);
  });

  it("drops an entry referencing a track or playlist id this export doesn't have, and counts it", () => {
    const tree = buildCanonicalTreeFromPlaylists(
      [],
      [node(1, 0, 'X', false)],
      [entry(1, 999, 0), entry(404, 1, 0)],
      { volumeRoot }
    );

    expect(tree.orphanedEntryCount).toBe(2);
    expect(tree.root.children[0].tracks).toHaveLength(0);
  });

  it('keeps a track that belongs to more than one playlist, in both places (same caveat as the Serato crate reader)', () => {
    const tracks = [track(1, '/Contents/shared.mp3')];
    const tree = buildCanonicalTreeFromPlaylists(
      tracks,
      [node(1, 0, 'Playlist A', false), node(2, 0, 'Playlist B', false, 1)],
      [entry(1, 1, 0), entry(2, 1, 0)],
      { volumeRoot }
    );

    const all = allTracks(tree);
    expect(all).toHaveLength(2);
    expect(all[0].track.id).toBe(all[1].track.id);
  });

  it("sorts a playlist's tracks by entryIndex, not the order entries were given in", () => {
    const tracks = [track(1, '/Contents/1.mp3'), track(2, '/Contents/2.mp3'), track(3, '/Contents/3.mp3')];
    const tree = buildCanonicalTreeFromPlaylists(
      tracks,
      [node(1, 0, 'Ordered', false)],
      [entry(1, 3, 2), entry(1, 1, 0), entry(1, 2, 1)],
      { volumeRoot }
    );

    expect(tree.root.children[0].tracks.map((t) => t.filename)).toEqual(['1.mp3', '2.mp3', '3.mp3']);
  });

  it('sorts children by sortOrder, not the order nodes were given in', () => {
    const tree = buildCanonicalTreeFromPlaylists(
      [],
      [node(1, 0, 'Second', false, 1), node(2, 0, 'First', false, 0)],
      [],
      { volumeRoot }
    );

    expect(tree.root.children.map((c) => c.name)).toEqual(['First', 'Second']);
  });
});
