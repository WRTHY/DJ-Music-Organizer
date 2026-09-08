import fc from 'fast-check';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, emptyNode } from '../src/types';
import { idForPath } from '../src/serato/hash';
import { readCrateDatabase } from '../src/serato/crateDatabaseReader';
import { writeCrateDatabase } from '../src/serato/crateDatabaseWriter';

/**
 * Property-based round-trip test for the crate writer (docs/roadmap.md,
 * Phase 2: "worth the setup cost here specifically, because this is a
 * binary format -- the bugs that matter are the ones you didn't think to
 * write a fixture for"). crateDatabaseWriter.test.ts already proves the
 * format is right against hand-picked examples; this generates many
 * random tree shapes and checks the same property holds for all of them:
 * write -> read back with the trusted reader -> identical shape.
 *
 * Deliberately narrower than the hand-picked suite in what it varies. It
 * does not re-explore unicode or the specific rejection cases (a "%%" in
 * a name, a track outside volumeRoot, root-level tracks) -- those are
 * already covered exactly there, and mixing them into the generator would
 * make failures here harder to read, not more thorough. What this adds
 * is structural variety -- depth, branching, track counts per node, and
 * a shared track across many crates -- at a scale no one would hand-write
 * fixtures for. Every generated tree is exactly two levels deep
 * (crate -> subcrate); deeper nesting is already exercised by the
 * hand-picked "House / House%%Deep House" fixture and isn't the axis
 * this suite is adding value on.
 */

const NAME_POOL = [
  'House',
  'Techno',
  'Old School',
  "90's",
  'Peak Time',
  'Warm Up',
  'B2B',
  'Closers',
  'Openers',
  'Gig Prep',
  'Favorites (2024)',
  'Deep Cuts',
];

interface NodeSpec {
  name: string;
  trackCount: number;
  children: NodeSpec[];
}

const grandchildArbitrary: fc.Arbitrary<NodeSpec> = fc
  .record({
    name: fc.constantFrom(...NAME_POOL),
    trackCount: fc.integer({ min: 0, max: 3 }),
  })
  .map((n) => ({ ...n, children: [] }));

const childArbitrary: fc.Arbitrary<NodeSpec> = fc
  .tuple(
    fc.constantFrom(...NAME_POOL),
    fc.integer({ min: 0, max: 3 }),
    fc.uniqueArray(grandchildArbitrary, { maxLength: 2, selector: (n) => n.name })
  )
  .map(([name, trackCount, children]) => ({ name, trackCount, children }));

/** A whole tree's worth of top-level crates, exactly two levels deep. */
const treeSpecArbitrary: fc.Arbitrary<NodeSpec[]> = fc.uniqueArray(childArbitrary, {
  minLength: 1,
  maxLength: 3,
  selector: (n) => n.name,
});

async function touch(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '');
}

/** Turns a NodeSpec tree into a real CanonicalTree, writing a real
 * placeholder file per track under volumeRoot (via a shared counter for
 * globally unique filenames) so the reader's existence check is
 * exercised for real, same as the hand-picked suite. */
async function buildRealNode(
  spec: NodeSpec,
  parentPath: string[],
  volumeRoot: string,
  counter: { next: number }
): Promise<CanonicalNode> {
  const nodePath = [...parentPath, spec.name];
  const tracks: TrackRef[] = [];
  for (let i = 0; i < spec.trackCount; i++) {
    const filename = `track-${counter.next++}.mp3`;
    const sourcePath = path.join(volumeRoot, 'Inbox', filename);
    await touch(sourcePath);
    tracks.push({ id: idForPath(sourcePath), sourcePath, filename, ext: '.mp3' });
  }
  const children: CanonicalNode[] = [];
  for (const childSpec of spec.children) {
    children.push(await buildRealNode(childSpec, nodePath, volumeRoot, counter));
  }
  return { name: spec.name, path: nodePath, tracks, children };
}

/** Order-independent shape, same reasoning as the hand-picked suite:
 * readCrateDatabase doesn't sort crate files before processing, so
 * child/track order isn't guaranteed and shouldn't be asserted on. */
function shape(node: CanonicalNode): unknown {
  return {
    name: node.name,
    path: node.path,
    tracks: [...node.tracks].sort((a, b) => a.filename.localeCompare(b.filename)),
    children: [...node.children]
      .map(shape)
      .sort((a, b) => (a as { name: string }).name.localeCompare((b as { name: string }).name)),
  };
}

/**
 * A genuine round-trip limitation this property test surfaced (not a
 * writer bug): a node with no tracks anywhere in its own subtree writes
 * no ".crate" file at all -- there's nothing for it to write. Unlike the
 * "empty intermediate folder" case in the hand-picked suite (an empty
 * folder with a non-empty *child*, which still gets synthesized on
 * read-back because the child's crate file implies it), a fully empty
 * subtree leaves no file anywhere that could imply it exists, so it
 * simply doesn't come back. Serato's crate format has no way to
 * represent a wholly empty folder -- the folder concept is 100% inferred
 * from "%%"-prefixes of files that actually exist. So the expected shape
 * for a round-trip comparison has to prune fully-empty subtrees first;
 * asserting they survive would be asserting something the format itself
 * cannot do, not testing this codebase.
 */
function pruneEmptySubtrees(node: CanonicalNode): CanonicalNode | null {
  const children = node.children
    .map(pruneEmptySubtrees)
    .filter((c): c is CanonicalNode => c !== null);
  if (node.tracks.length === 0 && children.length === 0) return null;
  return { ...node, children };
}

describe('writeCrateDatabase (property-based round-trip)', () => {
  it('round-trips any generated two-level tree losslessly', async () => {
    await fc.assert(
      fc.asyncProperty(treeSpecArbitrary, async (specs) => {
        const volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-prop-volume-'));
        try {
          const subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
          const counter = { next: 0 };
          const children: CanonicalNode[] = [];
          for (const spec of specs) {
            children.push(await buildRealNode(spec, [], volumeRoot, counter));
          }
          const tree: CanonicalTree = {
            generatedAt: new Date().toISOString(),
            sourceType: 'serato-crates',
            root: { ...emptyNode('', []), children },
          };

          const result = await writeCrateDatabase(tree, subcratesDir, { volumeRoot });
          expect(result.skippedRootTracks).toEqual([]);

          const readBack = await readCrateDatabase(subcratesDir, { volumeRoot });
          expect(readBack.unresolvedCount).toBe(0);
          const prunedOriginal = pruneEmptySubtrees(tree.root) ?? { ...tree.root, children: [] };
          expect(shape(readBack.root)).toEqual(shape(prunedOriginal));
        } finally {
          await fs.rm(volumeRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 }
    );
  }, 60_000);

  it('round-trips the same track shared across any number of crates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...NAME_POOL), { minLength: 2, maxLength: 5, selector: (n) => n }),
        async (crateNames) => {
          const volumeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mlo-prop-shared-'));
          try {
            const subcratesDir = path.join(volumeRoot, '_Serato_', 'Subcrates');
            const sourcePath = path.join(volumeRoot, 'Inbox', 'shared.mp3');
            await touch(sourcePath);
            const sharedTrack: TrackRef = {
              id: idForPath(sourcePath),
              sourcePath,
              filename: 'shared.mp3',
              ext: '.mp3',
            };

            const children: CanonicalNode[] = crateNames.map((name) => ({
              ...emptyNode(name, [name]),
              tracks: [sharedTrack],
            }));
            const tree: CanonicalTree = {
              generatedAt: new Date().toISOString(),
              sourceType: 'serato-crates',
              root: { ...emptyNode('', []), children },
            };

            await writeCrateDatabase(tree, subcratesDir, { volumeRoot });
            const readBack = await readCrateDatabase(subcratesDir, { volumeRoot });

            expect(readBack.unresolvedCount).toBe(0);
            expect(shape(readBack.root)).toEqual(shape(tree.root));
          } finally {
            await fs.rm(volumeRoot, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 25 }
    );
  }, 60_000);
});
