# The rekordbox USB export database format

When rekordbox "exports" a USB stick for use in CDJ/XDJ players, it writes a
`PIONEER/` folder (sometimes `.PIONEER/`, hidden) containing:

```
PIONEER/
  rekordbox/
    export.pdb        <- the library database (this document)
    exportExt.pdb     <- companion database: My Tag data (§ exportExt below)
    exportLibrary.db  <- SQLite (rekordbox 6+ device library; not covered here)
  USBANLZ/…/ANLZ0000.DAT|.EXT   <- per-track waveform/beatgrid analysis
  Artwork/…                     <- album art referenced by the artwork table
```

Everything below was verified byte-by-byte against real exports in this
repo's `tests/data/` (a single-track export and a 12-track export) and a
713-track full-library capture, and cross-checked field-by-field against the
independent Kaitai parser generated from Deep Symmetry's crate-digger
`rekordbox_pdb.ksy` (see `tests/test_external.py`). The exportExt tag-row
layout was derived from hex dumps in this project; it is not in the
crate-digger spec.

All integers are **little-endian**. All offsets below are in bytes.

## File header (page 0)

| off  | type | meaning                                    |
|------|------|--------------------------------------------|
| 0x00 | u32  | 0 (magic / "page 0")                        |
| 0x04 | u32  | page size, 4096 in every observed file      |
| 0x08 | u32  | number of tables                            |
| 0x0c | u32  | next unused page index                      |
| 0x10 | u32  | unknown (1 observed in small exports, 5 in a large one) |
| 0x14 | u32  | sequence number (+1 per rekordbox save transaction) |
| 0x18 | u32  | 0                                           |
| 0x1c | 16·n | table directory, one entry per table        |

Table directory entry: `u32 type, u32 empty_candidate, u32 first_page,
u32 last_page`. `empty_candidate` points at the next allocated-but-unused
page for the table; **every table's `last_page.next_page` equals its
`empty_candidate`** (holds for all 20 tables in every observed file).
Empty-candidate pages are zero-filled on disk or lie entirely beyond EOF
(`next_unused_page` = max allocated page index + 1; the file on disk only
extends to the last written page — rekordbox extends it lazily).

## Table types (export.pdb)

| type | contents                                        |
|------|--------------------------------------------------|
| 0    | tracks                                           |
| 1    | genres                                           |
| 2    | artists                                          |
| 3    | albums                                           |
| 4    | labels                                           |
| 5    | keys                                             |
| 6    | colors                                           |
| 7    | playlist tree (folders + playlists)              |
| 8    | playlist entries                                 |
| 9,10 | unknown                                          |
| 11   | history playlists                                |
| 12   | history entries                                  |
| 13   | artwork paths                                    |
| 14,15| unknown                                          |
| 16   | UI column names (long UTF-16LE strings)          |
| 17   | unknown — 8-byte rows `u16, u16, u32` (observed) |
| 18   | unknown                                          |
| 19   | history sync info                                |

## Page header (0x28 bytes, at the start of every page)

| off  | type | meaning                                            |
|------|------|----------------------------------------------------|
| 0x00 | u32  | 0                                                   |
| 0x04 | u32  | page index (self)                                   |
| 0x08 | u32  | table type                                          |
| 0x0c | u32  | next page of this table (or the empty candidate)    |
| 0x10 | u32  | per-table write-generation counter: stamped into each page the save touched; +1 per save that writes the table |
| 0x14 | u32  | 0                                                   |
| 0x18 | u8   | slot count & 0xFF (see below)                       |
| 0x19 | u16  | (unaligned) `0x20 · present_rows`, bit 0 = slot count > 255 |
| 0x1b | u8   | page flags — 0x24 data page, 0x34 data page with ≥1 deleted slot (bit 0x10 = has-deletions), 0x64 index page (bit 0x40 = no rows) |
| 0x1c | u16  | free_size = page_size − 0x28 − used_size − (2n + 4·⌈n/16⌉) |
| 0x1e | u16  | used_size = heap high-water mark (allocated row bytes incl. per-row slack; always a multiple of 4) |
| 0x20 | u16  | rows written in the page's most recent save = popcount of the written masks (0x1fff after a delete-only save) |
| 0x22 | u16  | slot count at the page's **previous** write (0 for pages filled in one batch; 0x1fff sentinel after delete-only saves and on fresh index pages) |
| 0x24 | u16  | 0 on data pages; 1004 on every index (0x64) page     |
| 0x26 | u16  | 0 on data pages; small counts on some index pages    |

**Slot count `n`** (all directory slots, live + deleted) is stored as
`n & 0xFF` at 0x18 plus the overflow bit (bit 0 of the u16 at 0x19):
`n = u8@0x18 + 0x100 · (u8@0x19 & 1)`. The widely-used heuristic
"`num_rows_large` (@0x22) if larger and ≠ 0x1fff" — used by crate-digger
and previously by this project — is **wrong**: @0x22 is the slot count at
the previous write, and on pages that ever exceeded 255 slots the
heuristic silently drops rows (a real 713-track export contains a page
where it loses 78 live history entries). Cross-checks: present-row count
= `u16@0x19 >> 5` = popcount of the presence masks, and
`2n + 4·⌈n/16⌉ = page_size − 0x28 − used_size − free_size` (verified on
202/202 data pages across four real exports).

Each table's `first_page` is an index (0x64) page in every observed
export; real data starts on the next page.

## Row directory (grows down from the end of each data page)

Rows live in a heap growing **up** from 0x28. Row *offsets* are kept in
groups of up to 16, growing **down** from the page end:

* group `g` base = `page_size − g·0x24`
* `u16` **written mask** at `base − 2`: bit `i` set ⇒ row `i` of the
  group was written during the page's most recent save (u16@0x20 in the
  page header is the popcount of these masks over all groups; both are
  cleared/reset at the start of each save)
* `u16` **presence mask** at `base − 4`; bit `i` set ⇒ row `i` of the
  group is live (cleared ⇒ deleted row, slot still allocated)
* `u16` offset of row `i` at `base − 6 − 2i`, **relative to the heap
  start** (page offset 0x28)

Row offsets are always multiples of 4, strictly ascending in slot order
(the first row of a page at heap offset 0). Deleted slots are never
reclaimed or compacted; a deleted row keeps its slot, offset, and heap
bytes forever.

### Row allocation sizes

A row's heap allocation is larger than its packed content; the next row
starts at `previous offset + alloc` and the slack bytes are zeros when
freshly written (stale garbage after in-place rewrites). With
`align4(x) = (x+3) & ~3` and `l` = a string's total framed length:

| row type                | allocation                                   |
|-------------------------|-----------------------------------------------|
| track                   | `0x88 + Σ align4(lᵢ) (21 strings) + 4`        |
| artist                  | `align4(10 + align4(l)) + 4`                  |
| album                   | `align4(22 + align4(l)) + 4`                  |
| genre, label, artwork, history playlist | `align4(4 + l)`               |
| key, color              | `align4(8 + l)`                               |
| playlist tree node      | `align4(20 + l)`                              |
| playlist/history entry  | 12                                            |
| type 17 / type 18 / type 19 | 8 / 8 / 40                                |

Verified byte-exact on every freshly-exported row across four real
exports; rows rewritten in place keep their original (possibly larger)
allocation.

## DeviceSQL strings

First byte `b`:

* `b` odd — short ASCII: text length `(b >> 1) − 1` (i.e. `b = 2·len+3`),
  text at +1. `b = 0x03` is the empty string.
* `b = 0x40` — long ASCII: `u16 total_len` at +1 (includes the 4-byte
  header), one 0x00 byte, text at +4, length `total_len − 4`.
* `b = 0x90` — long UTF-16LE: same framing as 0x40, payload UTF-16LE.

Encoding choice (as rekordbox makes it): pure-ASCII text of length ≤ 126
→ short ASCII; longer pure-ASCII → 0x40; any non-ASCII character → 0x90
regardless of length (there is no short unicode form). Inside track rows,
strings are packed in slot order starting at row+0x88 with no gaps, except
that **long (0x40/0x90) strings start 4-byte aligned** (0–3 pad bytes,
normally zero — one garbage pad byte was observed in a real export, so
readers must trust the offsets, not the padding).

**ISRC oddity (track string slot 0):** when present, the ISRC uses kind
0x90 but the payload is NOT UTF-16 — it is `0x03` + ASCII ISRC + `0x00`
(`total_len = len + 6`). Decode by sniffing the inner 0x03 byte.

## Row layouts

### Track (type 0)

Fixed part, then 21 `u16` string offsets at 0x5e, each **relative to the
row start**.

| off  | type | field                | off  | type | field           |
|------|------|----------------------|------|------|------------------|
| 0x00 | u16  | 0x0024 (constant)    | 0x34 | u32  | track_number     |
| 0x02 | u16  | index_shift          | 0x38 | u32  | tempo (BPM×100)  |
| 0x04 | u32  | 0x000C0700 (constant)| 0x3c | u32  | genre_id         |
| 0x08 | u32  | sample_rate          | 0x40 | u32  | album_id         |
| 0x0c | u32  | composer_id          | 0x44 | u32  | artist_id        |
| 0x10 | u32  | file_size            | 0x48 | u32  | id               |
| 0x14 | u32  | unique per track (random-looking, no known correlation) | 0x4c | u16 | disc_number |
| 0x18 | u16  | 0xAE49 (constant)    | 0x4e | u16  | play_count       |
| 0x1a | u16  | 0x03DD (constant)    | 0x50 | u16  | year             |
| 0x1c | u32  | artwork_id           | 0x52 | u16  | sample_depth     |
| 0x20 | u32  | key_id               | 0x54 | u16  | duration (s)     |
| 0x24 | u32  | original_artist_id   | 0x56 | u16  | 0x0029 (constant)|
| 0x28 | u32  | label_id             | 0x58 | u8   | color_id         |
| 0x2c | u32  | remixer_id           | 0x59 | u8   | rating           |
| 0x30 | u32  | bitrate              | 0x5a | u16  | file type: .mp3=1, .m4a=4, .wav=0x0b, .aiff=0x0c |
|      |      |                      | 0x5c | u16  | 0x0003 (constant)|

`index_shift` (here and in artist/album/tag rows) = `0x20 ×` the row's
slot index in its page's row directory — page-local, counting deleted
slots; it resets on every new page.

String slots (index → meaning): 5 message, 6 kuvo_public ("ON"/""),
7 autoload_hotcues ("ON"/""), 10 date_added, 11 release_date, 12 mix_name,
14 analyze_path (`/PIONEER/USBANLZ/…/ANLZ0000.DAT`), 15 analyze_date,
16 comment, 17 title, 19 filename, 20 file_path. The rest are unknown
(slot 0 has been observed to hold the ISRC).

### Artist (type 2)

`u16 subtype (0x60|0x64), u16 index_shift, u32 id, u8 0x03, u8 ofs_name_near`.
If subtype is 0x64 the name lives beyond a one-byte offset's reach and a
`u16 ofs_name_far` follows at 0x0a. Offsets are relative to the row start.

### Album (type 3)

`u16 0x80, u16 index_shift, u32 unknown (0), u32 artist_id, u32 id,
u32 unknown (0), u8 0x03, u8 ofs_name` (row-relative). Note: real
exports leave `artist_id` 0 in almost all album rows even when the
album has an artist.

### Genre (1), Label (4), Artwork (13), History playlist (11)

`u32 id`, then: genre/label — name string at +4; artwork — path string
at +4; history playlist — name at +4.

### Key (type 5)

`u32 id, u32 id2 (== id), name string at +8`.

### Color (type 6)

`u32 unknown, u8 unknown, u16 id, u8 unknown, name string at +8`.
Rows are 16 bytes apart; ids 1–8 = Pink Red Orange Yellow Green Aqua
Blue Purple.

### Playlist tree (type 7)

`u32 parent_id (0 = root), u32 unknown (0), u32 sort_order, u32 id,
u32 raw_is_folder (non-zero = folder), name string at +20`.
`sort_order` is the 0-based position among siblings; a playlist added
later gets `max(sibling) + 1`. **Playlist ids are not stable**: rekordbox
reassigns them (by sort order) when re-exporting the same library, and
patches `playlist_id` in existing entry rows in place to match.

### Playlist entry (type 8) / History entry (type 12)

Playlist entry: `u32 entry_index, u32 track_id, u32 playlist_id`.
History entry: `u32 track_id, u32 playlist_id, u32 entry_index`.
`entry_index` is 1-based and contiguous per playlist on a fresh export;
after deletions the gaps persist (entries are not renumbered).

### Column (type 16)

`u16 id, u16 unknown, name at +4` — a long UTF-16LE string whose text is
wrapped in U+FFFA … U+FFFB (interlinear annotation anchors), e.g.
`￺GENRE￻`.

## exportExt.pdb

Same container format (header, pages, row groups, strings), but its own
table numbering, 9 tables (types 0–8). Only two have been observed
populated; **type 3 is the My Tag table**:

### Tag / tag category (ext type 3)

| off  | type | field                                              |
|------|------|-----------------------------------------------------|
| 0x00 | u16  | subtype 0x0680                                      |
| 0x02 | u16  | index_shift (0x20 steps)                            |
| 0x04 | u32  | 0                                                   |
| 0x08 | u32  | 0                                                   |
| 0x0c | u32  | category_id (parent category; 0 for category rows)  |
| 0x10 | u32  | position (sort order within the category / of the category) |
| 0x14 | u32  | id — small ordinal for categories (1..4); a persistent 32-bit value for tags (stable across exports) |
| 0x18 | u24  | 0                                                   |
| 0x1b | u8   | 1 = category, 0 = tag                               |
| 0x1c | u8   | 0x03                                                |
| 0x1d | u8   | ofs_name (row-relative, 0x1f in all observed rows)  |
| 0x1e | u8   | offset of a second, empty string after the name     |

Default set (28 rows): categories Genre (7 tags), Components (8),
Situation (8), "Untitled Column" (1 tag, "My Comment").

### Unknowns (ext)

Type 7 holds a single row: `u16 0x0700, u16 index_shift`, 20 zero bytes,
`u32` (checksum-like), `u8 0x03`, then five u8 string offsets pointing at
five empty strings. Purpose unknown. Type 8 is believed to hold tag↔track
associations (empty in all captures — no tagged tracks were exported).
Types 0–2 and 4–6 were empty in every capture.

## Writing (how rekordbox saves, and what an editor must do)

Derived from a full byte-diff of two consecutive exports of the same
library plus the invariants above; implemented in `rekordbox_pdb.edit`.

rekordbox **never rewrites the file**. A save is a set of surgical edits:
u32 field patches in place, row deletions by clearing the presence bit
(nothing else changes — heap bytes, slot, and offset stay), and
variable-size row "updates" as delete + append. To append a row into a
page:

1. heap offset = current `used_size`; write the row, zero the allocation
   slack; slot `k` = current slot count `n`.
2. directory: offset u16 at `base − 6 − 2k` (initialize the new group's
   two flag words first when `k % 16 == 0`), set presence bit and
   written-mask bit `k`.
3. header: slot count fields (`u8@0x18 = n+1 & 0xFF`, u16@0x19 =
   `0x20·present | (n+1 > 255)`), `u16@0x22` = slot count before this
   save, `u16@0x20` = rows written this save, recompute
   `used_size`/`free_size`, stamp `@0x10` with 1 + the table's max
   generation, and bump the file-header sequence once per save.

When a page is full (or a table has no data page yet — an empty table's
`last_page` is its index page), allocate: the new page is the table's
`empty_candidate` (the old last page's `next_page` already points at it);
extend the file with zeros if the candidate lies beyond EOF; initialize
its header; set its `next_page` := header `next_unused_page`; set
`table.last_page` := new page, `table.empty_candidate` :=
`next_unused_page`, and increment `next_unused_page`. rekordbox left 18
of 20 index (0x64) pages untouched across saves, so an editor may leave
them stale; their partially-understood heap begins `u32 own/first page,
u32 first data page or 0x03FFFFFF, u32 0x03FFFFFF, u32 0`, then 1004 ×
`u32 0xFFF81FFF` fill and a `u16 0x1FFF`.

## Gaps / future work

* export.pdb tables 9, 10, 14, 15, 17, 18: layouts unknown (17's 8-byte
  rows `u16 a, u16 b, u32 c` observed but unidentified).
* Track string slots 1–4, 8, 9, 13, 18: purpose unknown (slots 2 and 3
  hold ASCII "2" in ~99% of rows, rare "0"/"1"/"3"/"8" variants).
* Track u32@0x14: unique per track, meaning unknown.
* Index (0x64) page heap: entry array not fully decoded; whether players
  read it at all is unknown.
* Whether pure-ASCII strings of length 124–126 use the short or 0x40
  form (no examples in the corpus; 123 and below are short, 128 and
  above are long).
* Edited files verify against two independent parsers, but have not been
  tested on CDJ/XDJ hardware or re-imported into rekordbox.
* `exportLibrary.db` (SQLite) and the ANLZ analysis files are separate
  formats, out of scope here (ANLZ is well covered by crate-digger and
  rekordcrate).
