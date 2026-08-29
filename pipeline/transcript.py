"""
Adapters producing the word-timed, speaker-labelled transcript that
`analyze.py` consumes.

The contract is deliberately small so any ASR/diarization stack can satisfy it:

    {
      "words": [{"text": "You", "start": 1.20, "end": 1.41, "speaker": "S0"}, ...],
      "speakers": {"S0": {"name": "Detective Vale", "offCamera": [[6.9, 9.2]]}}
    }

Keeping the heavy models behind this boundary means the acoustic and typographic
stages stay deterministic and testable, and a platform that already has word
timings (most editors and dubbing tools do) can skip ASR entirely.
"""
from __future__ import annotations

import json
from pathlib import Path


def load_json(path: Path) -> dict:
    data = json.loads(Path(path).read_text())
    if "words" not in data:
        raise ValueError("transcript must contain a 'words' array")
    return data


def from_faster_whisper(
    media: Path,
    model: str = "small",
    language: str | None = None,
    diarize: bool = False,
) -> dict:
    """
    ASR with word-level timestamps, via faster-whisper.

    This is the path that makes "drop in a video and get captions" true without
    asking the operator for a transcript. It runs on CPU, needs no token and no
    gated model, and downloads its weights once.

    What it does NOT give is who spoke. Whisper transcribes; it does not
    diarize, and speaker attribution is the entire point of this design — colour,
    position and marks all answer "who is talking".

    `diarize=True` clusters voices acoustically, and it is off by default
    because it was measured and found wanting rather than assumed to work. On
    the demo scene two of the four speakers sit 4% apart in median pitch, which
    is inside the range one person moves through in a sentence; nothing built on
    pitch and timbre can separate them. See diarize.py for what was tried.

    One speaker with a note saying so is a usable caption track. Four speakers
    coloured as each other is not, and is indistinguishable from a correct one
    at a glance. So the default is honest rather than impressive.

    `model` trades accuracy for time: tiny, base, small, medium, large-v3.
    "small" transcribes faster than real time on a laptop and is markedly
    better than "base" on film dialogue.
    """
    from faster_whisper import WhisperModel  # imported lazily; it is optional

    # int8 on CPU is several times faster than float32 and the difference in
    # word error rate is not visible at caption granularity.
    asr = WhisperModel(model, device="cpu", compute_type="int8")
    segments, info = asr.transcribe(
        str(media),
        language=language,
        word_timestamps=True,
        # Whisper hallucinates fluent text over music and silence. The VAD
        # filter is the single most effective guard against a caption track
        # confidently transcribing a score.
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )

    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "speaker": "S0",
                # Kept for the evaluation layer: a low-probability word is one
                # the captions should not be confident about either.
                "confidence": round(float(w.probability), 3),
            })

    if not words:
        raise ValueError(
            "Speech recognition found no words. If this is music or effects only, "
            "that is the correct answer; otherwise check the audio track."
        )

    speakers = {"S0": {"name": "Speaker 1"}}
    if diarize:
        from diarize import diarize_by_voice
        speakers = diarize_by_voice(media, words)

    return {"words": words, "speakers": speakers,
            "language": language or getattr(info, "language", None) or "en"}


def from_whisperx(media: Path, hf_token: str | None = None, model: str = "large-v3") -> dict:
    """
    ASR + forced alignment + diarization via WhisperX.

    Requires Python >= 3.10 and `pip install whisperx`. Not exercised by the
    test suite — it downloads multi-GB models — but this is the intended
    production path, and it is the only stage here that needs a GPU.
    """
    import whisperx  # type: ignore

    device = "cuda" if _has_cuda() else "cpu"
    audio = whisperx.load_audio(str(media))

    asr = whisperx.load_model(model, device, compute_type="float16" if device == "cuda" else "int8")
    result = asr.transcribe(audio, batch_size=16)

    # Forced alignment is what produces reliable word-level onsets. CWI needs
    # the colour to flip on a word's first phoneme (spec 2.2.2), so segment-level
    # timings from raw ASR are not good enough.
    align_model, meta = whisperx.load_align_model(language_code=result["language"], device=device)
    result = whisperx.align(result["segments"], align_model, meta, audio, device, return_char_alignments=False)

    if hf_token:
        diarize = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
        result = whisperx.assign_word_speakers(diarize(audio), result)

    words = []
    for seg in result["segments"]:
        for w in seg.get("words", []):
            if w.get("start") is None:
                continue
            words.append({
                "text": w["word"].strip(),
                "start": float(w["start"]),
                "end": float(w["end"]),
                "speaker": w.get("speaker", "UNKNOWN"),
            })
    return {"words": words, "speakers": {}}


def from_webvtt(path: Path, default_speaker: str = "S0") -> dict:
    """
    Parse a WebVTT file, using inline `<00:00:01.000>` timestamps when present.

    Most caption files have no word timings, in which case words are distributed
    across the cue proportionally to length. That is an approximation, and it is
    the single biggest quality difference between a real CWI pass and a
    retrofitted one — the spec's whole synchronization mechanic depends on the
    colour flipping exactly on the word's onset.
    """
    import re

    text = Path(path).read_text(encoding="utf-8-sig")
    ts = r"(\d{2}:)?\d{2}:\d{2}[.,]\d{3}"

    def secs(s: str) -> float:
        s = s.replace(",", ".")
        parts = [float(p) for p in s.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0.0)
        return parts[0] * 3600 + parts[1] * 60 + parts[2]

    words: list[dict] = []
    blocks = re.split(r"\n\s*\n", text)
    for block in blocks:
        m = re.search(rf"({ts})\s*-->\s*({ts})", block)
        if not m:
            continue
        start, end = secs(m.group(1)), secs(m.group(3))
        body = block[m.end():].strip()
        # Speaker tags: "<v Detective Vale>" or a leading "NAME:".
        speaker = default_speaker
        vm = re.search(r"<v\s+([^>]+)>", body)
        if vm:
            speaker = vm.group(1).strip()
            body = re.sub(r"</?v[^>]*>", "", body)
        else:
            nm = re.match(r"^([A-Z][A-Z .'-]{1,24}):\s*", body)
            if nm:
                speaker = nm.group(1).strip()
                body = body[nm.end():]

        inline = re.findall(rf"<({ts})>([^<]*)", body)
        if inline:
            for i, (t, chunk) in enumerate(inline):
                toks = chunk.split()
                if not toks:
                    continue
                w_start = secs(t)
                w_end = secs(inline[i + 1][0]) if i + 1 < len(inline) else end
                step = (w_end - w_start) / len(toks)
                for j, tok in enumerate(toks):
                    words.append({"text": tok, "start": w_start + j * step,
                                  "end": w_start + (j + 1) * step, "speaker": speaker})
        else:
            toks = re.sub(r"<[^>]*>", "", body).split()
            if not toks:
                continue
            # Distribute by character length, which tracks duration better than
            # an even split.
            total = sum(len(t) for t in toks)
            cursor = start
            for tok in toks:
                dur = (end - start) * (len(tok) / total)
                words.append({"text": tok, "start": cursor, "end": cursor + dur, "speaker": speaker})
                cursor += dur
    return {"words": words, "speakers": {}}


def _has_cuda() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False
