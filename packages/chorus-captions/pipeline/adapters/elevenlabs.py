"""
ElevenLabs -> .cwi

The best case in the whole system. ElevenLabs' `/with-timestamps` endpoints
return character-level alignment alongside the audio, so word onsets are
*exact* — no ASR, no forced alignment, not even the VAD fallback in `align.py`.
Speaker identity is exact too, because you chose the voice.

What remains is measuring loudness, pitch and harmonics from the returned
audio, which is clean, isolated, single-speaker — the ideal input for the DSP
in `acoustics.py`. Every acoustic estimate here is better than anything
achievable on a recorded film mix.

Which is the argument for starting adoption here: for a TTS provider, Caption
with Intention is not a machine-learning problem at all. It is a serialization
feature.

Response shape consumed (v1 `text-to-speech/{voice_id}/with-timestamps`):

    {
      "audio_base64": "...",
      "alignment": {
        "characters":                     ["H", "e", "l", "l", "o", ...],
        "character_start_times_seconds":  [0.0, 0.06, 0.11, ...],
        "character_end_times_seconds":    [0.06, 0.11, 0.15, ...]
      }
    }

`normalized_alignment` has the same shape and is used in preference when
present, since it reflects the text as actually spoken (numbers and
abbreviations expanded).
"""
from __future__ import annotations

import base64
import re
import tempfile
from pathlib import Path

import acoustics
import segment as seg


def words_from_alignment(alignment: dict) -> list[dict]:
    """
    Fold character-level alignment into words.

    A word runs from the start time of its first character to the end time of
    its last. Whitespace characters delimit; punctuation stays attached to the
    preceding word so it renders as part of it.
    """
    chars = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends = alignment["character_end_times_seconds"]
    if not (len(chars) == len(starts) == len(ends)):
        raise ValueError("alignment arrays have mismatched lengths")

    words: list[dict] = []
    buf: list[str] = []
    w_start = 0.0

    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if buf:
                words.append({"text": "".join(buf), "start": w_start, "end": prev_end})
                buf = []
            continue
        if not buf:
            w_start = float(s)
        buf.append(ch)
        prev_end = float(e)

    if buf:
        words.append({"text": "".join(buf), "start": w_start, "end": prev_end})
    return [w for w in words if w["text"].strip()]


def decode_audio(response: dict, dest: Path) -> Path:
    """Write the base64 audio payload to disk."""
    dest.write_bytes(base64.b64decode(response["audio_base64"]))
    return dest


def build(
    response: dict,
    *,
    speaker: str,
    name: str | None = None,
    tier: str = "main",
    role: str | None = None,
    on_camera: bool = True,
    offset: float = 0.0,
    pitch_mode: str = "voice",
    audio: Path | None = None,
) -> dict:
    """
    Build a manifest from one `with-timestamps` response.

    `audio` lets a caller pass an already-decoded file (a wav rendered from the
    mp3, say). Otherwise the base64 payload is decoded to a temp file.
    """
    alignment = response.get("normalized_alignment") or response.get("alignment")
    if not alignment:
        raise ValueError(
            "response has no alignment — call the /with-timestamps endpoint, "
            "not plain text-to-speech"
        )

    words = words_from_alignment(alignment)
    if not words:
        raise ValueError("alignment produced no words")

    with tempfile.TemporaryDirectory() as td:
        src = audio or decode_audio(response, Path(td) / "tts.mp3")
        wav = acoustics.decode_to_wav(Path(src), Path(td) / "tts.wav")
        x, sr = acoustics.read_wav(wav)

    frames = acoustics.analyze_frames(x, sr)
    for w in words:
        w.update(acoustics.word_features(frames, w["start"], w["end"]))
        w["speaker"] = speaker
    acoustics.stabilize(words, mode=pitch_mode)
    acoustics.to_relative_db(words)

    for w in words:
        w["start"] += offset
        w["end"] += offset

    groups = seg.segment(words)
    bounds = seg.cue_bounds(groups)

    character = {"id": speaker, "name": name or speaker, "tier": tier, "rank": 0}
    if role:
        character["role"] = role

    return {
        "cwi": "1.0",
        "meta": {"generator": "cwi-pipeline/adapters/elevenlabs 0.1.0", "language": "en"},
        "characters": [character],
        "cues": [{
            "id": f"{speaker}-c{int(g[0]['start'] * 1000):07d}",
            "start": s,
            "end": e,
            "speaker": speaker,
            "kind": "dialogue",
            "onCamera": on_camera,
            "lines": [{"tokens": [{
                "text": w["text"],
                "start": round(w["start"], 3),
                "end": round(w["end"], 3),
                "db": round(w["db"], 2),
                **({"f0": round(w["f0"], 1)} if w.get("f0") else {}),
                **({"centroid": round(w["centroid"], 1)} if w.get("centroid") else {}),
            } for w in line]} for line in seg.wrap(g)],
        } for g, (s, e) in zip(groups, bounds)],
    }


def synthesize(text: str, voice_id: str, api_key: str, *, model: str = "eleven_multilingual_v2") -> dict:
    """
    Call the with-timestamps endpoint. Thin on purpose — kept out of `build` so
    the transform stays testable without network access or a key.
    """
    import json
    from urllib.request import Request, urlopen

    req = Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps",
        data=json.dumps({"text": text, "model_id": model}).encode(),
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
    )
    with urlopen(req) as r:
        return json.loads(r.read())


_WORD_RE = re.compile(r"\S+")


def split_script(script: str) -> list[str]:
    """Utility: split a script into utterances, one synthesis call each."""
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", script.strip()) if s.strip()]
