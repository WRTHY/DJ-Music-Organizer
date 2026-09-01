import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseCrateBuffer,
  segmentsFromCrateFilename,
  readCrateDatabase,
} from '../src/serato/crateDatabaseReader';

/**
 * Builds a synthetic .crate buffer matching the format assumed by
 * crateDatabaseReader.ts (see docs/serato-crate-format.md). This proves
 * the parser is internally consistent with that assumed format — it does
 * NOT prove the assumed format matches real Serato files.
 */
function buildFakeCrateBuffer(trackPaths: string[]): Buffer {
  const chunks: Buffer[] = [];

  for (const trackPath of trackPaths) {
    const pathBuf = encodeUtf16BE(trackPath);
    const ptrkChunk = tlv('ptrk', pathBuf);
    const otrkChunk = tlv('otrk', ptrkChunk);
    chunks.push(otrkChunk);
  }

  return Buffer.concat(chunks);
}

function tlv(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function encodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

describe('segmentsFromCrateFilename', () => {
  it('splits on %% to build the crate hierarchy', () => {
    expect(segmentsFromCrateFilename('House%%Deep House.crate')).toEqual(['House', 'Deep House']);
    expect(segmentsFromCrateFilename('Techno.crate')).toEqual(['Techno']);
  });
});

describe('parseCrateBuffer', () => {
  it('extracts track paths from a synthetic crate buffer', () => {
    const paths = ['House/track1.mp3', 'House/Deep House/track2.mp3'];
    const buffer = buildFakeCrateBuffer(paths);
    expect(parseCrateBuffer(buffer)).toEqual(paths);
  });

  it('returns an empty list for an empty buffer rather than throwing', () => {
    expect(parseCrateBuffer(Buffer.alloc(0))).toEqual([]);
  });

  it('parses a real Serato crate byte layout (verified 2026-09-01 against a live library)', () => {
    // Reproduces the exact header this project's crateDatabaseReader was
    // checked against: a `vrsn` chunk ("1.0/Serato ScratchLive Crate")
    // followed by an `otrk` chunk whose `ptrk` payload is a path relative
    // to the volume root (no drive letter, forward slashes), e.g.
    // "New Music/_2024/Trance/001 - Above & Beyond - Crazy Love.mp3".
    const vrsn = tlv('vrsn', encodeUtf16BE('1.0/Serato ScratchLive Crate'));
    const track = 'New Music/_2024/Trance/001 - Above & Beyond - Crazy Love.mp3';
    const otrk = tlv('otrk', tlv('ptrk', encodeUtf16BE(track)));
    const buffer = Buffer.concat([vrsn, otrk]);

    expect(parseCrateBuffer(buffer)).toEqual([track]);
  });
});

describe('readCrateDatabase', () => {
  let volumeRoot: string;
  let subcratesDir: string;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-volume-'));
    subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
    await fs.mkdir(subcratesDir, { recursive: true });

    // A real file that a crate will point at.
    await fs.mkdir(path.join(volumeRoot, 'House'), { recursive: true });
    await fs.writeFile(path.join(volumeRoot, 'House', 'track1.mp3'), 'fake-mp3-1');

    await fs.writeFile(
      path.join(subcratesDir, 'House.crate'),
      buildFakeCrateBuffer(['House/track1.mp3'])
    );
    await fs.writeFile(
      path.join(subcratesDir, 'House%%Deep House.crate'),
      buildFakeCrateBuffer(['House/does-not-exist.mp3'])
    );
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
  });

  it('builds a canonical tree from crate filenames and contents', async () => {
    const tree = await readCrateDatabase(subcratesDir, { volumeRoot });

    expect(tree.sourceType).toBe('serato-crates');

    const house = tree.root.children.find((c) => c.name === 'House')!;
    expect(house.tracks.map((t) => t.filename)).toEqual(['track1.mp3']);

    const deepHouse = house.children.find((c) => c.name === 'Deep House')!;
    expect(deepHouse.tracks.map((t) => t.filename)).toEqual(['does-not-exist.mp3']);
  });

  it('flags tracks that do not resolve to a real file, instead of dropping them', async () => {
    const tree = await readCrateDatabase(subcratesDir, { volumeRoot });
    expect(tree.unresolvedCount).toBe(1); // does-not-exist.mp3
  });
});
