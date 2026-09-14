import fs from 'node:fs/promises';

/**
 * Reader for Serato's `database V2` format -- the master track index
 * Serato actually reads to know a track exists at all, as distinct from
 * the `.crate` files' filtered crate-membership views (see
 * crateDatabaseReader.ts and docs/serato-crate-format.md for those). A
 * track a `.crate` file references but `database V2` has never heard of
 * is invisible in Serato's UI, full stop -- see docs/decisions.md,
 * 2026-09-11 entry.
 *
 * Serato does not publish this format either. Unlike the crate reader,
 * this one was built directly from parsing James's real `database V2`
 * file (byte-by-byte) rather than starting from a secondary source, then
 * cross-checked against one (a DeepWiki analysis of `bvandrc/serato-tools`)
 * that agreed on every point checked. See docs/serato-database-v2-format.md
 * for exactly what was confirmed, including which fields are (and
 * aren't) reliably present, and what's still unidentified.
 *
 * Deliberately flat, unlike `readCrateDatabase`: `database V2` has no
 * folder/crate hierarchy of its own (confirmed -- see the format doc's
 * "does it encode crate membership" question), so there's no tree to
 * build here, just the track list. Resolving `rawPath` against a volume
 * root and wiring this into the organizer/burn flow is later work
 * (Phase 3b, deliverables 3-4 in docs/roadmap.md) -- this reader's job is
 * only to prove the format is understood.
 */

export interface DatabaseV2Track {
  /**
   * Path exactly as stored in the file (the `pfil` field). Confirmed
   * relative, no drive letter, forward slashes -- the same convention as
   * a `.crate` file's `ptrk` path, resolved against the parent directory
   * of `_Serato_`. Empty string if the entry had no `pfil` field at all,
   * which has not been observed in practice but is handled rather than
   * thrown on.
   */
  rawPath: string;
  fileType?: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  bpm?: string;
  key?: string;
  /** Unix timestamp in seconds, from the `uadd` field. */
  dateAdded?: number;
  /** From the `bmis` flag -- Serato's own "file not found at last scan" marker. */
  missing?: boolean;
  /** From the `bcrt` flag. */
  corrupt?: boolean;
}

export interface ParsedDatabaseV2 {
  /** The `vrsn` chunk's text, e.g. "2.0/Serato Scratch LIVE Database". */
  versionString: string;
  tracks: DatabaseV2Track[];
}

/**
 * Maps a track sub-chunk's tag to the `DatabaseV2Track` field it fills,
 * for the tags whose meaning is confirmed (see docs/serato-database-v2-format.md).
 * Tags not listed here are parsed and discarded rather than causing an
 * error -- this reader only carries the fields this project currently
 * has a use for.
 */
const TEXT_FIELDS: Partial<Record<string, keyof DatabaseV2Track>> = {
  ttyp: 'fileType',
  pfil: 'rawPath',
  tsng: 'title',
  tart: 'artist',
  talb: 'album',
  tgen: 'genre',
  tbpm: 'bpm',
  tkey: 'key',
};

/** Decodes a UTF-16BE buffer to a string (Node has no built-in BE decoder). */
function decodeUtf16BE(buf: Buffer): string {
  const swapped = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le');
}

/**
 * Parses one `otrk` chunk's payload into a `DatabaseV2Track`. Field type
 * is inferred from the tag's first letter -- `t*` UTF-16BE text, `u*` a
 * 4-byte big-endian unsigned int, `b*` a 1-byte boolean -- confirmed
 * against a real track entry (docs/serato-database-v2-format.md).
 */
function parseTrackChunk(payload: Buffer): DatabaseV2Track {
  const track: Partial<DatabaseV2Track> = {};
  let offset = 0;

  while (offset + 8 <= payload.length) {
    const tag = payload.toString('ascii', offset, offset + 4);
    const len = payload.readUInt32BE(offset + 4);
    const fieldStart = offset + 8;
    const fieldEnd = fieldStart + len;
    if (len < 0 || fieldEnd > payload.length) break;

    const fieldBuf = payload.subarray(fieldStart, fieldEnd);

    if (tag === 'uadd' && len === 4) {
      track.dateAdded = fieldBuf.readUInt32BE(0);
    } else if (tag === 'bmis' && len === 1) {
      track.missing = fieldBuf[0] !== 0;
    } else if (tag === 'bcrt' && len === 1) {
      track.corrupt = fieldBuf[0] !== 0;
    } else {
      const field = TEXT_FIELDS[tag];
      if (field) {
        (track as Record<string, string>)[field] = decodeUtf16BE(fieldBuf);
      }
    }

    offset = fieldEnd;
  }

  return { rawPath: '', ...track };
}

/**
 * Parses a `database V2` buffer into its version string and full track
 * list. Confirmed against a real 7.96 MB / 11,991-track file: the same
 * outer chunk framing as `.crate` files (4-byte ASCII tag + 4-byte
 * big-endian length), one `vrsn` chunk followed by one `otrk` chunk per
 * track, with every byte of the file accounted for and nothing left
 * over -- see docs/serato-database-v2-format.md.
 */
export function parseDatabaseV2Buffer(buffer: Buffer): ParsedDatabaseV2 {
  const tracks: DatabaseV2Track[] = [];
  let versionString = '';
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    const len = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + len;
    if (len < 0 || payloadEnd > buffer.length) break; // malformed / not this format

    const payload = buffer.subarray(payloadStart, payloadEnd);

    if (tag === 'vrsn') {
      versionString = decodeUtf16BE(payload);
    } else if (tag === 'otrk') {
      tracks.push(parseTrackChunk(payload));
    }

    offset = payloadEnd;
  }

  return { versionString, tracks };
}

/** Reads and parses a `database V2` file from disk. */
export async function readDatabaseV2(filePath: string): Promise<ParsedDatabaseV2> {
  const buffer = await fs.readFile(filePath);
  return parseDatabaseV2Buffer(buffer);
}
