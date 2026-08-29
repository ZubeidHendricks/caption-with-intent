#!/usr/bin/env python3
"""
media + word-timed transcript  ->  Caption with Intention manifest.

    python3 analyze.py --media scene.mp4 --transcript words.json --out scene.cwi.json
    python3 analyze.py --media scene.mp4 --vtt captions.vtt  --out scene.cwi.json

Colours are deliberately NOT assigned here. Assignment is a spec rule with a
CVD-safety search behind it, and it lives once in @cwi/core so every tool agrees:

    npx cwi assign scene.cwi.json
"""
from __future__ import annotations

import argparse
import json
import tempfile
from collections import defaultdict
from pathlib import Path

import acoustics
import prosody
import transcript as tr

import script
import segment as seg

def tier_speakers(counts: dict[str, int]) -> dict[str, tuple[str, int]]:
    """
    Rank speakers into the spec's main / supporting / minor tiers.

    CWI V1.0 asks for the tiering but does not say how to derive it, so this is
    a heuristic on share of dialogue: it is a starting point for an editor, not
    a verdict. Narrative importance and line count are correlated, not the same
    thing — a villain with twelve lines still belongs in `main`.
    """
    order = sorted(counts, key=lambda s: -counts[s])
    total = sum(counts.values()) or 1
    out: dict[str, tuple[str, int]] = {}
    n_main = 0
    for rank, spk in enumerate(order):
        share = counts[spk] / total
        if share >= 0.10 and n_main < 6:
            tier = "main"
            n_main += 1
        elif share >= 0.02:
            tier = "supporting"
        else:
            tier = "minor"
        out[spk] = (tier, rank)
    return out


def in_ranges(t: float, ranges: list[list[float]]) -> bool:
    return any(a <= t <= b for a, b in ranges)


def build(media: Path, data: dict, args) -> dict:
    words = sorted(data["words"], key=lambda w: w["start"])
    if not words:
        raise SystemExit("transcript contains no words")

    # Scripts written without word spaces arrive as one token per phrase, which
    # destroys word-level synchronisation entirely. Re-split them into
    # per-character reveal units before anything downstream sees them.
    words = script.retokenize(words)

    with tempfile.TemporaryDirectory() as td:
        wav = acoustics.decode_to_wav(media, Path(td) / "a.wav")
        x, sr = acoustics.read_wav(wav)
    frames = acoustics.analyze_frames(x, sr)

    # Per-word acoustics.
    for w in words:
        w.update(acoustics.word_features(frames, w["start"], w["end"]))

    # Loudness is normalised per speaker, so the 5% baseline means "this
    # character's normal voice" rather than an absolute level.
    by_speaker: dict[str, list[dict]] = defaultdict(list)
    for w in words:
        by_speaker[w["speaker"]].append(w)
    for group in by_speaker.values():
        acoustics.stabilize(group, mode=args.pitch_mode)
        acoustics.to_relative_db(group)

    counts = {s: len(ws) for s, ws in by_speaker.items()}
    tiers = tier_speakers(counts)
    meta_speakers = data.get("speakers", {})

    characters = []
    for spk, (tier, rank) in sorted(tiers.items(), key=lambda kv: kv[1][1]):
        info = meta_speakers.get(spk, {})
        characters.append({
            "id": spk,
            "name": info.get("name", spk),
            "tier": tier,
            "rank": rank,
            **({"role": info["role"]} if "role" in info else {}),
        })

    groups = seg.segment(words, args.max_gap, args.max_cue, args.max_chars)
    bounds = seg.cue_bounds(groups, args.tail)
    cues = []
    for group, (c_start, c_end) in zip(groups, bounds):
        spk = group[0]["speaker"]
        off = meta_speakers.get(spk, {}).get("offCamera", [])
        mid = (group[0]["start"] + group[-1]["end"]) / 2
        lines = seg.wrap(group, args.max_chars)
        # Prosody is measured per cue, never per word: contour, variation and
        # rate are properties of a phrase. Carried as data, not rendered — see
        # prosody.py on why this is measurement rather than emotion inference.
        pros = prosody.cue_features(x, sr, frames, group[0]["start"], group[-1]["end"], len(group)) \
            if not args.no_prosody else None
        cues.append({
            "id": f"c{int(group[0]['start'] * 1000):07d}",
            "start": c_start,
            "end": c_end,
            "speaker": spk,
            "kind": "dialogue",
            "onCamera": not in_ranges(mid, off),
            **({"prosody": pros} if pros else {}),
            "lines": [{"tokens": [{
                "text": w["text"],
                "start": round(w["start"], 3),
                "end": round(w["end"], 3),
                "db": round(w["db"], 2),
                "f0": round(w["f0"], 1),
                "centroid": round(w["centroid"], 1),
            } for w in line]} for line in lines],
        })

    return {
        "cwi": "1.0",
        "meta": {
            "direction": script.direction(" ".join(w["text"] for w in words)),
            "title": media.stem,
            "generator": "cwi-pipeline/analyze.py 0.1.0",
            "language": data.get("language", "en"),
        },
        "characters": characters,
        "cues": cues,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--media", required=True, type=Path)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--transcript", type=Path, help="word-timed JSON (see transcript.py)")
    src.add_argument("--vtt", type=Path, help="WebVTT; word timings approximated unless inline")
    src.add_argument("--whisperx", action="store_true", help="run WhisperX ASR + diarization")
    src.add_argument("--asr", action="store_true",
                     help="transcribe here with faster-whisper, then separate voices acoustically")
    ap.add_argument("--asr-model", default="small",
                    help="tiny | base | small | medium | large-v3 (default small)")
    ap.add_argument("--language", default=None, help="force a language instead of detecting it")
    ap.add_argument("--diarize", action="store_true",
                    help="separate speakers acoustically (approximate; see diarize.py)")
    ap.add_argument("--hf-token", default=None, help="HuggingFace token, for diarization")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--max-gap", type=float, default=seg.MAX_GAP_S)
    ap.add_argument("--max-cue", type=float, default=seg.MAX_CUE_S)
    ap.add_argument("--max-chars", type=int, default=seg.MAX_CHARS_PER_LINE)
    ap.add_argument("--tail", type=float, default=0.35, help="hold after the last word, seconds")
    ap.add_argument("--no-prosody", action="store_true",
                    help="skip the per-cue prosody measurements")
    ap.add_argument("--pitch-mode", choices=["voice", "word", "raw"], default="voice",
                    help="voice: weight/width identify the character (default, see acoustics.stabilize); "
                         "word: per-word prosody, damped; raw: uncorrected, diagnostics only")
    args = ap.parse_args()

    if args.transcript:
        data = tr.load_json(args.transcript)
    elif args.vtt:
        data = tr.from_webvtt(args.vtt)
    elif args.asr:
        data = tr.from_faster_whisper(
            args.media, model=args.asr_model, language=args.language,
            diarize=args.diarize)
    else:
        data = tr.from_whisperx(args.media, args.hf_token)

    manifest = build(args.media, data, args)
    args.out.write_text(json.dumps(manifest, indent=2))

    n_tok = sum(len(l["tokens"]) for c in manifest["cues"] for l in c["lines"])
    print(f"{args.out}: {len(manifest['characters'])} characters, "
          f"{len(manifest['cues'])} cues, {n_tok} tokens")
    print("next: npx cwi assign", args.out, "  (colour assignment + CVD audit)")


if __name__ == "__main__":
    main()
