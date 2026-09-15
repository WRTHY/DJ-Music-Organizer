from pathlib import Path

from rekordbox_pdb.__main__ import main

DATA = Path(__file__).parent / "data"


def test_dump_summarizes_library(capsys):
    main([str(DATA / "one-song-export.pdb")])
    out = capsys.readouterr().out
    assert "1 tracks" in out
    assert "Super Smash Bros." in out
    assert "BABY GRAVY/Yung Gravy/bbno$" in out
    assert "146.00" in out  # BPM formatted from tempo=14600
    assert "aac" in out  # playlist name


def test_dump_ext(capsys):
    main([str(DATA / "one-song-exportExt.pdb"), "--ext"])
    out = capsys.readouterr().out
    assert "Genre" in out
    assert "Acid House" in out
