import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFolderTree } from '../src/serato/folderTreeReader';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mlo-folder-tree-'));
}

describe('readFolderTree', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpDir();
    // root/
    //   House/track1.mp3
    //   House/Deep House/track2.mp3
    //   Techno/track3.wav
    //   readme.txt   <- not audio, should be ignored
    await fs.mkdir(path.join(root, 'House', 'Deep House'), { recursive: true });
    await fs.mkdir(path.join(root, 'Techno'), { recursive: true });
    await fs.writeFile(path.join(root, 'House', 'track1.mp3'), 'fake-mp3-1');
    await fs.writeFile(path.join(root, 'House', 'Deep House', 'track2.mp3'), 'fake-mp3-2');
    await fs.writeFile(path.join(root, 'Techno', 'track3.wav'), 'fake-wav-1');
    await fs.writeFile(path.join(root, 'readme.txt'), 'not audio');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds a canonical tree matching the folder structure', async () => {
    const tree = await readFolderTree(root);

    expect(tree.sourceType).toBe('serato-folders');
    expect(tree.root.tracks).toHaveLength(0); // no audio directly at root
    expect(tree.root.children.map((c) => c.name).sort()).toEqual(['House', 'Techno']);

    const house = tree.root.children.find((c) => c.name === 'House')!;
    expect(house.tracks.map((t) => t.filename)).toEqual(['track1.mp3']);
    expect(house.path).toEqual(['House']);

    const deepHouse = house.children.find((c) => c.name === 'Deep House')!;
    expect(deepHouse.tracks.map((t) => t.filename)).toEqual(['track2.mp3']);
    expect(deepHouse.path).toEqual(['House', 'Deep House']);

    const techno = tree.root.children.find((c) => c.name === 'Techno')!;
    expect(techno.tracks.map((t) => t.filename)).toEqual(['track3.wav']);
  });

  it('ignores non-audio files', async () => {
    const tree = await readFolderTree(root);
    const allFilenames = JSON.stringify(tree);
    expect(allFilenames).not.toContain('readme.txt');
  });

  it('gives every track a stable id derived from its path', async () => {
    const tree1 = await readFolderTree(root);
    const tree2 = await readFolderTree(root);
    const house1 = tree1.root.children.find((c) => c.name === 'House')!;
    const house2 = tree2.root.children.find((c) => c.name === 'House')!;
    expect(house1.tracks[0].id).toBe(house2.tracks[0].id);
  });
});
