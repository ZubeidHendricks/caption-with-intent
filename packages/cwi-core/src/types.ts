/**
 * Caption with Intention — interchange types.
 *
 * Design note: a manifest may carry EITHER measured acoustics (`db`, `f0`,
 * `centroid`) or resolved typography (`size`, `wght`, `wdth`), or both.
 * Analyzers should emit acoustics; renderers resolve them through
 * `resolveToken()` using their own `CwiOptions`. This keeps the perceptual
 * mapping tunable downstream instead of baking it into the file — which is
 * what lets a platform adjust for its own display conditions without
 * re-analyzing the audio.
 */

export type CharacterTier = 'main' | 'supporting' | 'minor';

/** Narrative role. Only used to satisfy the spec's hero/villain opposition rule. */
export type NarrativeRole = 'hero' | 'villain' | 'neutral';

export interface Character {
  id: string;
  name?: string;
  tier: CharacterTier;
  role?: NarrativeRole;
  /** Assigned caption colour, `#RRGGBB`. Fill with `assignColors()` if absent. */
  color?: string;
  /** Rank within tier, 0 = most prominent. Drives deterministic colour order. */
  rank?: number;
  /**
   * Horizontal placement of this character's captions.
   *
   * A non-colour attribution channel: colour alone fails WCAG 2.2 SC 1.4.1
   * (Level A) for any scene with more than one speaker. Set by `assignColors`
   * when the profile carries `position`, and ignored by profiles that do not.
   */
  position?: 'left' | 'center' | 'right';
  /**
   * A small mark shown before this character's captions.
   *
   * Assigned only when the cast outgrows the available positions, so ordinary
   * scenes stay unmarked. Marking some speakers and not others would be worse
   * than marking none, so it is applied to the whole cast or to none of it.
   */
  glyph?: string;
}

/** Per-word acoustic measurements, as produced by the analyzer. */
export interface TokenAcoustics {
  /** Loudness of this word relative to the speaker's dialogue reference, in dB. 0 = normal speech. */
  db?: number;
  /** Median fundamental frequency (pitch) over the word, in Hz. */
  f0?: number;
  /** Spectral centroid over the word, in Hz. Proxy for harmonic distribution. */
  centroid?: number;
}

/** Fully resolved typographic state for one word. */
export interface TokenStyle {
  /** Type size as a percentage of frame height. Spec range 3–12, baseline 5. */
  size: number;
  /** Roboto Flex `wght` axis, 100–1000. Spec baseline 400. */
  wght: number;
  /** Roboto Flex `wdth` axis, 25–151. Normal 100. */
  wdth: number;
}

export interface Token extends TokenAcoustics, Partial<TokenStyle> {
  text: string;
  /** Seconds. Colour flips at `start` — the onset of the word's first phoneme. */
  start: number;
  end: number;
  /**
   * Optional syllable subdivision (spec 2.2.4). When present the renderer
   * animates each syllable rather than the whole word.
   */
  syllables?: Array<{ text: string; start: number; end: number }>;
}

export type CueKind = 'dialogue' | 'sfx' | 'music';

export interface CueLine {
  tokens: Token[];
}

export interface Cue {
  id?: string;
  start: number;
  end: number;
  /** Character id. Omitted for `sfx` and `music`, which are always white. */
  speaker?: string;
  kind: CueKind;
  /** Spec 2.1.5: off-camera speech is obliqued. */
  onCamera?: boolean;
  /** Max two per frame (spec 2.4.2). Validation warns beyond that. */
  lines: CueLine[];
  /** Spec 2.4.1 exception: sudden loud speech may break the containing box. */
  breakout?: boolean;
}

export interface CwiMeta {
  title?: string;
  /** Presentation aspect ratio, e.g. "16:9", "1.85:1", "2.39:1", "1.43:1". */
  aspectRatio?: string;
  frameRate?: number;
  language?: string;
  /** Free-text provenance: analyzer version, operator, review status. */
  generator?: string;
}

export interface CwiManifest {
  /** Format version. */
  cwi: '1.0';
  /**
   * Caption design profile. Defaults to `cwi-1.0`, the published spec.
   * `open-1.0` uses a colour-vision-safe palette and adds position as a second
   * attribution channel. See profiles.ts.
   */
  profile?: string;
  meta?: CwiMeta;
  options?: Partial<CwiOptions>;
  characters: Character[];
  cues: Cue[];
}

/**
 * Tunable constants. Defaults are the literal values in
 * "Caption With Intention — Design System and Caption Guidelines V1.0 (2025.1)".
 * Anything not fixed by the spec is marked INFERRED and explained.
 */
export interface CwiOptions {
  // --- Volume -> type size (spec 2.3.5, 2.3.6) ---
  /** % of frame height at normal speaking volume. Spec: 5. */
  baselineSizePct: number;
  /** % of frame height floor (whisper). Spec: 3. */
  minSizePct: number;
  /** % of frame height ceiling (shout). Spec: 12. */
  maxSizePct: number;
  /**
   * INFERRED. The spec gives the size range but not the dB span it maps onto.
   * These set how many dB below/above the speaker's dialogue reference level
   * drive the size to the floor/ceiling.
   */
  quietRangeDb: number;
  loudRangeDb: number;
  /**
   * INFERRED. Half-width of the soft knee around the baseline, in dB. Level
   * changes inside this band are compressed to `dbKneeSizePct`, keeping normal
   * prosodic variation from reading as deliberate volume.
   */
  dbKneeDb: number;
  /** INFERRED. Size change, in % of frame height, at the edge of the knee. */
  dbKneeSizePct: number;

  // --- Pitch -> weight (spec 2.3.8, 2.3.9) ---
  /** Neutral pitch band, Hz. Spec: 160–200 -> Roboto Regular 400. */
  neutralF0: [number, number];
  /** Pitch bounds, Hz. Spec cites 80–250 as the typical voice range. */
  f0Range: [number, number];
  /** Weight at the low-pitch bound and at the high-pitch bound. */
  weightRange: [number, number];
  /** Weight inside the neutral band. Spec: 400. */
  baselineWeight: number;

  // --- Harmonics -> width (spec 2.3.9) ---
  /**
   * INFERRED units, and NEEDS CORPUS CALIBRATION. The spec's chart axis is
   * ambiguous (see docs/SPEC-NOTES.md); we follow the prose — energy low in the
   * spectrum reads fuller, so it maps wider — using spectral centroid in Hz.
   *
   * Calibrated against the median centroid over VOICED frames, which is what
   * the analyzer produces. That runs well below a full-band speech centroid,
   * because unvoiced consonants — which carry most of the high-frequency
   * energy — are deliberately excluded so they cannot drag the estimate.
   * Feeding a full-band centroid through these bounds reads far too condensed.
   *
   * The default spans 700-1700 Hz, measured across 17 real voices (synthesised
   * and rendered) whose voiced-frame centroids ran 770-1569 Hz. An earlier
   * 450-2000 guess was too wide: every real voice landed in the middle of the
   * width axis and the axis carried almost no information.
   */
  centroidRange: [number, number];
  /** Roboto Flex wdth at the low-centroid and high-centroid bounds. */
  widthRange: [number, number];
  baselineWidth: number;

  // --- Motion (spec 2.2.3) ---
  /** Scale increase on word onset. Spec: 0.15 (15%). */
  popScale: number;
  /** INFERRED. Duration of the pop, seconds. Not fixed by the spec. */
  popDurationSec: number;

  // --- Layout (spec 2.2.1, 2.4.1, 2.4.3) ---
  /** Read-ahead text opacity. Spec: 0.9. */
  readAheadOpacity: number;
  /** Containing box opacity over black. Spec: 0.9. */
  boxOpacity: number;
  /** Work area as a fraction of frame height, anchored bottom. Spec: 0.2. */
  workAreaPct: number;
  /** Safe margins as % of frame, per spec 2.4.3 diagram. */
  safeArea: { top: number; bottom: number; left: number; right: number };
  /** Spec 2.4.2: no more than two caption lines per frame. */
  maxLines: number;
  /**
   * INFERRED. Base word gap as a fraction of the smaller neighbouring word's
   * type size. See `wordGap()` — the spec does not specify word spacing at all.
   */
  wordSpaceEm: number;
  /** INFERRED. Extra gap added as type approaches `wght` 1000, same units. */
  wordSpaceWeightGain: number;

  // --- Editorial exceptions (spec 3.1) ---
  /** Disable colour attribution, keep animation. For B&W or period titles. */
  monochrome: boolean;
  /** Oblique angle (Roboto Flex `slnt`) for off-camera speech. */
  offCameraSlant: number;
}
