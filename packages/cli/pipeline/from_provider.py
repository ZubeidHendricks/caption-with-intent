#!/usr/bin/env python3
"""
Synthetic-speech provider -> Caption with Intention manifest.

    # HeyGen: pass the signed URLs from the API or MCP tools
    python3 from_provider.py heygen --video URL --srt URL \
        --speaker narrator --name "Narrator" --out out.cwi.json

    # ...or local files you already downloaded
    python3 from_provider.py heygen --video clip.mp4 --srt clip.srt --out out.cwi.json

    # Merge several single-speaker renders into one scene
    python3 from_provider.py merge a.cwi.json b.cwi.json --offsets 0 12.4 --out scene.cwi.json

Colour assignment stays in @cwi/core so every tool agrees:
    npx cwi assign out.cwi.json
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from adapters import heygen


def _local(arg: str, tmp: Path, name: str) -> Path:
    """Accept either a local path or a URL."""
    if arg.startswith(("http://", "https://")):
        return heygen.fetch(arg, tmp / name)
    p = Path(arg)
    if not p.exists():
        raise SystemExit(f"not found: {p}")
    return p


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    hg = sub.add_parser("heygen", help="one HeyGen render plus its SRT")
    hg.add_argument("--video", required=True, help="mp4 path or signed URL")
    hg.add_argument("--srt", required=True, help="SRT path or signed URL")
    hg.add_argument("--speaker", default="narrator")
    hg.add_argument("--name", default=None)
    hg.add_argument("--tier", default="main", choices=["main", "supporting", "minor"])
    hg.add_argument("--off-camera", action="store_true")
    hg.add_argument("--pitch-mode", default="voice", choices=["voice", "word", "raw"])
    hg.add_argument("--out", required=True, type=Path)

    mg = sub.add_parser("merge", help="combine per-character manifests into one scene")
    mg.add_argument("manifests", nargs="+", type=Path)
    mg.add_argument("--offsets", nargs="*", type=float, default=None,
                    help="seconds to shift each manifest; defaults to 0")
    mg.add_argument("--out", required=True, type=Path)

    args = ap.parse_args()

    if args.cmd == "heygen":
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            video = _local(args.video, tmp, "v.mp4")
            srt = _local(args.srt, tmp, "s.srt")
            m = heygen.build(
                video, srt,
                speaker=args.speaker, name=args.name, tier=args.tier,
                on_camera=not args.off_camera, pitch_mode=args.pitch_mode,
            )
    else:
        ms = [json.loads(p.read_text()) for p in args.manifests]
        offsets = args.offsets or [0.0] * len(ms)
        if len(offsets) != len(ms):
            raise SystemExit(f"got {len(ms)} manifests but {len(offsets)} offsets")
        m = heygen.merge(ms, offsets)

    args.out.write_text(json.dumps(m, indent=2))
    n = sum(len(l["tokens"]) for c in m["cues"] for l in c["lines"])
    print(f"{args.out}: {len(m['characters'])} characters, {len(m['cues'])} cues, {n} tokens")
    print(f"next: npx cwi assign {args.out}")


if __name__ == "__main__":
    main()
