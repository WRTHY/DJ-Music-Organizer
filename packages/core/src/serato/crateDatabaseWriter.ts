import fs from 'node:fs/promises';
import path from 'node:path';
import { CanonicalNode, CanonicalTree, TrackRef, walkTree } from '../types';

/**
 * Writer for Serato's crate-database format -- the inverse of
 * crateDatabaseReader.ts. Same format, same source of truth: see
 * docs/serato-crate-format.md for what's been validated against a real
 * library (chunk framing, `otrk`/`ptrk` nesting, UTF-16BE encoding, the
 * `%%`-hierarchy filename convention, and the "paths are relative to the
 * parent of `_Serato_`" volume-root rule).
 *
 * This is Phase 2 of docs/roadmap.md -- the highest-risk piece of
 * engineering in this project, because a bug here writes a corrupted
 * binary file into a crate database. It must NEVER be pointed at James's
 * real `_Serato_` folder directly; the only path to that is "burn to
 * flash" onto a scratch/target volume (Phase 3), proven by round-trip
 * tests (write, then read back with the trusted reader, then diff) before
 * it's trusted at all, plus one manual checkpoint against real Serato.
 *
 * One node = one crate file, matching the reader's "one crate = one
 * folder" model (docs/decisions.md, 2026-09-01): every CanonicalNode with
 * at least one direct track becomes exactly one `.crate` file, named by
 * joining its path segments with `%%`. A node with only children and no
 * direct tracks doesn't get its own file -- Serato's crate tree UI infers
 * folder structure purely from filename prefixes, so an empty
 * intermediate "folder" needs no file to exist.
 *
 * A related, sharper limitation that property-based testing surfaced
 * (see __tests__/crateDatabaseWriter.property.test.ts): a node with no
 * tracks anywhere in its own subtree -- not just directly on it, but on
 * every descendant too -- writes NO file at all, and so does not survive
 * a round trip through this format. This is not a bug to fix; there is
 * no file that could represent a wholly empty folder, since the folder
 * concept itself is 100% inferred from "%%"-prefixes of files that
 * actually exist. A caller relying on a canonical tree's exact shape
 * surviving a burn (e.g. for a diff-based incremental re-burn, Phase 3)
 * needs to account for this: fully-empty branches just disappear.
 */

const CRATE_VERSION_PAYLOAD = '1.0/Serato ScratchLive Crate';

export interface CrateWriteOptions {
  /**
   * Same meaning as CrateDatabaseOptions.volumeRoot on the reader: the
   * folder written track paths are made relative to -- i.e. the parent of
   * `_Serato_`. Every track's sourcePath must live under this root, or
   * writing fails loudly (see toRelativePath below) rather than writing
   * a path Serato can't resolve.
   */
  volumeRoot: string;
}

export interface CrateWriteResult {
  /** Absolute paths of every .crate file actually written, in tree order. */
  filesWritten: string[];
  /**
   * Tracks that live directly on the tree's root node (path = []) rather
   * than inside any named folder. Serato's Subcrates model has no
   * "uncrated" bucket -- every crate is a named .crate file -- so these
   * can't be written as-is. Returned rather than silently dropped, so a
   * caller can decide what to do (surface a warning, refuse to proceed);
   * silently losing tracks from a 5-year library on write is exactly the
   * failure mode this whole module exists to avoid.
   */
  skippedRootTracks: TrackRef[];
}

/**
 * Writes a CanonicalTree out as a full Serato crate database: one
 * `.crate` file per node that has direct tracks, into `subcratesDir`
 * (created if it doesn't exist). Does not touch anything outside
 * `subcratesDir` -- it does not copy audio files, and it does not modify
 * any `.crate` file this run doesn't itself write to.
 */
export async function writeCrateDatabase(
  tree: CanonicalTree,
  subcratesDir: string,
  options: CrateWriteOptions
): Promise<CrateWriteResult> {
  const resolvedVolumeRoot = path.resolve(options.volumeRoot);
  await fs.mkdir(subcratesDir, { recursive: true });

  const nodesToWrite: CanonicalNode[] = [];
  const skippedRootTracks: TrackRef[] = [];

  walkTree(tree.root, (node) => {
    if (node.tracks.length === 0) return;
    if (node.path.length === 0) {
      skippedRootTracks.push(...node.tracks);
      return;
    }
    nodesToWrite.push(node);
  });

  const filesWritten: string[] = [];
  const claimedFilenames = new Set<string>();
  for (const node of nodesToWrite) {
    const filename = crateFilenameForPath(node.path);
    if (claimedFilenames.has(filename)) {
      throw new Error(
        `Two different folders in this tree both map to the crate file "${filename}" -- writing ` +
          'both would silently overwrite the first with the second, losing its tracks. This ' +
          'usually means two sibling folders share the same name somewhere in the tree, which ' +
          'should never happen in a well-formed canonical tree.'
      );
    }
    claimedFilenames.add(filename);

    const relativePaths = node.tracks.map((track) => toRelativePath(track.sourcePath, resolvedVolumeRoot));
    const buffer = buildCrateBuffer(relativePaths);
    const filePath = path.join(subcratesDir, filename);
    assertStaysUnderRoot(filePath, subcratesDir, filename);
    await fs.writeFile(filePath, buffer);
    filesWritten.push(filePath);
  }

  return { filesWritten, skippedRootTracks };
}

/**
 * Builds the `.crate` filename for a node's path segments. Guards against
 * a folder name that itself contains "%%" -- the hierarchy separator --
 * since writing one would silently corrupt the structure on read-back
 * (segmentsFromCrateFilename would split a name that was meant to stay
 * one segment). This is a real format limitation, not a hypothetical one,
 * so it's checked here rather than left to be discovered via a failed
 * round-trip test.
 */
function crateFilenameForPath(segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes('%%')) {
      throw new Error(
        `Folder name "${segment}" contains "%%", which Serato's crate format uses as its own ` +
          'hierarchy separator -- writing it would silently corrupt the crate structure on ' +
          'read-back. Rename the folder before burning to flash.'
      );
    }
    if (segment.includes('/') || segment.includes('\\')) {
      throw new Error(
        `Folder name "${segment}" contains a path separator ("/" or "\\") -- writing it would ` +
          'change WHERE this file lands on disk instead of just naming a crate, since the ' +
          'filename is built by joining path segments together. Rename the folder before ' +
          'burning to flash.'
      );
    }
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Folder name "${segment}" is a path-traversal segment, not a real folder name -- writing ` +
          'it could place the crate file outside the Subcrates folder entirely. Rename the ' +
          'folder before burning to flash.'
      );
    }
  }
  return `${segments.join('%%')}.crate`;
}

/**
 * The same "never write outside the folder we were told to write into"
 * boundary as toRelativePath below, applied to the .crate file's own
 * destination rather than the track path inside it. crateFilenameForPath
 * already rejects the known ways a segment could cause this
 * (separators, ".."), but this is the actual safety net -- it catches
 * any escape regardless of what caused it, the same way
 * planner.ts's assertStaysUnderRoot protects the copy/move path.
 */
function assertStaysUnderRoot(filePath: string, subcratesDir: string, filename: string): void {
  const relative = path.relative(subcratesDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to write "${filePath}" -- it falls outside the Subcrates folder "${subcratesDir}" ` +
        `(computed from filename "${filename}").`
    );
  }
}

/**
 * Mirrors the reader's assumption exactly: track paths are relative to
 * volumeRoot, with forward slashes and no drive letter, regardless of
 * which OS this actually runs on (`path.relative` uses the local
 * separator, so it's normalized explicitly rather than trusted as-is).
 */
function toRelativePath(sourcePath: string, volumeRoot: string): string {
  const relative = path.relative(volumeRoot, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Track "${sourcePath}" is not under the volume root "${volumeRoot}" -- every track written ` +
        'into a crate database must live on the same volume the database is on.'
    );
  }
  return relative.split(path.sep).join('/');
}

function buildCrateBuffer(relativeTrackPaths: string[]): Buffer {
  const vrsn = buildChunk('vrsn', encodeUtf16BE(CRATE_VERSION_PAYLOAD));
  const trackChunks = relativeTrackPaths.map(buildTrackEntryChunk);
  return Buffer.concat([vrsn, ...trackChunks]);
}

function buildTrackEntryChunk(relativePath: string): Buffer {
  const ptrk = buildChunk('ptrk', encodeUtf16BE(relativePath));
  return buildChunk('otrk', ptrk);
}

/** 4-byte ASCII tag + 4-byte big-endian length + payload -- the container
 * format shared by every chunk in the file (see crateDatabaseReader.ts). */
function buildChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Inverse of the reader's decodeUtf16BE: Node has no built-in BE encoder,
 * so this encodes as UTF-16LE and byte-swaps each pair. */
function encodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}
