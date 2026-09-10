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
 * The `playlist_tree`/`playlist_entries` tables (2026-09-10) were
 * validated the same way, against a second real export -- this one from
 * a flash drive actually burned for and used on real Rekordbox/CDJ
 * hardware, 3,549 tracks and 431 playlist/folder nodes. Every decoded
 * folder and playlist name came back as real, readable text matching a
 * genuine hierarchy (parent/child links resolving to sensible nesting,
 * e.g. an "Artists" folder containing named-artist subfolders) rather
 * than garbage, which is the same kind of confirmation the original
 * track-path validation relied on. See docs/decisions.md.
 *
 * Read-only. This module never writes to a .pdb file.
 */

export interface RekordboxTrack {
  /** The track's row id within this database -- stable within one export, not a global identifier. */
  id: number;
  /** Path as stored in the export, e.g. "/Contents/Artist/Album/01 - Track.mp3". */
  filePath: string;
  fileName: string;
  title?: string;
}

/**
 * One row of the `playlist_tree` table -- a single folder or playlist.
 * Rekordbox's playlist tree is a real parent-pointer hierarchy (unlike
 * Serato's flat, filename-encoded crates), so `parentId`/`id` alone are
 * enough to reassemble the whole structure -- see canonicalTree.ts.
 */
export interface RekordboxPlaylistNode {
  /** This node's own id -- referenced as `parentId` by its children and as `playlistId` by its track entries. */
  id: number;
  /** 0 means this node sits directly under the volume root, not inside another folder. */
  parentId: number;
  name: string;
  /** true = a folder (organizational only, can have child nodes); false = an actual playlist (can have track entries). */
  isFolder: boolean;
  sortOrder: number;
}

/** One row of the `playlist_entries` table -- one track's membership in one playlist, at a given position. */
export interface RekordboxPlaylistEntry {
  playlistId: number;
  trackId: number;
  entryIndex: number;
}

const PAGE_HEADER_SIZE = 0x28; // common (0x20) + data-page-specific (8) header, before the row heap starts
const ROW_GROUP_SIZE = 36; // 16 x 2-byte offsets + 2-byte presence flags + 2-byte (unused here)
const ROWS_PER_GROUP = 16;
const INDEX_PAGE_FLAG = 0x40;

const TRACKS_TABLE_TYPE = 0x00;
const PLAYLIST_TREE_TABLE_TYPE = 0x07;
const PLAYLIST_ENTRIES_TABLE_TYPE = 0x08;

const TRACK_ROW_SUBTYPE = 0x0024;
const STRING_OFFSET_COUNT = 21;
const STRING_OFFSETS_START = 0x5e;
// Indexes into the 21-entry string-offset array (see the field table in
// docs/decisions.md's 2026-09-08 entry / the djl-analysis source).
const STRING_INDEX = { title: 17, fileName: 19, filePath: 20 } as const;

// playlist_tree row: 5 fixed u32 fields, then one DeviceSQL name string.
// The field at +4 is unidentified (constant 0 in every real row seen so
// far) and isn't surfaced -- see docs/decisions.md.
const PLAYLIST_TREE_ROW_HEADER_SIZE = 20;
// playlist_entries row: 3 fixed u32 fields, no strings, no subtype
// marker -- see parsePlaylistEntryRow's doc for how bogus rows are
// handled without one.
const PLAYLIST_ENTRY_ROW_SIZE = 12;

interface TablePointer {
  type: number;
  firstPage: number;
}

interface PdbTables {
  pageSize: number;
  tables: TablePointer[];
}

function readTablePointers(buffer: Buffer): PdbTables {
  const pageSize = buffer.readUInt32LE(4);
  const numTables = buffer.readUInt32LE(8);

  const tables: TablePointer[] = [];
  for (let i = 0; i < numTables; i++) {
    const off = 0x1c + i * 16;
    if (off + 16 > buffer.length) break;
    tables.push({ type: buffer.readUInt32LE(off), firstPage: buffer.readUInt32LE(off + 8) });
  }
  return { pageSize, tables };
}

/**
 * Walks every data-page row of one table (by its first page), calling
 * `parseRow` for each present row and collecting the non-null results.
 * Shared by every table this reader knows how to parse -- tracks,
 * playlist_tree, playlist_entries -- since they only differ in row
 * layout, never in how pages/rows are addressed.
 */
function walkTableRows<T>(
  buffer: Buffer,
  pageSize: number,
  firstPage: number,
  parseRow: (buffer: Buffer, rowAddr: number) => T | null
): T[] {
  const rows: T[] = [];
  const visitedPages = new Set<number>(); // guards against a corrupt/looping page chain
  let pageIndex = firstPage;

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
        const row = parseRow(buffer, pageOffset + PAGE_HEADER_SIZE + rowOffset);
        if (row) rows.push(row);
      }
    }

    pageIndex = nextPage;
  }

  return rows;
}

/** Reads export.pdb (or exportExt.pdb) from disk and extracts every track's file path. */
export async function readPdbTracks(pdbPath: string): Promise<RekordboxTrack[]> {
  return parsePdbTracks(await fs.readFile(pdbPath));
}

/** Reads export.pdb (or exportExt.pdb) from disk and extracts the playlist/folder hierarchy (no track membership -- see readPdbPlaylistEntries). */
export async function readPdbPlaylistTree(pdbPath: string): Promise<RekordboxPlaylistNode[]> {
  return parsePdbPlaylistTree(await fs.readFile(pdbPath));
}

/** Reads export.pdb (or exportExt.pdb) from disk and extracts every playlist's track membership. */
export async function readPdbPlaylistEntries(pdbPath: string): Promise<RekordboxPlaylistEntry[]> {
  return parsePdbPlaylistEntries(await fs.readFile(pdbPath));
}

/** Pure parse of an already-read buffer -- this is what's actually tested. */
export function parsePdbTracks(buffer: Buffer): RekordboxTrack[] {
  const { pageSize, tables } = readTablePointers(buffer);
  const tracksTable = tables.find((t) => t.type === TRACKS_TABLE_TYPE);
  if (!tracksTable) return [];
  return walkTableRows(buffer, pageSize, tracksTable.firstPage, parseTrackRow);
}

/** Pure parse of an already-read buffer -- the playlist/folder hierarchy, unordered by nesting (see canonicalTree.ts for reassembling it). */
export function parsePdbPlaylistTree(buffer: Buffer): RekordboxPlaylistNode[] {
  const { pageSize, tables } = readTablePointers(buffer);
  const table = tables.find((t) => t.type === PLAYLIST_TREE_TABLE_TYPE);
  if (!table) return [];
  return walkTableRows(buffer, pageSize, table.firstPage, parsePlaylistTreeRow);
}

/** Pure parse of an already-read buffer -- every playlist's track membership. */
export function parsePdbPlaylistEntries(buffer: Buffer): RekordboxPlaylistEntry[] {
  const { pageSize, tables } = readTablePointers(buffer);
  const table = tables.find((t) => t.type === PLAYLIST_ENTRIES_TABLE_TYPE);
  if (!table) return [];
  return walkTableRows(buffer, pageSize, table.firstPage, parsePlaylistEntryRow);
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

function parsePlaylistTreeRow(buffer: Buffer, rowAddr: number): RekordboxPlaylistNode | null {
  if (rowAddr < 0 || rowAddr + PLAYLIST_TREE_ROW_HEADER_SIZE > buffer.length) return null;

  const parentId = buffer.readUInt32LE(rowAddr);
  const sortOrder = buffer.readUInt32LE(rowAddr + 8);
  const id = buffer.readUInt32LE(rowAddr + 12);
  const rawIsFolder = buffer.readUInt32LE(rowAddr + 16);
  const name = decodeDeviceSqlString(buffer, rowAddr + PLAYLIST_TREE_ROW_HEADER_SIZE);
  if (name === null) return null; // a playlist/folder with no name isn't useful to this project -- also filters padding/garbage rows

  return { id, parentId, name, isFolder: rawIsFolder !== 0, sortOrder };
}

/**
 * playlist_entries rows have no subtype marker to validate against --
 * unlike track rows (which must carry `TRACK_ROW_SUBTYPE`) or
 * playlist_tree rows (implicitly validated by requiring a decodable
 * name), there's nothing here to reject a bogus row on its own. Instead,
 * every returned entry is filtered downstream, in canonicalTree.ts,
 * against the actual track and playlist-node ids this export has --
 * an entry referencing an id that doesn't exist is dropped and counted
 * rather than trusted.
 */
function parsePlaylistEntryRow(buffer: Buffer, rowAddr: number): RekordboxPlaylistEntry | null {
  if (rowAddr < 0 || rowAddr + PLAYLIST_ENTRY_ROW_SIZE > buffer.length) return null;

  const entryIndex = buffer.readUInt32LE(rowAddr);
  const trackId = buffer.readUInt32LE(rowAddr + 4);
  const playlistId = buffer.readUInt32LE(rowAddr + 8);
  return { entryIndex, trackId, playlistId };
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
