import fc from 'fast-check';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { readDatabaseV2 } from '../src/serato/databaseV2Reader';
import { writeDatabaseV2 } from '../src/serato/databaseV2Writer';

/**
 * Property-based round-trip test for the database V2 writer (Phase 3b
 * Deliverable 3, docs/roadmap.md), same rationale as
 * crateDatabaseWriter.property.test.ts for Phase 2: the hand-picked
 * suite already proves the format is right; this generates many random
 * shapes to check the property that actually distinguishes this writer
 * from the crate writer -- deduplication -- holds at a scale no one
 * would hand-write fixtures for.
 *
 * Model: a pool of N distinct real tracks, each independently assigned
 * to a random non-empty subset of a fixed set of crate names (so a
 * track can land in 1, 2, or every crate). This is exactly the "same
 * track referenced from multiple crates" shape the crate writer treats
 * as one-file-per-crate and this writer must collapse to one entry.
 */

const CRATE_NAMES = ['House', 'Techno', 'Favorites', 'Gig Prep', 'Deep Cuts'];

interface TrackAssignment {
  filename: string;
  crateIndices: number[]; // which of CRATE_NAMES this track belongs to (>= 1 entry)
}

const assignmentArbitrary: fc.Arbitrary<TrackAssignment> = fc
  .tuple(
    fc.uuid(),
    fc.uniqueArray(fc.integer({ min: 0, max: CRATE_NAMES.length - 1 }), { minLength: 1, maxLength: CRATE_NAMES.length })
  )
  .map(([uuid, crateIndices]) => ({ filename: `${uuid}.mp3`, crateIndices }));

const assignmentsArbitrary: fc.Arbitrary<TrackAssignment[]> = fc.uniqueArray(assignmentArbitrary, {
  minLength: 1,
  maxLength: 10,
  selector: (a) => a.filename,
});

async function touch(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
}

describe('writeDatabaseV2 (property-based round-trip)', () => {
  it('writes exactly one entry per unique track regardless of how many crates it appears in', async () => {
    await fc.assert(
      fc.asyncProperty(assignmentsArbitrary, async (assignments) => {
        const volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-dbv2-prop-'));
        try {
          const seratoDir = path.join(volumeRoot, '_Serato_');

          const tracksByFilename = new Map<string, TrackRef>();
          for (const a of assignments) {
            const sourcePath = path.join(volumeRoot, 'Inbox', a.filename);
            await touch(sourcePath);
            tracksByFilename.set(a.filename, {
              id: idForPath(sourcePath),
              sourcePath,
              filename: a.filename,
              ext: '.mp3',
            });
          }

          const children: CanonicalNode[] = CRATE_NAMES.map((name, crateIndex) => {
            const tracksInThisCrate = assignments
              .filter((a) => a.crateIndices.includes(crateIndex))
              .map((a) => tracksByFilename.get(a.filename)!);
            return { ...emptyNode(name, [name]), tracks: tracksInThisCrate };
          });

          const tree: CanonicalTree = {
            generatedAt: new Date().toISOString(),
            sourceType: 'serato-crates',
            root: { ...emptyNode('', []), children },
          };

          const result = await writeDatabaseV2(tree, seratoDir, { volumeRoot });

          // The whole point: trackCount is the number of DISTINCT tracks,
          // not the number of (track, crate) memberships in the tree.
          expect(result.trackCount).toBe(assignments.length);

          const readBack = await readDatabaseV2(result.filePath);
          expect(readBack.tracks).toHaveLength(assignments.length);

          const expectedPaths = new Set(assignments.map((a) => `Inbox/${a.filename}`));
          const actualPaths = new Set(readBack.tracks.map((t) => t.rawPath));
          expect(actualPaths).toEqual(expectedPaths);
        } finally {
          await fs.rm(volumeRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 }
    );
  }, 60_000);
});
