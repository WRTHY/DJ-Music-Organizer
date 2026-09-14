# Serato `database V2` format

Like the `.crate` format, Serato has never published this one either.
Unlike the crate format, this document isn't starting from community
reverse-engineering plus a validation pass — it's built the other way
around: parsed directly, byte-by-byte, against James's real file
(`E:\LIBRARY BACKUP 9_10_2026\_Serato_\database V2`, ~7.96 MB, 11,991
tracks), then cross-checked against what secondary sources (a DeepWiki
analysis of `bvandrc/serato-tools`, and Serato's own support articles)
say. Where the two agree, that's noted below; nothing here rests on a
secondary source alone.

## Why this file exists (recap from `decisions.md`, 2026-09-11)

A `.crate` file is a filtered *view* into a library — it lists which
tracks belong to a crate, nothing more. `database V2` is the actual
master index Serato reads to know a track exists at all. A track a
`.crate` file references but `database V2` has never heard of is
invisible in Serato's UI, full stop — this is the confirmed root cause
of "the burned drive's folders and files are correct but nothing shows
up in Serato."

## Container format — identical to `.crate`

Confirmed by parsing the real file: the exact same 4-byte ASCII tag +
4-byte big-endian length + payload framing used by `.crate` files,
applied flat at the top level. Walking the real file this way accounts
for every one of its 7,964,819 bytes with no leftover trailer — there's
no footer, checksum, or index appended after the last chunk.

Top level is:

- One `vrsn` chunk. Payload is UTF-16BE, and reads exactly
  `2.0/Serato Scratch LIVE Database` — note this is a **different**
  version string from `.crate` files' `1.0/Serato ScratchLive Crate`,
  confirming these are related-but-distinct formats sharing one
  container scheme, not the same format reused.
- Then one `otrk` chunk per track — 11,991 of them in James's real
  file, each containing a nested sequence of chunks in the same
  tag+length+payload shape (same nesting pattern as `otrk`/`ptrk` in
  `.crate` files).

## Field tags inside an `otrk` — confirmed against a real track entry

A real entry (indexed as `Every relevant song ever/1653 - Coldplay -
Something Just Like This (Don Diablo Remix).mp3`) has 35 sub-chunks.
Field *type* is signalled by the tag's first letter — confirmed across
this sample and matched independently by the DeepWiki writeup of
`bvandrc/serato-tools`, which documents the same convention:

- **`t*` — UTF-16BE text**, no null terminator (byte length in the
  chunk header is exactly `2 × character count`): `ttyp` (file
  extension, e.g. `mp3`), `pfil` (track path), `tsng` (title), `tart`
  (artist), `talb` (album), `tgen` (genre), `tlen` (duration, as
  `mm:ss.hh` text), `tsiz` (size, as human text like `3.6MB`), `tbit`
  (bitrate, e.g. `128.0kbps`), `tsmp` (sample rate, e.g. `44.1k`),
  `tbpm` (BPM, as text), `tlbl` (record label), `ttyr` (year), `tadd`
  (date added, as text), `tkey` (musical key), `tgrp` (grouping —
  rare, 5 of 199 sampled tracks).
- **`u*` — 4-byte big-endian unsigned int**: `uadd` (date added, same
  value as `tadd` but as a Unix timestamp), `utkn` (small integer, seen
  values like `4`), `ulbl` (looks like a packed RGB color, e.g.
  `16777215` = `0xFFFFFF` — plausibly a label/row color), `utme` (a
  Unix timestamp, plausibly last-modified or last-played), `ufsb`
  (close to but not exactly the file's byte size — likely the size at
  last scan), `utpc` (play count — corroborated by a
  `TXXX:SERATO_PLAYCOUNT` ID3 frame on the same file, seen below).
- **`b*` — 1-byte boolean** (`00`/`01`): `bmis` (missing-file flag),
  `bcrt` (corrupt flag), `bply` (played), `bbgl` (beatgrid locked),
  plus `bhrt`, `blop`, `bitu`, `bovc`, `biro`, `bwlb`, `bwll`, `buns`,
  `bkrk` — present on essentially every track but not yet individually
  identified. `bmis`/`bcrt`/`bply`/`bbgl` match DeepWiki's independent
  naming exactly (missing / corrupt / played / beatgrid-locked), which
  is good independent corroboration for the `t`/`u`/`b`-prefix scheme
  as a whole.
- **`s*` — 2 bytes, purpose unconfirmed**: `sbav`, seen on
  nearly every track. Not required for this project's purposes (it's
  never referenced in any open question) so it's left unidentified
  rather than guessed at.

Field presence, sampled across the first 199 real tracks:

- **Present on effectively every track**: `ttyp`, `pfil`, `tsng`,
  `tbpm`, `tadd`/`uadd`, `tkey`, `ulbl`, `utme`, `utpc`, `sbav`, and
  every `b*` boolean.
- **Present on nearly all, missing on a handful**: `tart` (198/199),
  `ttyr` (196/199), `talb`/`tgen`/`tlbl`/`utkn` (195/199),
  `tlen`/`tbit` (194/199), `tsmp`/`ufsb` (192–193/199).
- **Rare**: `tgrp` (5/199) — only present on tracks James actually put
  in a grouping.

## Answering Phase 3b's open research questions

1. **Same outer chunk framing as `.crate`?** Yes — confirmed identical,
   byte-for-byte, by walking the real file (see Container format
   above).
2. **Which fields are actually required vs. merely displayed?** Not
   provable without a live write-and-reload test against real Serato
   (that's the Deliverable 5 hardware gate, not this research pass),
   but the evidence points the same direction as a plain reading of
   Serato's own "rebuilding the database" support article: fields
   besides `pfil` (and probably `ttyp`) look like ordinary scan output
   Serato regenerates on its own, not hard requirements. Serato's
   support docs confirm a "Rebuild Database" pass re-derives everything
   *except* Date Added from the files themselves — strong evidence a
   from-scratch writer can ship a minimal `otrk` (path + type, maybe a
   couple of the near-universal fields) and trust Serato's own scan to
   backfill the rest, rather than needing to reproduce this whole field
   set exactly.
3. **Does `database V2` encode crate membership?** No — confirmed both
   empirically (no crate-name-bearing field anywhere in any `otrk`, and
   no separate membership chunk anywhere in the file — just one `vrsn`
   then a flat run of `otrk`s) and by the DeepWiki writeup, which states
   this directly. The original assumption in `serato-crate-format.md`
   stands: crate structure lives entirely in the separate `.crate`
   files.
4. **Is per-track analysis data (waveform, cues, beatgrid) in
   `database V2` or the file's own ID3 tags?** Confirmed: the file's
   own ID3 tags. Pulling the real ID3 frames off the sampled track
   found `GEOB:Serato Overview`, `GEOB:Serato Analysis`,
   `GEOB:Serato Autotags`, `GEOB:Serato Markers_`,
   `GEOB:Serato Markers2`, `GEOB:Serato BeatGrid`, and
   `GEOB:Serato Offsets_` — none of that binary data appears anywhere
   in `database V2`'s `otrk` entries, which only carry the
   display/index fields listed above. Practical upshot: this project's
   existing whole-file `fs.copyFile` copy step already preserves all of
   it for free, exactly as assumed — no additional work needed here.
5. **Any checksum or integrity field?** No — confirmed by the clean
   walk of the real file: total bytes are fully accounted for by
   tag+length framing with nothing left over, and the only file-level
   marker is the single `vrsn` string at the top, same role it plays in
   `.crate` files.

## What's still open

- The exact meaning of a handful of `b*` flags (`bhrt`, `blop`, `bitu`,
  `bovc`, `biro`, `bwlb`, `bwll`, `buns`, `bkrk`) and of `sbav` — not
  blocking anything on the current roadmap, so left unidentified rather
  than guessed at.
- Whether a from-scratch writer's minimal-field guess (Deliverable 2's
  open question 2, above) actually satisfies real Serato — only the
  Deliverable 5 hardware checkpoint (burn to a genuinely blank drive,
  confirm Serato shows the library with no manual "add folder" step)
  can settle that. Everything here is necessary evidence for that step,
  not a substitute for it.
- Behavior across Serato versions, same caveat as the crate format doc:
  this was only checked against one library's current version.
