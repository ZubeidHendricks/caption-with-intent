"""
A narrator and an on-camera voice at the SAME pitch.

The point is to isolate the thing pitch and timbre cannot see. Both voices here
are built from the identical harmonic stack at the identical f0, so any feature
that looks only at the voice must fail to separate them. What differs is the
*channel*: the narrator is dry and close, the scene voice is in a room, with
early reflections, a late tail, a raised noise floor and the high-frequency
rolloff that distance and a boundary microphone produce.

That is the real-world distinction a viewer sees instantly and the current
diarizer cannot: narration over picture versus somebody talking in the shot.
"""
from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np

SR = 16000
OUT = Path(__file__).parent
RNG = np.random.default_rng(11)

NARRATION = [
    "The yard had been empty for a year",
    "Nobody had asked why until that night",
]
SCENE = [
    "You said this place was clear",
    "It was clear an hour ago",
]
F0 = 165.0          # deliberately identical for both


def voice(dur: float, f0: float = F0, tilt: float = 0.62) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    sig = np.zeros_like(t)
    for k in range(1, 26):
        if f0 * k > SR / 2:
            break
        sig += (tilt ** (k - 1)) * np.sin(2 * np.pi * f0 * k * t + k * 0.5)
    sig /= np.max(np.abs(sig)) + 1e-9
    env = np.clip(np.minimum(t / 0.02, (dur - t) / 0.04), 0, 1)
    return (sig * env).astype(np.float32)


def roomify(x: np.ndarray) -> np.ndarray:
    """
    Put a dry signal in a room.

    Early reflections plus an exponentially decaying tail, then a gentle
    low-pass for the high-frequency loss that distance and a real microphone
    give you. Crude next to a measured impulse response and entirely sufficient
    to make the point: none of this changes the pitch.
    """
    ir = np.zeros(int(0.35 * SR), dtype=np.float32)
    ir[0] = 1.0
    for delay_ms, gain in ((11, 0.5), (17, 0.42), (23, 0.35), (31, 0.3)):
        ir[int(delay_ms * SR / 1000)] += gain
    tail = np.arange(len(ir)) / SR
    ir += (RNG.normal(0, 1, len(ir)) * np.exp(-tail / 0.11) * 0.16).astype(np.float32)

    wet = np.convolve(x, ir)[:len(x)]
    # One-pole low-pass: distance and a boundary mic cost you the top end.
    a = 0.36
    out = np.zeros_like(wet)
    acc = 0.0
    for i, v in enumerate(wet):
        acc = a * v + (1 - a) * acc
        out[i] = acc
    return (out / (np.max(np.abs(out)) + 1e-9)).astype(np.float32)


def main() -> None:
    words, chunks = [], []
    cursor = 0.4

    def say(text: str, speaker: str, room: bool, gain_db: float) -> None:
        nonlocal cursor
        for tok in text.split():
            dur = 0.16 + 0.045 * len(tok)
            sig = voice(dur)
            if room:
                sig = roomify(sig)
            sig = sig * (10 ** ((-18 + gain_db) / 20))
            chunks.append((cursor, sig))
            words.append({"text": tok, "start": round(cursor, 3),
                          "end": round(cursor + dur, 3), "speaker": speaker})
            cursor += dur + 0.05
        cursor += 0.55

    # Alternating, the way a documentary cuts between them.
    say(NARRATION[0], "NARRATOR", room=False, gain_db=0)
    say(SCENE[0], "ONCAM", room=True, gain_db=-3)
    say(NARRATION[1], "NARRATOR", room=False, gain_db=0)
    say(SCENE[1], "ONCAM", room=True, gain_db=-3)

    total = int((cursor + 0.4) * SR)
    buf = np.zeros(total, dtype=np.float32)
    for start, sig in chunks:
        i = int(start * SR)
        buf[i:i + len(sig)] += sig

    # A scene has a floor; a narration booth has much less of one. Apply the
    # room's noise only under the scene lines, which is what the microphone
    # would have picked up.
    room_noise = RNG.normal(0, 0.004, total).astype(np.float32)
    mask = np.zeros(total, dtype=np.float32)
    for w in words:
        if w["speaker"] == "ONCAM":
            i0, i1 = int((w["start"] - 0.15) * SR), int((w["end"] + 0.25) * SR)
            mask[max(0, i0):min(total, i1)] = 1.0
    buf += room_noise * mask
    buf += RNG.normal(0, 0.0004, total).astype(np.float32)      # booth floor

    wav = OUT / "narration.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes())

    (OUT / "narration.words.json").write_text(json.dumps({
        "words": words,
        "speakers": {"NARRATOR": {"name": "Narrator"}, "ONCAM": {"name": "On camera"}},
        "language": "en",
    }, indent=2))
    print(f"{wav} ({cursor + 0.4:.1f}s), {len(words)} words, 2 voices at the same f0")


if __name__ == "__main__":
    main()
