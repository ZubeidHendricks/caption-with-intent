#!/usr/bin/env python3
"""
Assemble a multi-character scene from single-speaker synthetic renders.

A HeyGen render is one avatar speaking, so a conversation arrives as N separate
clips. This concatenates them into one video and merges their manifests onto the
same timeline, so speaker attribution — the thing Caption with Intention exists
for — finally has more than one speaker to attribute.

Scene spec (JSON):

    {
      "title": "Control Room",
      "characters": {
        "vale":  {"name": "Detective Vale", "tier": "main", "role": "hero"},
        "kroft": {"name": "Kroft", "tier": "main", "role": "villain"}
      },
      "shots": [
        {"speaker": "vale",  "video": "url-or-path", "srt": "url-or-path"},
        {"speaker": "kroft", "video": "...", "srt": "...", "onCamera": false}
      ]
    }

    python3 build_scene.py scene.json --out-video scene.mp4 --out out.cwi.json

Offsets are derived from the actual clip durations rather than declared, so the
captions cannot drift out of sync with the assembled cut.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from adapters import heygen


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def resolve(ref: str, tmp: Path, name: str) -> Path:
    if ref.startswith(("http://", "https://")):
        return heygen.fetch(ref, tmp / name)
    p = Path(ref)
    if not p.exists():
        raise SystemExit(f"not found: {p}")
    return p


def concat(clips: list[Path], out: Path, tmp: Path) -> None:
    """
    Concatenate clips, re-encoding to a common format.

    The stream-copy concat demuxer is faster but silently produces broken
    timestamps when clips differ in resolution, frame rate or encoder settings —
    which renders as captions drifting against picture. Re-encoding is slower
    and correct.
    """
    lst = tmp / "concat.txt"
    lst.write_text("".join(f"file '{c.resolve()}'\n" for c in clips))
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(lst),
         "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
                "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x16222a,fps=25,format=yuv420p",
         "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
         "-c:a", "aac", "-ar", "48000", "-ac", "2",
         "-movflags", "+faststart", str(out)],
        check=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", type=Path)
    ap.add_argument("--out-video", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--pitch-mode", default="voice", choices=["voice", "word", "raw"])
    args = ap.parse_args()

    spec = json.loads(args.spec.read_text())
    chars = spec.get("characters", {})
    shots = spec["shots"]

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        clips: list[Path] = []
        manifests: list[dict] = []
        offsets: list[float] = []
        cursor = 0.0

        for i, shot in enumerate(shots):
            spk = shot["speaker"]
            meta = chars.get(spk, {})
            video = resolve(shot["video"], tmp, f"{i:02d}.mp4")
            srt = resolve(shot["srt"], tmp, f"{i:02d}.srt")

            m = heygen.build(
                video, srt,
                speaker=spk,
                name=meta.get("name"),
                tier=meta.get("tier", "main"),
                on_camera=shot.get("onCamera", True),
                pitch_mode=args.pitch_mode,
            )
            if meta.get("role"):
                m["characters"][0]["role"] = meta["role"]

            clips.append(video)
            manifests.append(m)
            offsets.append(cursor)
            dur = probe_duration(video)
            cursor += dur
            print(f"  shot {i + 1}/{len(shots)}  {spk:8} {dur:5.2f}s  @{offsets[-1]:6.2f}s")

        concat(clips, args.out_video, tmp)

    merged = heygen.merge(manifests, offsets)
    merged["meta"]["title"] = spec.get("title", args.out_video.stem)
    merged["meta"]["aspectRatio"] = "16:9"
    args.out.write_text(json.dumps(merged, indent=2))

    n = sum(len(l["tokens"]) for c in merged["cues"] for l in c["lines"])
    print(f"\n{args.out_video}: {cursor:.2f}s")
    print(f"{args.out}: {len(merged['characters'])} characters, {len(merged['cues'])} cues, {n} tokens")
    print(f"next: npx cwi assign {args.out}")


if __name__ == "__main__":
    main()
