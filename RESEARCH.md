# Caption with Intention — Research Brief

_Compiled 2026-08-23. Primary source: `Caption-With-Intention_Design-System_V1.0.pdf` (V1.0 | 2025.1, 56 pp), downloaded from captionwithintention.org._

---

## 1. What it is

A **caption design system** — a written specification plus an After Effects template — not software, not a codec, not a file format. It defines how caption text should look and move so that Deaf and Hard of Hearing (DHH) viewers get the *paralinguistic* layer of dialogue (who's speaking, when, how) that plain caption text throws away.

Created by **FCB Chicago** with the **Chicago Hearing Society** (founded 1916) and **Rakish Entertainment** (LA post house). Driven by **Bruno Mazzotti**, ECD at FCB Chicago and a CODA who grew up in Brazil with two Deaf parents. Concept dates to ~2019; formal co-design ran **Feb–Dec 2024**; released 2025.

The framing premise from the spec: captions were invented in the 1950s (film) / early 1970s (television) and have improved in *accuracy and availability* but never in *expressiveness*. "While captions had become more functional, they still couldn't fully capture the nuance, emotional depth, and necessary clarity intended by the filmmakers."

---

## 2. The three problems it targets

The spec names exactly three shortcomings and organizes the whole system around them.

| # | Problem | Spec's example |
|---|---------|----------------|
| **1. Attribution** | Captions don't reliably say who is speaking — worst in overlapping dialogue, rapid exchange, and off-screen voices. | *The Dark Knight*: the Joker's "Does it depress you, Commissioner?" from off-camera. Hearing viewers get the voice; DHH viewers get an unattributed line and lose the scene's tension. |
| **2. Synchronization** | Caption text is not word-aligned with speech, so comic and emotional timing lands late. | The spec's framing: a family laughs at a joke before the Deaf viewer has reached it. |
| **3. Intonation** | Nothing conveys volume, pitch, or vocal texture. | *Finding Nemo*, *Glengarry Glen Ross* (Baldwin's "Put that coffee down!"). |

---

## 3. The actual specification

### 3.1 Attribution — color

- **Six main-character colors**, described as a spectrum:
  | Name | Hex | RGB |
  |---|---|---|
  | CI Main Yellow | `#E5E517` | 229, 229, 23 |
  | CI Main Blue | `#17E5E5` | 23, 229, 229 |
  | CI Main Red | `#E51717` | 229, 23, 23 |
  | CI Main Orange | `#E58017` | 229, 128, 23 |
  | CI Main Green | `#17E517` | 23, 229, 23 |
  | CI Main Pink | `#E517E5` | 229, 23, 229 |

  _(Note a small internal inconsistency: the body text calls the palette "Yellow, Blue, Red, Orange, Green, and Purple," but the swatch named "Blue" is `#17E5E5` — cyan — and "Pink"/"Purple" is `#E517E5` — magenta. The six are the RGB/CMY primaries at 23/229 levels.)_

- **Placement rules:** with only three main characters, space their colors maximally around the wheel. If the film has a clear **hero and villain, put them opposite each other.**
- **12 supporting-character colors** (`#E85C2E`, `#EBC247`, `#C2EB47`, `#82ED5E`, `#47EB70`, `#5EEDC9`, `#47C2EB`, `#5E82ED`, `#8C6BED`, `#CC6BED`, `#EB47C2`, `#ED5E82`) — chosen to sit *between* the main colors on the wheel, and required to stay visually distant from the mains actually in use (don't put a supporting orange next to a main red).
- **Minor characters:** pastels from the center of the wheel — **fixed S: 30%, B: 90%**, hue stepped around the circle (24 listed hues: 0°, 7°, 24°, 40°, 58°, 73°, 87°, 102°, 120°, 133°, 149°, 162°, 178°, 193°, 207°, 222°, 240°, 251°, 267°, 282°, 298°, 313°, 327°, 342°). This encodes a **hierarchy of character importance** in saturation.
- **Off-camera** speech keeps the character's color and adds *italics* (roman = on-camera).

### 3.2 Synchronization — animation

- **Read-ahead type:** the full line appears first in **white at 90% opacity**, so viewers can read at their own pace — deliberately preserving the existing caption reading behavior.
- **Color sync:** each word is overlaid in the character's color **at the instant the word's first phoneme begins**, not when it ends. The spec is explicit: for "inexplicable," the color flips on *"in-"*, not *"-ble."*
- **Pop motion:** as each word colors, it scales up **15%** then returns, guiding the eye to the exact word being spoken. (A diagram also annotates "25% elevation" for the lift.)
- **Syllable variation:** when a line is delivered syllable-by-syllable ("un-be-liev-able"), the animation may break at syllables instead of words.

### 3.3 Intonation — variable typography

Typeface: **Roboto Flex** (12 variable axes; free/open license), chosen for screen legibility and axis range.

**Volume → type size**, measured as a **percentage of screen height** (resolution-independent — same at 1080p, 4K, 8K, and across 1.85:1, 2.39:1, 16:9, IMAX 1.43:1):
- Baseline (normal speech): **5%** of screen height
- Whisper floor: **3%**
- Shout ceiling: **12%**
- Scaling within range may be set by ear or derived objectively from the waveform.

**Pitch → font weight.** Human speech is taken as 80–250 Hz; the neutral band is **160–200 Hz → Roboto Flex Regular (400)**. Below ~160 Hz → heavier. Above ~200 Hz → lighter.

**Harmonics → font width.** Voices rich in low harmonics → wider/expanded. Dominant high harmonics → narrower/condensed. Weight and width are correlated deliberately, since low pitch and low harmonics co-occur — a thin-condensed bass voice would read as wrong.

### 3.4 Layout and non-speech

- **Captions box:** black at **90% opacity** behind all captions — necessary precisely because the colored, weight-varying type would otherwise fail against arbitrary footage. One exception: very loud/sudden speech **may break out of the box**.
- Box scales with text; **max two lines per frame**.
- **Work area:** the lower **20%** of frame, with safe margins (diagram: 5% / 2.5% / 5% / 7.5%). Nothing extends past it.
- **Sound effects:** white, in `[ ]`, as in classic captions — but they still animate and scale with loudness (thunder pops big).
- **Music:** white descriptors flanked by a music symbol; **not animated, no color**.
- **Exceptions:** for black-and-white or older films, editors may use **animation only, no color attribution**. Explicitly at editorial discretion.

---

## 4. Method and provenance

- **Feb–Dec 2024**, in-person and remote, with the Chicago Hearing Society. Named CHS participants in the doc: **Karla Giese** (Training & Education Coordinator), **Michelle Porter**, **Jason Weiland**.
- Dozens of prototype variations applied to well-known scenes; participants voted via a **custom tablet system**, then gave depth in individual interviews.
- Films used as worked examples in the spec: *Toy Story*, *Kramer vs. Kramer*, *Rocky*, *Scream*, *The Empire Strikes Back*, *Steve Jobs*, *Casino Royale*, *Glengarry Glen Ross*, *Finding Nemo*, *Green Book*, *Avatar*, *Casablanca*, *The Dark Knight*.
- **Stated failure mode of their own early work:** "We were over-indexing initially; we learned subtlety prevents captions from becoming distracting" (Danilo Boer, design partner). The v1 spec is visibly the restrained version of a louder prototype.
- One frequently-quoted testing insight: a participant discovered through the system that **Batman and Bruce Wayne have different voices** — previously invisible to them.

---

## 5. Status, distribution, and the honest caveats

**What's actually shipping:** three downloads from captionwithintention.org — the design system PDF, an **After Effects project template**, and the Roboto Flex TTF. Contact `requests@captionwithintention.org`.

Now the parts press coverage tends to blur:

- **It is manual, not automated.** The spec says so plainly: apply it "using readily available industry tools, such as Adobe After Effects, through an operator-based, manually controlled process." AI-based automation is stated as the *goal*, not a deliverable. At feature length, this is a per-title VFX/motion-design pass — the cost story is nothing like conventional captioning.
- **It cannot currently be delivered as closed captions.** The spec: "the technology used to decode closed captioning has limitations that prevent it from supporting the features of Caption with Intention." Until decoders catch up, delivery is **burned-in open captions**. That means one baked version for everyone — non-toggleable, non-localizable, and it consumes the video essence itself.
- **It does not replace regulated captions.** Because closed captioning is FCC-mandated, the spec positions CWI as **additive**: "Use of Captions with Intention should be **in addition to** the regulated and mandated use of the Closed Captions system." So a compliant deployment ships both.
- **"Open source" is press framing, not a license.** Every page of the PDF is footered **"All Rights Reserved,"** the site marks the system **"Caption with Intention©,"** and there is **no official repository and no license file** — no MIT, Apache, or CC grant anywhere. It is free to download and the team invites adoption, but "open-source" in the trade coverage is doing work the paperwork doesn't back. Anyone building on it commercially should get written clarification first. (Roboto Flex itself is genuinely free under the SIL OFL — that part is unencumbered.)
- **Community implementations exist on GitHub** (`justtimi/caption-with-intention`, `Segyun/Alive-Caption`, `berknerk/easy-caption-with-intention`, `jutopia03/CIG-...`), all unofficial, tiny, and unaffiliated.

**On the Academy claims — worth getting right.** CWI is genuinely listed as a **RAISE partner** (the Academy's Representation and Inclusion Standards Entry program). But the widely repeated line that "the Academy honored the initiative with an Award of Merit" conflates two things: the **2025 Scientific and Technical Awards** gave an Award of Merit to **captioning technology as a field** — "all the individuals who have developed and supported captioning technology, whether open or closed, for film" — accepted by **Marlee Matlin**, with the statuette housed at the Academy Museum. That is not an award to Caption with Intention. Likewise, claims that CWI is now *required* for Best Picture eligibility trace to agency case-study copy and should be verified against the actual Academy rulebook before repeating.

**Awards that are solidly documented:** Cannes Lions 2025 — a **Titanium Lion** plus **three Grands Prix** (Design, Digital Craft, Brand Experience & Activation), making it the most-awarded idea of the year.

**Roadmap the team has stated:** streamer partnerships, live/broadcast captioning tests, multilingual support, onboarding tooling, and AI automation (to be released free and open-source when built).

---

## 6. Academic prior art

CWI is the first *industrial, film-grade, community-validated* system of its kind, but the underlying ideas have a ~20-year research literature. Useful if you want evidence behind specific parameter choices:

- **Rashid, Aitken & Fels (2006), "Expressing Emotions Using Animated Text Captions"** — kinetic typography for emotion in captions; manipulated font color and size across ten emotions (happy, sad, sarcastic, excited, comic, fearful, pleading, questioning, authoritative, angry). The direct ancestor of CWI's approach.
- **Rashid et al., "Emotional Subtitles: A System and Potential Applications for Deaf and Hearing Impaired People"** (CEUR Vol-415) — system design and evaluation.
- **Schlippe et al. (2020), "WaveFont / Visualizing Voice Characteristics with Type Design in Closed Captions"** (Cyberworlds 2020; Arabic variant) — maps acoustic features directly onto type parameters. Closest technical analogue to CWI's pitch→weight, volume→size mapping.
- **CHI 2023, "Visualization of Speech Prosody and Emotion in Captions: Accessibility for Deaf and Hard-of-Hearing Users"** — three studies, 39 DHH participants, on the design space of affective captions (color, boldness, size). Participants' stated priorities: **readability, minimal distraction, intuitiveness, emotional clarity** — which is exactly the tension CWI's team describes hitting when they "over-indexed."

**Where CWI departs from the literature:** it deliberately does *not* try to encode emotion categories (angry, sad). It encodes **measurable acoustic properties** — amplitude, fundamental frequency, harmonic content — plus identity. That is a much more automatable and much less interpretive target, and it's the single most important design decision in the system.

---

## 7. Open questions / gaps worth noting

1. **No stated accessibility floor for the colors.** Six saturated hues on 90% black, distinguished by hue alone, with no documented contrast ratios and no fallback for the ~8% of viewers with color vision deficiency — a real overlap with the DHH audience. Deuteranopia collapses CI Main Red / Green / Orange toward each other.
2. **No caption-rate guidance.** The spec sets type size and box geometry but says nothing about words-per-minute ceilings or minimum on-screen duration, which existing caption standards do specify.
3. **Read-ahead vs. pop-scale conflict.** A word scaling 15% mid-line reflows the rest of the line unless the layout reserves space; the spec doesn't say how. The AE template presumably resolves this — worth inspecting.
4. **Volume mapping is relative to what?** 3–12% of screen height maps to a dB range shown on a chart, but there's no stated normalization (dialogue-normalized? scene-relative? absolute?). A quiet scene and a loud scene would need different anchors.
5. **Localization.** Burned-in open captions are per-language video renders. Multilingual support is on the roadmap but is structurally at odds with the current delivery model.
6. **Formats.** Nothing in WebVTT, SRT, IMSC1/TTML2, or CEA-608/708 expresses per-word color transitions plus variable-font axis animation. WebVTT gets closest (it has cue timings and `::cue` styling, and karaoke-style `<00:00:01.000>` inline timestamps), but variable-axis animation isn't in any deployed caption pipeline. Any real "closed" CWI needs either a TTML2 profile extension or a player-side renderer.

---

## Sources

- [Caption With Intention — official site](https://www.captionwithintention.org/) · [Design System PDF v1.0](https://download.captionwithintention.org/Caption-With-Intention_Design-System_V1.0.pdf) · [After Effects project](https://download.captionwithintention.org/AE%20PROJECT.zip) · [Roboto Flex TTF](https://download.captionwithintention.org/Instal%20Font%20-%20RobotoFlex.ttf)
- [Forbes — Caption With Intention Poised To Make Movies More Immersive For Deaf Viewers](https://www.forbes.com/sites/gusalexiou/2025/09/11/caption-with-intention-poised-to-elevate-movie-experience-for-deaf-audiences/)
- [LBBOnline — Behind the Oscar-Winning Caption Revolution](https://lbbonline.com/news/behind-the-oscar-winning-caption-revolution)
- [Reel Chicago — New caption accessibility system redefines how deaf audiences experience movies](https://reelchicago.com/article/new-caption-accessibility-system-redefines-how-deaf-audiences-experience-movies/)
- [Ad Age — Caption With Intention, Digital and Design: Cannes Lions 2025](https://adage.com/events-awards/cannes-lions/aa-caption-with-intention-digital-design/)
- [Screen Magazine — FCB Chicago's 'Caption with Intention' Wins Two Grand Prix Honors At Cannes Lions](https://screenmag.com/fcb-chicagos-caption-with-intention-wins-two-grand-prix-honors-at-cannes-lions/)
- [Ads of the World — Caption with Intention case study](https://www.adsoftheworld.com/campaigns/caption-with-intention-case-study)
- [Aberdeen — Caption with Intention: Rethinking the Role of Closed Captions](https://aberdeen.io/blog/2026/02/20/caption-with-intention-rethinking-the-role-of-closed-captions/) (captioning vendor's cautious assessment)
- [Academy Scientific & Technical Awards 2025](https://www.oscars.org/sci-tech/ceremonies/2025) · [Academy RAISE standards](https://raise.oscars.org/resources/standards)
- [Variety — Academy 2025 SciTech Awards winners list](https://variety.com/2025/awards/awards/academy-scitech-awards-2025-winners-list-date-1236287483/)
- [CHI 2023 — Visualization of Speech Prosody and Emotion in Captions](https://dl.acm.org/doi/10.1145/3544548.3581511)
- [Rashid et al. — Emotional Subtitles (CEUR Vol-415)](https://ceur-ws.org/Vol-415/paper19.pdf)
- [Schlippe et al. — WaveFont: Visualizing Voice Characteristics with Type Design](https://research-karlsruhe.de/pubs/Cyberworlds2020-Schlippe_WaveFont.pdf)
