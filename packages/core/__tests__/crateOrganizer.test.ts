import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCrateDatabase } from '../src/serato/crateDatabaseReader';
import { planFromCanonicalTree } from '../src/organizer/planner';
import { executePlan } from '../src/organizer/executor';

/**
 * Serato crates aren't exclusive: the same track can be tagged into
 * several crates at once (a genre crate and an artist crate, say). The
 * rule here is deliberately simple: one crate = one folder, full stop —
 * no attempt to pick a single "canonical" home for a track. If a track is
 * in two crates, it gets copied into both folders. See docs/decisions.md.
 */
describe('crate database -> organize plan (multi-crate membership)', () => {
  let volumeRoot: string;
  let subcratesDir: string;
  let targetRoot: string;

  beforeEach(async () => {
    volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-crate-volume-'));
    subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
    await fs.mkdir(subcratesDir, { recursive: true });
    targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-crate-target-'));

    await fs.mkdir(path.join(volumeRoot, 'New Music', '_2024', 'Trance'), { recursive: true });
    await fs.writeFile(
      path.join(volumeRoot, 'New Music', '_2024', 'Trance', 'track1.mp3'),
      'trance-track-content'
    );

    const relPath = 'New Music/_2024/Trance/track1.mp3';
    await fs.writeFile(path.join(subcratesDir, 'Trance.crate'), buildFakeCrate([relPath]));
    await fs.writeFile(
      path.join(subcratesDir, 'Artists%%Above & Beyond.crate'),
      buildFakeCrate([relPath])
    );
  });

  afterEach(async () => {
    await fs.rm(volumeRoot, { recursive: true, force: true });
    await fs.rm(targetRoot, { recursive: true, force: true });
  });

  it('copies a track into every crate-folder it belongs to', async () => {
    const tree = await readCrateDatabase(subcratesDir, { volumeRoot });
    const plan = planFromCanonicalTree(tree, targetRoot, 'copy');

    // Same source file, two separate plan items (one per crate/folder).
    expect(plan.items).toHaveLength(2);
    expect(new Set(plan.items.map((i) => i.sourcePath)).size).toBe(1);

    const report = await executePlan(plan);
    expect(report.summary.copied).toBe(2);

    const inTrance = await fs.readFile(path.join(targetRoot, 'Trance', 'track1.mp3'), 'utf8');
    const inArtists = await fs.readFile(
      path.join(targetRoot, 'Artists', 'Above & Beyond', 'track1.mp3'),
      'utf8'
    );
    expect(inTrance).toBe('trance-track-content');
    expect(inArtists).toBe('trance-track-content');
  });
});

function buildFakeCrate(trackPaths: string[]): Buffer {
  const chunks: Buffer[] = trackPaths.map((p) => tlv('otrk', tlv('ptrk', encodeUtf16BE(p))));
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
