import { CanonicalTree, allTracks, emptyNode } from '../src/types';
import { filterTreeBySelection, nodeKey } from '../src/organizer/selection';
import { planFromCanonicalTree } from '../src/organizer/planner';

function buildTree(): CanonicalTree {
  // root/
  //   House/track1.mp3
  //   House/Deep House/track2.mp3
  //   Techno/track3.mp3
  const root = emptyNode('', []);
  const house = emptyNode('House', ['House']);
  house.tracks.push({ id: 't1', sourcePath: '/lib/House/track1.mp3', filename: 'track1.mp3', ext: '.mp3' });
  const deepHouse = emptyNode('Deep House', ['House', 'Deep House']);
  deepHouse.tracks.push({
    id: 't2',
    sourcePath: '/lib/House/Deep House/track2.mp3',
    filename: 'track2.mp3',
    ext: '.mp3',
  });
  house.children.push(deepHouse);
  const techno = emptyNode('Techno', ['Techno']);
  techno.tracks.push({ id: 't3', sourcePath: '/lib/Techno/track3.mp3', filename: 'track3.mp3', ext: '.mp3' });
  root.children.push(house, techno);

  return { root, generatedAt: new Date().toISOString(), sourceType: 'serato-folders' };
}

describe('nodeKey', () => {
  it('joins path segments so it can be used as a stable selection key', () => {
    expect(nodeKey(['House', 'Deep House'])).toBe('House/Deep House');
    expect(nodeKey([])).toBe('');
  });
});

describe('filterTreeBySelection', () => {
  it('excludes nothing when the exclusion set is empty', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set());
    expect(allTracks(filtered).map((t) => t.track.id).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('excluding a leaf folder removes only its own tracks', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set([nodeKey(['Techno'])]));
    expect(allTracks(filtered).map((t) => t.track.id).sort()).toEqual(['t1', 't2']);
  });

  it('excluding a folder removes its entire subtree, including nested children', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set([nodeKey(['House'])]));
    // Both House's own track AND Deep House's nested track are gone --
    // there is no way to exclude a parent while keeping a child selected.
    expect(allTracks(filtered).map((t) => t.track.id).sort()).toEqual(['t3']);
    expect(filtered.root.children.map((c) => c.name)).toEqual(['Techno']);
  });

  it('dropped branches do not linger as empty nodes', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set([nodeKey(['House'])]));
    expect(filtered.root.children.some((c) => c.name === 'House')).toBe(false);
  });

  it('excluding everything yields a valid, empty tree rather than throwing', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set([nodeKey(['House']), nodeKey(['Techno'])]));
    expect(allTracks(filtered)).toHaveLength(0);
    expect(filtered.root.children).toHaveLength(0);
  });

  it('a filtered tree plans only the selected tracks -- this is what makes exclusion real', () => {
    const tree = buildTree();
    const filtered = filterTreeBySelection(tree, new Set([nodeKey(['Techno'])]));
    const plan = planFromCanonicalTree(filtered, '/target', 'copy');
    expect(plan.items).toHaveLength(2);
    expect(plan.items.some((i) => i.sourcePath.includes('Techno'))).toBe(false);
  });
});
