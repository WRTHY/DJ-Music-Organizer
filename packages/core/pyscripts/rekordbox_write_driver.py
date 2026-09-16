"""Driver script invoked by pdbWriter.ts as a child process.

This is this project's own code, NOT part of the vendored
`rekordbox-pdb` library (see vendor/rekordbox-pdb/VENDORED.md) -- it's a
thin glue layer that turns a JSON batch of write operations into calls
against the vendored `PdbEditor`, so the TypeScript side never has to
know PdbEditor's Python API directly.

Protocol (see pdbWriter.ts for the TypeScript side of this contract):
  - The full request is read as one JSON object from stdin:
      {
        "vendorSrcPath": "<absolute path to vendor/rekordbox-pdb/src>",
        "templatePath": "<absolute path to the source export.pdb>",
        "outputPath": "<absolute path to write the result to>",
        "ops": [ ... see below ... ]
      }
  - Ops are applied to one PdbEditor session, in array order, exactly
    once each -- matching PdbEditor's own "one editing session = one
    save transaction" model (see edit.py's `_finalize`). Every
    "addTrack" and "createPlaylist" op carries a caller-chosen
    "localId" (any string); later ops in the same batch reference that
    row by localId (via "trackRef"/"playlistRef") rather than needing
    to know the real numeric id PdbEditor assigns, since that id isn't
    known until the row is actually appended.
  - On success, prints one JSON object to stdout:
      {"ok": true, "createdIds": {"<localId>": <real numeric id>, ...}}
    and exits 0. `createdIds` has one entry per "addTrack"/
    "createPlaylist" op, keyed by that op's localId.
  - On any failure, prints {"ok": false, "error": "<message>"} to
    stdout (still valid JSON, not a stack trace on stderr, so the
    Node side has one place to look) and exits 1. The output file is
    never written on failure -- PdbEditor.save() only runs after every
    op in the batch has applied cleanly.

Deliberately minimal: this file does no validation beyond what
PdbEditor itself does (a bad field value fails loudly with PdbEditor's
own ValueError, surfaced verbatim in "error") -- duplicating validation
here would just be a second place for the two to drift apart.
"""

from __future__ import annotations

import json
import sys


def _resolve_id(ref: str, created: dict[str, int]) -> int:
    """A ref is either another op's localId in this same batch, or a
    real numeric id (as a string) for a row that already existed in
    the template before this batch ran."""
    if ref in created:
        return created[ref]
    return int(ref)


def run(spec: dict) -> dict:
    sys.path.insert(0, spec["vendorSrcPath"])
    from rekordbox_pdb.edit import PdbEditor  # noqa: E402 (path set above)

    editor = PdbEditor.from_file(spec["templatePath"])
    created: dict[str, int] = {}

    for op in spec["ops"]:
        kind = op["op"]
        if kind == "addTrack":
            track_id = editor.add_track(
                title=op["title"],
                file_path=op["filePath"],
                filename=op.get("filename"),
                artist=op.get("artist"),
                album=op.get("album"),
                genre=op.get("genre"),
                key=op.get("key"),
                label=op.get("label"),
                comment=op.get("comment", ""),
                tempo=op.get("tempo", 0),
                duration=op.get("duration", 0),
                year=op.get("year", 0),
                bitrate=op.get("bitrate", 0),
                sample_rate=op.get("sampleRate", 44100),
                sample_depth=op.get("sampleDepth", 16),
                file_size=op.get("fileSize", 0),
                track_number=op.get("trackNumber", 0),
                disc_number=op.get("discNumber", 0),
                rating=op.get("rating", 0),
            )
            created[op["localId"]] = track_id
        elif kind == "createPlaylist":
            playlist_id = editor.create_playlist(
                op["name"],
                parent_id=_resolve_id(op["parentRef"], created) if op.get("parentRef") else 0,
                is_folder=op.get("isFolder", False),
            )
            created[op["localId"]] = playlist_id
        elif kind == "addToPlaylist":
            editor.add_to_playlist(
                _resolve_id(op["playlistRef"], created),
                _resolve_id(op["trackRef"], created),
            )
        elif kind == "setTrackField":
            editor.set_track_field(
                track_id=_resolve_id(op["trackRef"], created),
                field=op["field"],
                value=op["value"],
            )
        else:
            raise ValueError(f"unknown op kind: {kind!r}")

    editor.save(spec["outputPath"])
    return {"ok": True, "createdIds": created}


def main() -> int:
    spec = json.load(sys.stdin)
    try:
        result = run(spec)
    except Exception as exc:  # noqa: BLE001 -- deliberately broad; see module doc
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
