# Building the AI, and getting everyone to use it

Two problems, and they are not the same problem. The AI is the tractable one.

---

## 1. The strategic call: the format is the product

The instinct is to build a great renderer and show it to CapCut. That loses, because CapCut already has a renderer. What no platform has is a **way to represent CWI data** — and until that exists, every integration is a bespoke one-off that dies with the engineer who built it.

So this repo is layered deliberately:

| Layer | What it is | Who owns it long-term |
|---|---|---|
| **`.cwi` manifest** | Interchange format: per-word timing, speaker attribution, acoustics *or* resolved typography | An open spec — the thing to standardise |
| **`cwi-core`** | Reference implementation of the spec's math: palettes, acoustics→type mapping, CVD-safe colour assignment, validation | Us, as the conformance reference |
| **Renderers** | `cwi-web` (DOM + variable font), ASS burn-in, After Effects | Us for reference; platforms write their own |
| **Analyzer** | media → `.cwi` | Us, and eventually the platforms' own ASR stacks |

A platform adopting CWI should have to write *one* thing: a renderer against a format whose semantics are already pinned down and whose correctness they can test against a reference. Everything else — what colour is character 4, how loud is "loud", how do you break the line — is already decided, in code, identically for everyone.

**Corollary: `cwi-core` must have zero dependencies and stay small.** It does. It is the piece that has to survive being vendored into a Rust compositor, a Swift player, and a Skia canvas.

---

## 2. The AI pipeline

Here is the thing worth internalising: **Caption with Intention is unusually automatable, and the reason is a design decision the FCB team made deliberately.**

Twenty years of academic work on expressive captions tried to encode *emotion categories* — angry, sarcastic, pleading. That requires interpretation, it doesn't generalise, and it is impossible to validate. CWI instead encodes **measurable acoustic properties**: amplitude → type size, fundamental frequency → weight, harmonic distribution → width. Those are DSP, not inference. `pipeline/acoustics.py` computes all three in numpy, in real time, with no model, and its f0 estimate matches ground truth to 0.1 Hz.

So the pipeline is seven stages, and **only three need a model**:

```
media
  │
  ├─ 1. ASR + forced alignment ──────────────── MODEL   word-level onsets
  ├─ 2. Speaker diarization ────────────────── MODEL   who spoke when
  ├─ 3. Character identification ───────────── MODEL   SPEAKER_00 → "Kroft"
  │
  ├─ 4. Acoustic feature extraction ────────── DSP     db / f0 / centroid per word
  ├─ 5. Tiering + colour assignment ────────── RULES   spec 2.1 + CVD-safety search
  ├─ 6. Cue segmentation + line breaking ───── RULES   turn/gap/duration/balance
  └─ 7. Validation ─────────────────────────── RULES   structural + accessibility audit
  │
  └─→ .cwi manifest → renderer
```

### Stage detail

**1. ASR + forced alignment.** Whisper `large-v3` for transcription, then wav2vec2 forced alignment for word onsets. Raw Whisper segment timings are *not good enough*: spec 2.2.2 requires the colour to flip on a word's first phoneme, and segment-level timing misses that by 100–400 ms — which is precisely the synchronization failure the whole system exists to fix. `WhisperX` bundles both. Implemented in `pipeline/transcript.py:from_whisperx`.

**2. Diarization.** `pyannote.audio` 3.1. Note this gives you `SPEAKER_00`, not a character. Overlapping speech is the weak spot, and overlapping speech is exactly where attribution matters most — flag those regions for human review rather than guessing.

**3. Character identification.** Two paths, and you want both:
- *Script-anchored:* if a screenplay exists, align the transcript to it. This is a solved text-alignment problem and gives you names, scene boundaries, and parentheticals for free.
- *Voice-print enrollment:* one clean sample per principal cast member, then speaker verification against the diarized turns. Robust across a series, which matters — colour assignment should be **stable across every episode**, and nothing in CWI V1.0 says so.

An LLM pass over the script also fills in `tier` and the `hero`/`villain` roles that drive the hue-opposition rule.

**4. Acoustics.** Done, tested. Two things worth knowing:
- Loudness is normalised **per speaker**, using a modal estimator over their word levels. The spec maps volume onto 3–12% but never says what the 5% baseline is anchored to — an unfixed gap. Anchoring per speaker means a quiet scene reads correctly and a soft-spoken actor isn't permanently captioned at 3%. (An early mean-based version anchored on the shouts and captioned normal speech as quiet. The modal estimator fixes it.)
- Run this on the **dialogue stem** if you have one. Against a full mix, music and effects contaminate every estimate. Where stems are unavailable, a source-separation pass (Demucs) first is a large quality win.

**5. Colour assignment.** Rules, in `cwi-core`. Implements the spec's hue-spacing and hero/villain opposition — plus a CVD-safety constraint the spec does not have and needs (see §4).

**6. Segmentation.** Split on speaker change, pause > 0.7 s, duration > 6 s; balance lines. All configurable, all conventional caption practice, none of it specified by CWI.

**7. Validation.** `cwi validate` — structural checks plus a colour audit. Wire it into CI.

### What is genuinely hard

- **On/off camera detection** (spec 2.1.5 obliques off-camera speech). This needs active-speaker detection — TalkNet-ASD or LightASD, correlating lip motion with the audio track. It is the least mature stage and the most likely to need human correction. Currently an input to the pipeline, not an output.
- **Overlapping dialogue.** Diarization degrades, acoustics contaminate, and the spec's two-line limit means you physically cannot show three simultaneous speakers.
- **Syllable-level animation** (spec 2.2.4) needs phoneme alignment, which forced alignment gives you but no current tooling exposes cleanly.

### Human in the loop is not optional

Spec 3.1 makes editorial exceptions explicit — a black-and-white film may use animation without colour, "at the discretion of the editor". Any product here needs a review UI where an operator can reassign a colour, correct a speaker, override a size, and mark a cue off-camera. Ship the automation as a **first pass that is 90% right**, not as a black box. That is also how you build the corpus you need to improve stages 1–3.

---

## 3. Getting platforms to adopt it

Sequence by **where the acoustics are already free**. This is the whole insight.

### Tier 1 — synthetic speech. Start here.

**ElevenLabs, HeyGen, Synthesia, and every AI-video/TTS tool.**

When a machine *generates* the speech, stages 1–4 collapse to nothing:

| Pipeline stage | Recorded film | Synthetic speech |
|---|---|---|
| Word onsets | ASR + forced alignment, error-prone | **Exact** — the aligner emits them |
| Speaker identity | Diarization + voice-print | **Exact** — you chose the voice |
| f0 / loudness | Estimated from a contaminated mix | **Exact** — the synthesizer set them |
| On/off camera | Active-speaker detection, hard | **Known** — you composited the shot |

ElevenLabs already returns character-level alignment timestamps. HeyGen knows exactly which avatar is speaking, when, and how loud. For these platforms CWI is not an ML problem at all — it is a **serialization feature**. Emitting a `.cwi` alongside the audio is a few days of work, and the output is more accurate than anything achievable on recorded film.

That makes them the beachhead: fastest to integrate, highest output quality, and it produces a public corpus of correct CWI content that everything downstream can point at.

**Both adapters are implemented** (`pipeline/adapters/`), and the HeyGen one is verified end to end against a real render — SRT plus audio in, validated manifest out, rendered over the source video in the demo. The two providers need different amounts of help:

- **ElevenLabs** returns character-level alignment, so word onsets are exact. Nothing to estimate. `adapters/elevenlabs.py` folds characters into words and measures acoustics off the returned audio. This is the ideal case in the entire system.
- **HeyGen** returns an SRT, which is cue-level only — no word onsets, and spec 2.2.2 needs them on the first phoneme. But the SRT gives the exact text, so this becomes closed-vocabulary alignment on clean single-speaker audio, which `align.py` solves without a model: energy-based voice activity detection, a small dynamic program to distribute known words across the detected segments, then boundary snapping to local energy minima. Measured against ground truth: **median onset error 45 ms, p90 78 ms, 97% within 100 ms**. Running ASR here would be strictly worse — it could only introduce transcription errors into text we already have exactly.

One caveat that shapes the integration: a HeyGen render is *one avatar speaking*, so it produces one character. A conversation means several renders merged onto a shared timeline (`build_scene.py`, which derives offsets from actual clip durations rather than declared ones).

**And one finding that should change how you build on any of these platforms: measure the voice, do not trust it.** A four-hander was cast by measuring each candidate voice's preview — 101, 124, 199 and 218 Hz, deliberately spread so the weight axis would separate the characters. The rendered audio came back at 150–173, 134, 196 and 190 Hz. One character's requested voice was substituted outright and the pitch ordering that made the casting work was destroyed. Verified with two independent pitch estimators, and a controlled re-render at `voice_settings.pitch: -8` produced audio identical to the unshifted version *to the decimal* — so both `voice_id` and `pitch` were accepted without error and silently discarded on those studio avatars.

The captions were still correct, because the pipeline derives typography from the rendered audio rather than from the request. That is the argument for measuring rather than declaring, and it applies to every provider: the metadata describes what you asked for, the audio describes what the viewer will actually hear. Render a probe clip per character and check `f0` before committing to a full pass.

### Tier 2 — editors with existing auto-captions

**CapCut, Descript, Premiere, DaVinci Resolve, Final Cut.**

They already run ASR with word timings and already render styled captions. What they need:
1. A colour-assignment step (`cwi-core`, vendored — it's dependency-free for this reason).
2. Acoustic analysis on the audio they already have decoded.
3. Variable-font rendering in their compositor. **This is the real blocker.** Most NLE title engines predate variable fonts and expose weight as a discrete family choice, not a continuous axis. Without axis interpolation you lose the entire intonation layer.

CapCut specifically: consumer-scale, template-driven, already leans hard on animated kinetic captions. It's the closest thing to a natural fit, and the audience overlap with people who'd notice is enormous. Approach it as a caption *template* backed by a real spec, not as an accessibility compliance feature.

### Tier 3 — web and OTT players

**Video.js, Shaka Player, hls.js, JW Player.**

`cwi-web` already does this — it overlays any `HTMLMediaElement` and measures the letterboxed frame correctly. A plugin for each is small. This is the cheapest route to *closed* (toggleable) CWI, because the browser has variable fonts natively and you're not fighting a codec. Worth doing early, because it's the only path that demonstrates CWI as a genuine closed caption rather than burned-in pixels.

### Tier 4 — streamers and broadcast

**Netflix, Disney+, Max, and the standards bodies.**

The long game, and the one the spec itself flags (3.2): no deployed decoder can carry this. Concretely, nothing in WebVTT, SRT, CEA-608/708, or IMSC1/TTML2 can express per-word colour transitions *plus* variable-font axis animation. The realistic route is a **TTML2 profile extension** — TTML2 has the extensibility hooks and IMSC is already the streaming interchange format — paired with a player-side renderer. That is a multi-year standards effort, and it should start now precisely because it is slow.

Until then, delivery is burned-in open captions, per spec 3.2, **in addition to** regulated closed captions, per spec 3.4.

### The export ladder, and being honest about it

`cwi to-vtt` and `cwi to-ass` exist so you can ship *something* on every platform today. Both are lossy, and both print exactly what they dropped:

- **WebVTT** keeps speaker identity (as cue classes) and word timing. Loses all typography.
- **ASS/libass** keeps colour, per-word size, karaoke timing, and the box. **Loses weight and width entirely** — libass has no variable-axis support, so the whole pitch/harmonics layer is gone.

The only faithful burn-in paths are the After Effects project or rendering `cwi-web` offscreen and compositing. Never let a lossy export ship as "CWI support" without saying what's missing — a silently degraded accessibility feature is worse than one you chose not to ship.

---

## 4. Three things you should fix in the spec while you're at it

**The palette is not colour-vision safe.** Run `cwi palette`:

```
normal        all pairs distinguishable
protanopia    Yellow/Green ΔE6.0
deuteranopia  Yellow/Green ΔE18.0  Green/Orange ΔE10.7  Red/Orange ΔE14.1
tritanopia    Green/Blue ΔE11.8
```

CWI V1.0 distinguishes speakers by hue alone and documents no contrast floor and no CVD fallback. Assign Red and Orange to two leads and a deuteranopic viewer — roughly 6% of men, a population that overlaps the DHH audience — cannot tell those two characters apart. That doesn't degrade the feature; it defeats it. `CI Main Red` also fails WCAG AA against the caption box at 3.70:1.

`assignColors()` therefore adds a CVD-safety search on top of the spec's hue rules, drawing only from the spec's own swatches. It roughly doubles worst-case separation, and when no assignment clears the floor it **says so** instead of degrading quietly. Toggle it live in the demo to see the collision happen.

**Ship this finding upstream.** It is the single most valuable contribution this repo can make back to CWI, and it's the kind of thing the team explicitly invited ("not complete without your input").

**Weight and width are per-voice, not per-word — say so explicitly.** Section 2.3.8 talks about "voices" and the examples contrast characters, but nothing states outright that the weight and width axes describe *whose voice this is* rather than how each individual word was delivered. Implementers will read it the other way, and the result is unusable: per-word f0 on short function words is estimator noise, and we measured a single synthetic voice reading one sentence evenly coming out between `wght` 400 and 845 word to word. One sentence in 2.3.8 would prevent every implementation from rediscovering this.

The same applies to the size axis in the other direction. Size *is* per word, but ordinary speech varies ~15 dB from stress alone; without a compression rule, an evenly-read line pulses. The spec should say what the 5% baseline is anchored to and how much of the 3–12% range ordinary prosody is allowed to consume.

**Licensing needs resolving before anyone builds a business on it.** The trade press universally calls CWI open-source. The PDF is footered *All Rights Reserved* on every page, the system is marked ©, and there is no repository and no licence file — no MIT, Apache, or CC grant anywhere. It's free to download and adoption is invited, but the paperwork doesn't say what the press says. Get written clarification from `requests@captionwithintention.org` before commercial deployment. (Roboto Flex itself is genuinely unencumbered under the SIL OFL.)

---

## 5. Suggested sequencing

1. **Now** — harden the format, publish the schema, get `cwi-core` conformance-tested. Send the CVD finding and the per-voice reading to the CWI team.
2. **Done** — Tier 1 adapters for HeyGen and ElevenLabs, with HeyGen verified end to end on a real render. Next step here is a real title, not more code: pick something short, run it through, and put it in front of DHH viewers.
3. **Then** — a player plugin (Shaka or Video.js) to prove *closed* CWI is possible, not just burned-in.
4. **Then** — an editor. CapCut if you can get the conversation; Descript or Resolve if you want a shorter path via plugin APIs.
5. **In parallel, slowly** — the TTML2 profile work, because standards take years and nothing else unlocks broadcast.
