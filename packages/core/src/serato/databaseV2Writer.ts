import fs from 'node:fs/promises';
import path from 'node:path';
import { CanonicalTree, TrackRef, allTracks } from '../types';

/**
 * Writer for Serato's `database V2` format -- the from-scratch,
 * blank-drive-only half of Phase 3b (docs/roadmap.md, Deliverable 3).
 * Deliberately NOT the general case: this only ever creates a
 * `database V2` where none exists yet, the same "closer to what Serato
 * itself does meeting new media for the first time" framing the roadmap
 * uses to keep this out of Phase 4's much higher-risk territory (editing
 * James's live, in-daily-use database). Writing into a drive that
 * already has one is a genuinely harder merge problem -- reconciling
 * extra crates/cues/play counts Serato itself may have written since --
 * deliberately deferred; `writeDatabaseV2` refuses outright rather than
 * guessing (see the existing-file check below), the same way this
 * writer's *caller* is expected to per the roadmap's Deliverable 4, but
 * enforced here too rather than trusted to every caller.
 *
 * Field set per track is deliberately minimal, not a full reproduction
 * of what a real Serato scan writes: `pfil` (the track path) and `ttyp`
 * (the file extension) only -- see docs/serato-database-v2-format.md's
 * "required vs. displayed fields" finding. Serato's own "rebuilding the
 * database" support article implies a normal library scan regenerates
 * everything else (title/artist/BPM/etc.) from the files themselves, so
 * this writer leans on that rather than reproducing a full scan's output
 * here. This is exactly the hypothesis Phase 3b's Deliverable 5 hardware
 * checkpoint exists to test -- if a real burned drive needs more than
 * this to show up correctly, that checkpoint is where it'll be found,
 * not a reason to pre-emptively guess at more fields now.
 *
 * Unlike `crateDatabaseWriter.ts`, root-level tracks (ones directly on
 * the tree's root node, not inside any crate) are NOT skipped here --
 * `database V2` has no concept of "which crate," so every track the
 * canonical tree knows about, crated or not, belongs in it. See
 * `buildUniqueTrackList`'s doc for the other, more consequential way
 * this writer's shape differs from the crate writer's: deduplication.
 */

const DATABASE_V2_VERSION_PAYLOAD = '2.0/Serato Scratch LIVE Database';
export const DATABASE_V2_FILENAME = 'database V2';

export interface DatabaseV2WriteOptions {
  /**
   * Same meaning as CrateWriteOptions.volumeRoot on the crate writer:
   * the folder written track paths are made relative to -- i.e. the
   * parent of `_Serato_`. Every track's sourcePath must live under this
   * root, or writing fails loudly rather than writing a path Serato
   * can't resolve.
   */
  volumeRoot: string;
}

export interface DatabaseV2WriteResult {
  /** Absolute path of the file written. */
  filePath: string;
  /** Count of unique tracks written -- see buildUniqueTrackList's dedup. */
  trackCount: number;
}

/**
 * Writes a fresh `database V2` file into `seratoDir` (an existing
 * `_Serato_` folder, or one that will be created) from a CanonicalTree.
 * Refuses if a `database V2` already exists there already -- see the
 * module doc for why merging into an existing one is out of scope here.
 */
export async function writeDatabaseV2(
  tree: CanonicalTree,
  seratoDir: string,
  options: DatabaseV2WriteOptions
): Promise<DatabaseV2WriteResult> {
  const resolvedVolumeRoot = path.resolve(options.volumeRoot);
  const filePath = path.join(seratoDir, DATABASE_V2_FILENAME);

  const alreadyExists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(
      `Refusing to write "${filePath}" -- a database V2 file already exists there. This writer ` +
        'only ever creates one from nothing on a blank drive; merging into an existing database ' +
        'V2 (reconciling crates/cues/play counts Serato itself may have written since) is a ' +
        'deliberately separate, harder problem left for a later phase -- see the module doc.'
    );
  }

  await fs.mkdir(seratoDir, { recursive: true });

  const uniqueTracks = buildUniqueTrackList(tree);
  const relativeTracks = uniqueTracks.map((t) => ({
    relativePath: toRelativePath(t.sourcePath, resolvedVolumeRoot),
    ext: t.ext,
  }));

  const buffer = buildDatabaseV2Buffer(relativeTracks);
  await fs.writeFile(filePath, buffer);

  return { filePath, trackCount: uniqueTracks.length };
}

/**
 * `database V2` is a flat master index of unique files, not a per-crate
 * structure like `.crate` -- confirmed in docs/serato-database-v2-format.md
 * (no crate membership is encoded in it at all). The crate writer
 * deliberately writes the SAME track into every crate file it belongs to
 * (one crate = one folder, docs/decisions.md 2026-09-01: multi-crate
 * membership), but a track referenced from several crates in the
 * canonical tree must appear here exactly ONCE. Written without this
 * dedup step, a track in N crates would produce N `otrk` entries for the
 * same physical file -- not a format violation (the container framing
 * would still be perfectly valid), but a duplicate library entry Serato
 * has no reason to expect and this project has never observed in a real
 * file: every real `otrk` in James's actual library maps to a distinct
 * path (11,991 tracks, 11,991 distinct `pfil` values).
 */
function buildUniqueTrackList(tree: CanonicalTree): TrackRef[] {
  const byId = new Map<string, TrackRef>();
  for (const { track } of allTracks(tree)) {
    if (!byId.has(track.id)) {
      byId.set(track.id, track);
    }
  }
  return [...byId.values()];
}

/**
 * Mirrors the crate writer's toRelativePath exactly -- track paths are
 * relative to volumeRoot, forward slashes, no drive letter, confirmed
 * against a real `database V2` file's `pfil` values in
 * docs/serato-database-v2-format.md.
 */
function toRelativePath(sourcePath: string, volumeRoot: string): string {
  const relative = path.relative(volumeRoot, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Track "${sourcePath}" is not under the volume root "${volumeRoot}" -- every track written ` +
        'into a database V2 file must live on the same volume the database is on.'
    );
  }
  return relative.split(path.sep).join('/');
}

function buildDatabaseV2Buffer(tracks: Array<{ relativePath: string; ext: string }>): Buffer {
  const vrsn = buildChunk('vrsn', encodeUtf16BE(DATABASE_V2_VERSION_PAYLOAD));
  const trackChunks = tracks.map(buildTrackEntryChunk);
  return Buffer.concat([vrsn, ...trackChunks]);
}

function buildTrackEntryChunk(t: { relativePath: string; ext: string }): Buffer {
  const fileType = t.ext.startsWith('.') ? t.ext.slice(1) : t.ext;
  const fields = Buffer.concat([
    buildChunk('pfil', encodeUtf16BE(t.relativePath)),
    buildChunk('ttyp', encodeUtf16BE(fileType)),
  ]);
  return buildChunk('otrk', fields);
}

/** Same container format as `.crate` files -- see databaseV2Reader.ts and
 * docs/serato-database-v2-format.md. */
function buildChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Inverse of the reader's decodeUtf16BE -- Node has no built-in BE
 * encoder, so this encodes as UTF-16LE and byte-swaps each pair. */
function encodeUtf16BE(str: string): Buffer {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}
