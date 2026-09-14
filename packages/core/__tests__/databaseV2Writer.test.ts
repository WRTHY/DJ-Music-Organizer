import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { parseRawDatabaseV2Records, readDatabaseV2 } from '../src/serato/databaseV2Reader';
import { writeDatabaseV2 } from '../src/serato/databaseV2Writer';

/**
 * Minimal, deliberately independent re-implementation of the chunk/UTF-16BE
 * encoding the writer itself uses internally -- kept separate (not
 * imported from the writer) so these tests build their fixture bytes the
 * same way a REAL Serato-written record would look, rather than only ever
 * proving the writer agrees with itself. Mirrors the real ~35-field
 * records this project inspected directly off James's hardware (see
 * docs/serato-database-v2-format.md and the 2026-09-14 decisions.md entry
 * for the field list a real post-analysis record carries: uadd, bmis,
 * bbgl, tsng, etc. alongside pfil/ttyp).
 */
function testEncodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function testBuildChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * Builds a raw `otrk` payload with a realistic superset of fields -- the
 * kind Serato's own scanner writes after actually analyzing a track, not
 * this project's minimal `pfil`+`ttyp` synthesis -- so the carry-forward
 * tests below prove real analysis-state fields (uadd/bmis/bbgl) survive
 * byte-for-byte, not just the two fields this writer already knows how to
 * produce on its own.
 */
function buildFakeAnalyzedRecord(opts: { pfil: string; ttyp: string; tsng: string; dateAdded: number; missing: boolean; beatgridLocked: boolean }): Buffer {
  const uadd = Buffer.alloc(4);
  uadd.writeUInt32BE(opts.dateAdded, 0);
  return Buffer.concat([
    testBuildChunk('pfil', testEncodeUtf16BE(opts.pfil)),
    testBuildChunk('ttyp', testEncodeUtf16BE(opts.ttyp)),
    testBuildChunk('tsng', testEncodeUtf16BE(opts.tsng)),
    testBuildChunk('uadd', uadd),
    testBuildChunk('bmis', Buffer.from([opts.missing ? 1 : 0])),
    testBuildChunk('bbgl', Buffer.from([opts.beatgridLocked ? 1 : 0])),
  ]);
}

/**
 * Round-trip suite for the database V2 writer (Phase 3b Deliverable 3,
 * docs/roadmap.md): build a canonical tree by hand -> write it as a real
 * `database V2` file -> read it back with the already-trusted reader ->
 * assert the tracks match. Same trust-gate pattern
 * crateDatabaseWriter.test.ts established for Phase 2.
 */

function track(sourcePath: string): TrackRef {
  return {
    id: idForPath(sourcePath),
    sourcePath,
    filename: path.basename(sourcePath),
    ext: path.extname(sourcePath).toLowerCase(),
  };
}

function node(name: string, segments: string[], tracks: TrackRef[] = [], children: CanonicalNode[] = []): CanonicalNode {
  return { ...emptyNode(name, segments), tracks, children };
}

describe('writeDatabaseV2 (round-trip against the trusted reader)', () => {
  let volumeRoot: string;
  let seratoDir: string;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-dbv2-write-volume-'));
    seratoDir = path.join(volumeRoot, '_Serato_');
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
  });

  it('writes one otrk per unique track, including root-level (uncrated) tracks', async () => {
    const rootTrack = track(path.join(volumeRoot, 'Inbox', 'loose-track.mp3'));
    const houseTrack = track(path.join(volumeRoot, 'Inbox', '01 - Track One.wav'));
    const deepHouseTrack = track(path.join(volumeRoot, 'Inbox', '02 - Track Two.mp3'));

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [rootTrack], [
        node('House', ['House'], [houseTrack], [
          node('Deep House', ['House', 'Deep House'], [deepHouseTrack]),
        ]),
      ]),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });

    expect(result.filePath).toBe(path.join(seratoDir, 'database V2'));
    expect(result.trackCount).toBe(3); // root-level track included, unlike the crate writer

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(readBack.tracks).toHaveLength(3);

    const byPath = new Map(readBack.tracks.map((t) => [t.rawPath, t]));
    expect(byPath.get('Inbox/loose-track.mp3')).toMatchObject({ fileType: 'mp3' });
    expect(byPath.get('Inbox/01 - Track One.wav')).toMatchObject({ fileType: 'wav' });
    expect(byPath.get('Inbox/02 - Track Two.mp3')).toMatchObject({ fileType: 'mp3' });
  });

  it('deduplicates a track referenced from multiple crates into exactly one entry', async () => {
    const sharedTrack = track(path.join(volumeRoot, 'Inbox', 'shared.mp3'));

    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [
        node('House', ['House'], [sharedTrack]),
        node('Favorites', ['Favorites'], [sharedTrack]),
      ]),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });
    expect(result.trackCount).toBe(1);

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.tracks).toHaveLength(1);
    expect(readBack.tracks[0].rawPath).toBe('Inbox/shared.mp3');
  });

  it('writes a valid, empty (zero-track) database V2 rather than refusing', async () => {
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', []),
    };

    const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });
    expect(result.trackCount).toBe(0);

    const readBack = await readDatabaseV2(result.filePath);
    expect(readBack.versionString).toBe('2.0/Serato Scratch LIVE Database');
    expect(readBack.tracks).toEqual([]);
  });

  it('refuses to write when a database V2 file already exists at the target, rather than merging or overwriting', async () => {
    const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [t]),
    };

    await writeDatabaseV2(tree, seratoDir, { volumeRoot });

    await expect(writeDatabaseV2(tree, seratoDir, { volumeRoot })).rejects.toThrow(
      /already exists/
    );
  });

  it('rejects a track whose source path is not under the given volume root', async () => {
    const outsideTrack = track(path.join(os.tmpdir(), 'somewhere-else', 'track.mp3'));
    const tree: CanonicalTree = {
      generatedAt: new Date().toISOString(),
      sourceType: 'serato-crates',
      root: node('', [], [], [node('Misc', ['Misc'], [outsideTrack])]),
    };

    await expect(writeDatabaseV2(tree, seratoDir, { volumeRoot })).rejects.toThrow(/volume root/);
  });

  /**
   * Phase 3b's hardware checkpoint (Deliverable 5) revealed that a blank
   * drive burned with only `pfil`+`ttyp` per track, while enough for the
   * folders/tracks to simply show up, makes Serato re-analyze all of them
   * -- see docs/decisions.md, 2026-09-14. These tests prove the fix:
   * carrying an already-analyzed track's full original record forward
   * (options.sourceRecords) instead of resynthesizing a minimal one.
   */
  describe('sourceRecords carry-forward (2026-09-14 fix)', () => {
    it('preserves every field of a matching source record byte-for-byte except pfil, and reports it in preservedCount', async () => {
      const sourcePath = path.join(volumeRoot, 'Inbox', 'analyzed-track.mp3');
      const t = track(sourcePath);
      const tree: CanonicalTree = {
        generatedAt: new Date().toISOString(),
        sourceType: 'serato-crates',
        root: node('', [], [t]),
      };

      // Deliberately a DIFFERENT path than what toRelativePath would
      // compute from sourcePath -- proves pfil gets overwritten to the
      // new destination path rather than the stale original value
      // leaking through.
      const originalRecord = buildFakeAnalyzedRecord({
        pfil: 'SomeOldLocation/analyzed-track.mp3',
        ttyp: 'mp3',
        tsng: 'My Analyzed Song',
        dateAdded: 1234567890,
        missing: false,
        beatgridLocked: true,
      });
      const sourceRecords = new Map<string, Buffer>([[path.resolve(sourcePath), originalRecord]]);

      const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot, sourceRecords });
      expect(result.trackCount).toBe(1);
      expect(result.preservedCount).toBe(1);

      const readBack = await readDatabaseV2(result.filePath);
      expect(readBack.tracks).toHaveLength(1);
      expect(readBack.tracks[0]).toMatchObject({
        rawPath: 'Inbox/analyzed-track.mp3', // pfil correctly repointed at the new destination
        fileType: 'mp3',
        title: 'My Analyzed Song',
        dateAdded: 1234567890,
        missing: false,
      });

      // Byte-for-byte check on every field EXCEPT pfil, using the same
      // raw-record reader the fix itself relies on -- proves the fields
      // this project's named-field reader doesn't even decode (bbgl here)
      // still survived untouched, not just the ones checked above.
      const outputBuffer = await fs.readFile(result.filePath);
      const outputRecords = parseRawDatabaseV2Records(outputBuffer, volumeRoot);
      const outputRecord = outputRecords.get(path.resolve(sourcePath));
      expect(outputRecord).toBeDefined();

      const stripPfil = (payload: Buffer) => {
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset + 8 <= payload.length) {
          const tag = payload.toString('ascii', offset, offset + 4);
          const len = payload.readUInt32BE(offset + 4);
          const end = offset + 8 + len;
          if (tag !== 'pfil') chunks.push(payload.subarray(offset, end));
          offset = end;
        }
        return Buffer.concat(chunks);
      };
      expect(stripPfil(outputRecord!).equals(stripPfil(originalRecord))).toBe(true);
    });

    it('falls back to the minimal pfil+ttyp synthesis for a track with no matching sourceRecords entry', async () => {
      const newTrackPath = path.join(volumeRoot, 'Inbox', 'brand-new-track.mp3');
      const t = track(newTrackPath);
      const tree: CanonicalTree = {
        generatedAt: new Date().toISOString(),
        sourceType: 'serato-crates',
        root: node('', [], [t]),
      };

      // A non-empty sourceRecords map, but keyed to a totally different
      // path -- proves the lookup is per-track, not "any sourceRecords
      // present means preserve everything."
      const unrelatedRecord = buildFakeAnalyzedRecord({
        pfil: 'Somewhere/else.mp3',
        ttyp: 'mp3',
        tsng: 'Unrelated Song',
        dateAdded: 1,
        missing: false,
        beatgridLocked: false,
      });
      const sourceRecords = new Map<string, Buffer>([
        [path.resolve(volumeRoot, 'Somewhere', 'else.mp3'), unrelatedRecord],
      ]);

      const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot, sourceRecords });
      expect(result.trackCount).toBe(1);
      expect(result.preservedCount).toBe(0);

      const readBack = await readDatabaseV2(result.filePath);
      expect(readBack.tracks).toHaveLength(1);
      expect(readBack.tracks[0]).toMatchObject({
        rawPath: 'Inbox/brand-new-track.mp3',
        fileType: 'mp3',
      });
      // None of the analysis-state fields synthesized -- there was
      // nothing to carry forward for a genuinely new track.
      expect(readBack.tracks[0].title).toBeUndefined();
      expect(readBack.tracks[0].dateAdded).toBeUndefined();
    });

    it('omitting sourceRecords entirely behaves exactly as before this option existed', async () => {
      const t = track(path.join(volumeRoot, 'Inbox', 'track.mp3'));
      const tree: CanonicalTree = {
        generatedAt: new Date().toISOString(),
        sourceType: 'serato-crates',
        root: node('', [], [t]),
      };

      const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });
      expect(result.preservedCount).toBe(0);
      expect(result.trackCount).toBe(1);
    });
  });
});
