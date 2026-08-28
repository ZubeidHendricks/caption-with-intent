#!/usr/bin/env python3
"""
Composite single-speaker renders into ONE frame where every character is
visible at once.

Concatenating clips gives you a scene in the audio but not in the picture: only
one character is ever on screen, so caption colour has nothing to disambiguate.
The situation Caption with Intention actually exists for is several people
present at the same time, where a Deaf viewer cannot tell from the frame alone
which of them is talking.

So each character gets a fixed position held for the whole running time. Their
own footage plays during their lines; between them they hold on a still from
their own clip. The audio timeline is unchanged, which means an existing .cwi
manifest for the concatenated cut applies to the composite without re-timing.

    python3 compose_scene.py scene.json --out wall.mp4
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path


def run(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def probe(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def still(src: Path, at: float, dur: float, out: Path, w: int, h: int, fps: int) -> None:
    """A held frame, as a video segment. Used when a character is not speaking."""
    run("-ss", str(at), "-i", str(src), "-frames:v", "1", str(out.with_suffix(".png")))
    run("-loop", "1", "-i", str(out.with_suffix(".png")), "-t", f"{dur:.3f}",
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps}",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out))


def clip(src: Path, dur: float, out: Path, w: int, h: int, fps: int) -> None:
    run("-i", str(src), "-t", f"{dur:.3f}", "-an",
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps}",
        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", str(out))


def concat(parts: list[Path], out: Path, tmp: Path) -> None:
    lst = tmp / f"{out.stem}.txt"
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    run("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--tile-height", type=int, default=570,
                    help="height of the avatar strip; the remainder is caption space")
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--bg", default="0x16222a",
                    help="must match the background the clips were rendered on, "
                         "or the tile edges and the caption area show as seams")
    args = ap.parse_args()

    spec = json.loads(args.spec.read_text())
    shots = spec["shots"]
    order = list(dict.fromkeys(s["speaker"] for s in shots))   # first-appearance order
    n = len(order)
    tw = args.width // n
    th = args.tile_height

    # Timeline of the concatenated cut: each shot occupies its own clip's span.
    spans: list[tuple[str, Path, float, float]] = []
    cursor = 0.0
    for s in shots:
        p = Path(s["video"])
        d = probe(p)
        spans.append((s["speaker"], p, cursor, cursor + d))
        cursor += d
    total = cursor

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        tracks: list[Path] = []

        for spk in order:
            mine = [(p, a, b) for sp, p, a, b in spans if sp == spk]
            rest = next(p for sp, p, _, _ in spans if sp == spk)   # source for stills
            parts: list[Path] = []
            t = 0.0
            for i, (p, a, b) in enumerate(mine):
                if a - t > 0.04:
                    gap = tmp / f"{spk}_gap{i}.mp4"
                    still(rest, 0.10, a - t, gap, tw, th, args.fps)
                    parts.append(gap)
                live = tmp / f"{spk}_live{i}.mp4"
                clip(p, b - a, live, tw, th, args.fps)
                parts.append(live)
                t = b
            # Overrun the tail deliberately; the final output is trimmed to
            # `total`. Segment durations round to whole frames at every concat
            # boundary, so tracks otherwise end up tens of milliseconds apart
            # and hstack silently truncates to the shortest — which desyncs
            # every tile against the audio.
            tail = tmp / f"{spk}_tail.mp4"
            still(rest, 0.10, max(0.25, total - t + 0.5), tail, tw, th, args.fps)
            parts.append(tail)

            track = tmp / f"{spk}.mp4"
            concat(parts, track, tmp)
            tracks.append(track)
            print(f"  {spk:8} {len(mine)} line(s), track {probe(track):5.2f}s")

        # Extract the scene audio from the concatenated cut.
        audio = tmp / "scene.m4a"
        cat = tmp / "cat.mp4"
        concat([p for _, p, _, _ in spans], cat, tmp)
        run("-i", str(cat), "-vn", "-c:a", "aac", "-ar", "48000", "-ac", "2", str(audio))

        # Side-by-side, then pad down to the full frame — the space below the
        # strip is where the captions live (spec 2.4.3 puts them in the lower
        # fifth, and here they sit clear of every face).
        inputs: list[str] = []
        for t_ in tracks:
            inputs += ["-i", str(t_)]
        filt = "".join(f"[{i}:v]" for i in range(n))
        filt += f"hstack=inputs={n}[row];"
        filt += (f"[row]pad={args.width}:{args.height}:0:0:color={args.bg},"
                 f"format=yuv420p[v]")
        run(*inputs, "-i", str(audio), "-filter_complex", filt,
            "-map", "[v]", "-map", f"{n}:a", "-t", f"{total:.3f}",
            "-c:v", "libx264", "-crf", "22", "-preset", "veryfast",
            "-c:a", "aac", "-movflags", "+faststart", str(args.out))

    print(f"\n{args.out}: {total:.2f}s, {n} characters on screen throughout")


if __name__ == "__main__":
    main()
