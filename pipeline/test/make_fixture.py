"""
Synthesise a three-voice test scene plus its word-timed transcript.

Each 'voice' is a harmonic stack at a known f0 and level, so the pipeline's
output can be checked against ground truth: a bass voice must come out heavy
and wide, a shout must come out large, a whisper small.
"""
from __future__ import annotations
import json, wave, sys
from pathlib import Path
import numpy as np

SR = 16000
OUT = Path(__file__).parent

VOICES = {
    "BASS":  dict(f0=95,  tilt=0.85, name="Kroft",  role="villain"),
    "MID":   dict(f0=175, tilt=0.60, name="Vale",   role="hero"),
    "HIGH":  dict(f0=250, tilt=0.35, name="Ana"),
}

# (speaker, text, gain_db)  — gain relative to a 'normal' -18 dBFS
SCRIPT = [
    ("MID",  "You said the yard was empty",      0),
    ("HIGH", "It was empty an hour ago",         0),
    ("BASS", "Nothing out here is ever empty",   0),
    ("MID",  "Show me your hands",              +9),   # shout
    ("BASS", "You should have stayed",          -14),  # whisper
    ("HIGH", "Vale behind you",                 +9),   # shout
]


def voice(f0: float, tilt: float, dur: float, gain_db: float) -> np.ndarray:
    """Harmonic stack with a spectral tilt, amplitude-enveloped per word."""
    t = np.arange(int(dur * SR)) / SR
    sig = np.zeros_like(t)
    for k in range(1, 25):
        if f0 * k > SR / 2:
            break
        sig += (tilt ** (k - 1)) * np.sin(2 * np.pi * f0 * k * t + k * 0.7)
    sig /= np.max(np.abs(sig)) + 1e-9
    # Simple attack/decay so words are not square-gated.
    env = np.minimum(1.0, np.minimum(t / 0.02, (dur - t) / 0.04))
    sig *= np.clip(env, 0, 1)
    amp = 10 ** ((-18 + gain_db) / 20)
    return (sig * amp).astype(np.float32)


def main() -> None:
    words, chunks, cursor = [], [], 0.5
    for spk, line, gain in SCRIPT:
        v = VOICES[spk]
        for tok in line.split():
            dur = 0.14 + 0.045 * len(tok)
            chunks.append((cursor, voice(v["f0"], v["tilt"], dur, gain)))
            words.append({"text": tok, "start": round(cursor, 3),
                          "end": round(cursor + dur, 3), "speaker": spk})
            cursor += dur + 0.05
        cursor += 0.6

    total = int((cursor + 0.5) * SR)
    buf = np.zeros(total, dtype=np.float32)
    for start, sig in chunks:
        i = int(start * SR)
        buf[i:i + len(sig)] += sig
    buf += np.random.default_rng(7).normal(0, 0.0006, total).astype(np.float32)  # room tone

    wav = OUT / "fixture.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes())

    speakers = {k: {"name": v["name"], **({"role": v["role"]} if "role" in v else {})}
                for k, v in VOICES.items()}
    speakers["BASS"]["offCamera"] = [[0, 8]]  # Kroft's first line is off-screen
    (OUT / "fixture.words.json").write_text(json.dumps(
        {"words": words, "speakers": speakers, "language": "en"}, indent=2))

    print(f"{wav} ({cursor + 0.5:.1f}s), {len(words)} words, {len(VOICES)} speakers")


if __name__ == "__main__":
    main()
