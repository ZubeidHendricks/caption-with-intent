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
