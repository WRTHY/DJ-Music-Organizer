import fs from 'node:fs/promises';

/**
 * Reader for Rekordbox's USB/CDJ export format (`export.pdb`, plus
 * `exportExt.pdb` for a couple of newer table types -- same page/row
 * layout, just a different set of tables).
 *
 * Unlike Serato's crate format, this one wasn't invented for this
 * project's convenience -- it's a real page-based relational database
 * (Pioneer/AlphaTheta call it "DeviceSQL"), with tables as linked lists
 * of 4096-byte pages and rows indexed in fixed-size groups at the end of
 * each page. The field layout here follows Deep Symmetry's djl-analysis
 * project (the community reference this ecosystem's other readers are
 * built from -- see docs/decisions.md, 2026-09-08 entry, for sources),
 * and every offset below was cross-checked byte-for-byte against a real
 * export.pdb (from James's own library, burned by a prior tool) before
 * being written here: page/row addressing was confirmed by locating the
 * fixed subtype marker every track row must have at each computed
 * address, and the two DeviceSQL string encodings (short, and long/wide
 * UTF-16LE) were confirmed by recovering real track paths -- including a
 * non-ASCII one ("/Contents/NTO/La clé des champs/...") -- byte-for-byte.
 *
 * Read-only. This module never writes to a .pdb file. Track *file paths*
 * are the only thing extracted so far -- enough to prove the format is
 * readable at all and to know what's actually on a Rekordbox-managed
 * volume. Playlist/crate hierarchy (the `playlist_tree` and
 * `playlist_entries` tables) is a deliberately separate next step, not
 * built yet -- see docs/roadmap.md, Phase 5.
 */

export interface RekordboxTrack {
  /** The track's row id within this database -- stable within one export, not a global identifier. */
  id: number;
  /** Path as stored in the export, e.g. "/Contents/Artist/Album/01 - Track.mp3". */
  filePath: string;
  fileName: string;
  title?: string;
}

const PAGE_HEADER_SIZE = 0x28; // common (0x20) + data-page-specific (8) header, before the row heap starts
const ROW_GROUP_SIZE = 36; // 16 x 2-byte offsets + 2-byte presence flags + 2-byte (unused here)
const ROWS_PER_GROUP = 16;
const TRACKS_TABLE_TYPE = 0x00;
const TRACK_ROW_SUBTYPE = 0x0024;
const INDEX_PAGE_FLAG = 0x40;
const STRING_OFFSET_COUNT = 21;
const STRING_OFFSETS_START = 0x5e;
// Indexes into the 21-entry string-offset array (see the field table in
// docs/decisions.md's 2026-09-08 entry / the djl-analysis source).
const STRING_INDEX = { title: 17, fileName: 19, filePath: 20 } as const;

interface TablePointer {
  type: number;
  firstPage: number;
}

/** Reads export.pdb (or exportExt.pdb) from disk and extracts every track's file path. */
export async function readPdbTracks(pdbPath: string): Promise<RekordboxTrack[]> {
  const buffer = await fs.readFile(pdbPath);
  return parsePdbTracks(buffer);
}

/** Pure parse of an already-read buffer -- this is what's actually tested. */
export function parsePdbTracks(buffer: Buffer): RekordboxTrack[] {
  const pageSize = buffer.readUInt32LE(4);
  const numTables = buffer.readUInt32LE(8);

  const tables: TablePointer[] = [];
  for (let i = 0; i < numTables; i++) {
    const off = 0x1c + i * 16;
    if (off + 16 > buffer.length) break;
    tables.push({ type: buffer.readUInt32LE(off), firstPage: buffer.readUInt32LE(off + 8) });
  }

  const tracksTable = tables.find((t) => t.type === TRACKS_TABLE_TYPE);
  if (!tracksTable) return [];

  const tracks: RekordboxTrack[] = [];
  const visitedPages = new Set<number>(); // guards against a corrupt/looping page chain
  let pageIndex = tracksTable.firstPage;

  while (pageIndex !== 0 && !visitedPages.has(pageIndex)) {
    visitedPages.add(pageIndex);
    const pageOffset = pageIndex * pageSize;
    if (pageOffset + pageSize > buffer.length) break;

    const nextPage = buffer.readUInt32LE(pageOffset + 0x0c);
    const pageFlags = buffer.readUInt8(pageOffset + 0x1b);
    const isIndexPage = (pageFlags & INDEX_PAGE_FLAG) !== 0;

    // Index pages exist for fast lookup within a table and carry no row
    // data of their own -- every actual row lives on a data page, and
    // every page (index or data) is still visited via next_page, so
    // skipping index pages here loses nothing.
    if (!isIndexPage) {
      for (const rowOffset of readRowOffsets(buffer, pageOffset, pageSize)) {
        const track = parseTrackRow(buffer, pageOffset + PAGE_HEADER_SIZE + rowOffset);
        if (track) tracks.push(track);
      }
    }

    pageIndex = nextPage;
  }

  return tracks;
}

/** Yields the byte offset (relative to the row heap, i.e. pageOffset + PAGE_HEADER_SIZE) of every present row on a data page. */
function* readRowOffsets(buffer: Buffer, pageOffset: number, pageSize: number): Generator<number> {
  const rowCountsBytes = buffer.subarray(pageOffset + 0x18, pageOffset + 0x1b);
  const rowCountsValue = rowCountsBytes[0] | (rowCountsBytes[1] << 8) | (rowCountsBytes[2] << 16);
  const numRowOffsets = rowCountsValue & 0x1fff; // low 13 bits

  const numGroups = Math.ceil(numRowOffsets / ROWS_PER_GROUP);
  for (let group = 0; group < numGroups; group++) {
    const groupEnd = pageOffset + pageSize - group * ROW_GROUP_SIZE;
    const groupStart = groupEnd - ROW_GROUP_SIZE;
    if (groupStart < pageOffset) break;

    const presenceFlags = buffer.readUInt16LE(groupStart + ROWS_PER_GROUP * 2);
    for (let slot = 0; slot < ROWS_PER_GROUP; slot++) {
      const rowIndexInGroup = group * ROWS_PER_GROUP + slot;
      if (rowIndexInGroup >= numRowOffsets) continue;
      if ((presenceFlags & (1 << slot)) === 0) continue;
      // Offsets are written from the end of their 16-slot array backward,
      // so slot 0 (the lowest row index in the group) is stored last.
      yield buffer.readUInt16LE(groupStart + (ROWS_PER_GROUP - 1 - slot) * 2);
    }
  }
}

function parseTrackRow(buffer: Buffer, rowAddr: number): RekordboxTrack | null {
  if (rowAddr < 0 || rowAddr + STRING_OFFSETS_START + STRING_OFFSET_COUNT * 2 > buffer.length) return null;

  const subtype = buffer.readUInt16LE(rowAddr);
  if (subtype !== TRACK_ROW_SUBTYPE) return null; // defensive -- not actually a track row

  const id = buffer.readUInt32LE(rowAddr + 0x48);
  const stringAt = (index: number) =>
    decodeDeviceSqlString(buffer, rowAddr + buffer.readUInt16LE(rowAddr + STRING_OFFSETS_START + index * 2));

  const filePath = stringAt(STRING_INDEX.filePath);
  if (!filePath) return null; // a track row with no path isn't useful to this project

  return {
    id,
    filePath,
    fileName: stringAt(STRING_INDEX.fileName) ?? '',
    title: stringAt(STRING_INDEX.title) ?? undefined,
  };
}

/**
 * Decodes one DeviceSQL string. Two encodings exist, distinguished by the
 * format byte's low bit:
 *  - short (bit0 set): the format byte doubles as a length -- shifting it
 *    right one bit gives the TOTAL byte count including the format byte
 *    itself, so the content is that many bytes minus one, immediately
 *    following. ASCII only. Confirmed against real short strings.
 *  - long (bit0 clear): format byte (kind) + 2-byte length (also
 *    including its own 4-byte header) + 1 pad byte, then the content.
 *    Kind 0x90 is wide/UTF-16LE -- confirmed against real long strings,
 *    including non-ASCII text. Kind 0x40 (plain ASCII long strings) is
 *    implemented per the documented format but wasn't hit in the real
 *    data this was validated against, so treat it as less proven than
 *    the other two paths until it's been seen for real.
 */
function decodeDeviceSqlString(buffer: Buffer, addr: number): string | null {
  if (addr <= 0 || addr >= buffer.length) return null;
  const formatByte = buffer.readUInt8(addr);
  if (formatByte === 0) return null;

  const isShort = (formatByte & 0x01) !== 0;
  if (isShort) {
    const totalLen = formatByte >> 1;
    if (totalLen < 1 || addr + totalLen > buffer.length) return null;
    return buffer.toString('ascii', addr + 1, addr + totalLen);
  }

  if (addr + 4 > buffer.length) return null;
  const length = buffer.readUInt16LE(addr + 1);
  const dataStart = addr + 4;
  const dataLen = Math.max(0, length - 4);
  if (dataStart + dataLen > buffer.length) return null;

  if (formatByte === 0x90) {
    return buffer.toString('utf16le', dataStart, dataStart + dataLen);
  }
  return buffer.toString('ascii', dataStart, dataStart + dataLen);
}
