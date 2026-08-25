"""
HeyGen -> .cwi

What HeyGen gives you, and what it does not:

  video_url      the rendered mp4. Clean, isolated speech — ideal for acoustics.
  subtitle_url   an SRT. CUE-level timings only, no word onsets.
  avatar/voice   whatever you passed in, so speaker identity is exact.

The missing piece is word onsets, and spec 2.2.2 needs them on the first
phoneme. Since the SRT gives the exact text, this is a closed-vocabulary
alignment problem on clean single-speaker audio, which `align.py` handles
without a model. That is a much easier problem than open-vocabulary ASR, and
running ASR here would only introduce transcription errors into text we already
have exactly.

MEASURE THE VOICE, DO NOT TRUST IT. The voice you request is not necessarily
the voice you get. Rendering four characters with four deliberately contrasting
voices (measured from their own preview clips at 101, 124, 199 and 218 Hz)
produced audio at 150-173, 134, 196 and 190 Hz — one character's requested
voice was substituted outright, and the pitch ordering that made the casting
work was destroyed. Confirmed with two independent pitch estimators
(autocorrelation and cepstral), so it is the platform and not the estimator.

`voice_settings.pitch` is ignored on the same avatars: re-rendering two lines
at pitch -8 semitones produced audio measuring 173.3 and 151.2 Hz, identical to
the unshifted renders to the decimal. Both parameters are accepted without
error and silently discarded. Studio avatars appear to have a locked voice.

This is a large part of why the pipeline derives typography from the rendered
audio rather than from the request metadata. The captions stay correct even
when the platform quietly ignores you; only the casting intent is lost, and
that is visible because you can compare the measurement against what you asked
for. If a scene depends on vocal contrast, render a probe clip per character
and check `f0` before committing to the full pass.

Authentication lives with the caller. Pass the signed URLs (from the HeyGen API
or MCP tools) rather than an API key, so this module stays a pure media
transform with no credentials and no network policy of its own.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from urllib.request import urlopen

import acoustics
import align
import prosody
import segment as seg
import transcript as tr


def fetch(url: str, dest: Path) -> Path:
    """Download a signed URL. HeyGen's expire, so fetch close to use."""
    with urlopen(url) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
    return dest


def build(
    video: Path,
    srt: Path,
    *,
    speaker: str = "narrator",
    pitch_mode: str = "voice",
    name: str | None = None,
    tier: str = "main",
    on_camera: bool = True,
    title: str | None = None,
) -> dict:
    """
    Turn one HeyGen render plus its SRT into a manifest.

    A single HeyGen video is one avatar speaking, so it produces one character.
    Compose a multi-character scene by building each render separately and
    merging with `merge()`.
    """
    cues = tr.from_webvtt(srt, default_speaker=speaker)["words"]
    if not cues:
        raise ValueError(f"no text parsed from {srt}")

    with tempfile.TemporaryDirectory() as td:
        wav = acoustics.decode_to_wav(video, Path(td) / "a.wav")
        x, sr = acoustics.read_wav(wav)

    # `from_webvtt` distributes words across each cue by character length. Those
    # timings are an approximation; we keep only the grouping and re-derive the
    # onsets from the audio, which is far more accurate on clean speech.
    utterances: list[tuple[list[str], object, float]] = []
    for group in _group_by_cue(cues):
        a = max(0.0, group[0]["start"] - 0.10)
        b = min(len(x) / sr, group[-1]["end"] + 0.10)
        utterances.append(([w["text"] for w in group], x[int(a * sr):int(b * sr)], a))

    words = align.align_utterances(utterances, sr)

    frames = acoustics.analyze_frames(x, sr)
    for w in words:
        w.update(acoustics.word_features(frames, w["start"], w["end"]))
        w["speaker"] = speaker
    acoustics.stabilize(words, mode=pitch_mode)
    acoustics.to_relative_db(words)

    return {
        "cwi": "1.0",
        "meta": {
            "title": title or video.stem,
            "generator": "cwi-pipeline/adapters/heygen 0.1.0",
            "aspectRatio": "16:9",
        },
        "characters": [{"id": speaker, "name": name or speaker, "tier": tier, "rank": 0}],
        "cues": _cues(seg.segment(words), speaker, on_camera, (x, sr, frames)),
    }


def _group_by_cue(words: list[dict], max_gap: float = 0.35) -> list[list[dict]]:
    """
    Group words into utterances for alignment.

    Only used to bound each alignment pass — the SRT's own cue boundaries are
    line-length driven and make poor captions, so final cueing goes through
    `segment.segment()` afterwards on the realigned words.
    """
    out: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if cur and w["start"] - cur[-1]["end"] > max_gap:
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def _cues(groups: list[list[dict]], speaker: str, on_camera: bool,
           audio: tuple | None = None) -> list[dict]:
    bounds = seg.cue_bounds(groups)
    out = []
    for g, b in zip(groups, bounds):
        cue = _cue(g, speaker, on_camera, *b)
        if audio:
            x, sr, frames = audio
            cue["prosody"] = prosody.cue_features(x, sr, frames, g[0]["start"], g[-1]["end"], len(g))
        out.append(cue)
    return out


def _cue(group: list[dict], speaker: str, on_camera: bool, start: float, end: float) -> dict:
    lines = seg.wrap(group)
    return {
        "id": f"c{int(group[0]['start'] * 1000):07d}",
        "start": start,
        "end": end,
        "speaker": speaker,
        "kind": "dialogue",
        "onCamera": on_camera,
        "lines": [{"tokens": [{
            "text": w["text"],
            "start": round(w["start"], 3),
            "end": round(w["end"], 3),
            **({"db": round(w["db"], 2)} if "db" in w else {}),
            **({"f0": round(w["f0"], 1)} if w.get("f0") else {}),
            **({"centroid": round(w["centroid"], 1)} if w.get("centroid") else {}),
        } for w in line]} for line in lines],
    }


def merge(manifests: list[dict], offsets: list[float] | None = None) -> dict:
    """
    Combine per-character renders into one scene.

    Each HeyGen render is one speaker, so a conversation means several renders
    laid onto a shared timeline. `offsets` shifts each manifest's timings; pass
    the cut points you assembled the edit at.
    """
    if not manifests:
        raise ValueError("nothing to merge")
    offsets = offsets or [0.0] * len(manifests)
    chars: list[dict] = []
    cues: list[dict] = []
    seen: set[str] = set()

    for m, off in zip(manifests, offsets):
        for c in m["characters"]:
            if c["id"] not in seen:
                seen.add(c["id"])
                chars.append({**c, "rank": len(chars)})
        for cue in m["cues"]:
            cues.append({
                **cue,
                "id": f"{cue['speaker']}-{cue['id']}",
                "start": round(cue["start"] + off, 3),
                "end": round(cue["end"] + off, 3),
                "lines": [{"tokens": [{**t,
                                       "start": round(t["start"] + off, 3),
                                       "end": round(t["end"] + off, 3)}
                                      for t in l["tokens"]]} for l in cue["lines"]],
            })

    cues.sort(key=lambda c: c["start"])
    return {
        "cwi": "1.0",
        "meta": {**manifests[0].get("meta", {}), "generator": "cwi-pipeline/adapters/heygen merge 0.1.0"},
        "characters": chars,
        "cues": cues,
    }
