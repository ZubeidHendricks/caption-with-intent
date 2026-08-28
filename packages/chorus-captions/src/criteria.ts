/**
 * Accessibility criteria a caption track is judged against.
 *
 * A NOTE ON WHAT THIS IS AND IS NOT
 * --------------------------------
 * These are automated checks against published criteria. They are not a legal
 * determination and cannot be one: accuracy against the spoken audio, whether
 * captions obscure on-screen text, and whether a viewer can actually follow the
 * result are not decidable from a manifest. Every criterion below declares how
 * it is assessed, and the ones that need a human say so rather than quietly
 * passing.
 *
 * Reporting "compliant" from a script would be worse than reporting nothing.
 */
import type { CwiManifest, Issue } from 'chorus-core';

export type Framework = 'CWI V1.0' | 'WCAG 2.2' | 'EN 301 549' | 'FCC 47 CFR 79.1';
export type Assessment = 'automated' | 'partial' | 'manual';
export type Verdict = 'pass' | 'fail' | 'warn' | 'review';

export interface Criterion {
  id: string;
  framework: Framework;
  /** e.g. "Level A", "AA", or a clause number. */
  level: string;
  title: string;
  /** The requirement, quoted or closely paraphrased. */
  requirement: string;
  assessment: Assessment;
  /** What this check can and cannot see. Printed in the report. */
  method: string;
}

export interface Finding {
  criterion: Criterion;
  verdict: Verdict;
  detail: string;
  remediation?: string;
  affected?: string[];
}

export const CRITERIA: Record<string, Criterion> = {
  'wcag-1.4.1': {
    id: 'wcag-1.4.1', framework: 'WCAG 2.2', level: 'Level A',
    title: 'Use of Color',
    requirement:
      'Color is not used as the only visual means of conveying information, indicating an ' +
      'action, prompting a response, or distinguishing a visual element.',
    assessment: 'automated',
    method:
      'Checks whether speaker identity is distinguishable without colour. Caption with ' +
      'Intention attributes speakers by hue alone (2.1), so a track using only the base ' +
      'design fails this criterion by construction.',
  },
  'wcag-1.4.3': {
    id: 'wcag-1.4.3', framework: 'WCAG 2.2', level: 'Level AA',
    title: 'Contrast (Minimum)',
    requirement: 'Text has a contrast ratio of at least 4.5:1 against its background.',
    assessment: 'automated',
    method:
      'Each speaker colour is measured against the caption box composited over a bright ' +
      'frame — the worst case, since the box is 90% black rather than opaque.',
  },
  'wcag-1.4.4': {
    id: 'wcag-1.4.4', framework: 'WCAG 2.2', level: 'Level AA',
    title: 'Resize Text',
    requirement: 'Text can be resized up to 200 percent without loss of content or function.',
    assessment: 'partial',
    method:
      'Type size is expressed as a percentage of frame height, so it scales with the picture. ' +
      'Burned-in captions cannot be resized by the viewer at all; a sidecar track can.',
  },
  'wcag-1.4.12': {
    id: 'wcag-1.4.12', framework: 'WCAG 2.2', level: 'Level AA',
    title: 'Text Spacing',
    requirement: 'No loss of content or functionality when text spacing is adjusted.',
    assessment: 'manual',
    method: 'Not decidable from a manifest. Burned-in captions cannot be adjusted by the viewer.',
  },
  'en-7.1.1': {
    id: 'en-7.1.1', framework: 'EN 301 549', level: '7.1.1',
    title: 'Captioning playback',
    requirement: 'Where ICT displays captions, a mechanism shall be provided to display them.',
    assessment: 'partial',
    method:
      'A delivery package is checked for a conventional sidecar caption track. Burned-in ' +
      'open captions cannot be turned off, which satisfies display but removes viewer control.',
  },
  'en-7.1.2': {
    id: 'en-7.1.2', framework: 'EN 301 549', level: '7.1.2',
    title: 'Caption synchronisation',
    requirement: 'Captions shall be synchronised with the corresponding audio.',
    assessment: 'partial',
    method:
      'Checks that word-level onsets are present and ordered, and that cues do not overrun ' +
      'each other. Actual alignment to the audio cannot be verified from a manifest alone.',
  },
  'en-7.1.4': {
    id: 'en-7.1.4', framework: 'EN 301 549', level: '7.1.4',
    title: 'Caption characteristics',
    requirement:
      'Captions shall be displayed with sufficient size, colour, contrast and font to be legible.',
    assessment: 'automated',
    method: 'Type size bounds, contrast, and caption rate are checked against the spec and practice.',
  },
  'fcc-accuracy': {
    id: 'fcc-accuracy', framework: 'FCC 47 CFR 79.1', level: 'Quality — accuracy',
    title: 'Accuracy',
    requirement:
      'Captions shall match the spoken words in their original language and convey background ' +
      'noises and other sounds to the greatest extent possible.',
    assessment: 'manual',
    method:
      'Not decidable from a manifest — it requires the audio and a human. The presence of ' +
      'non-speech (sfx, music) cues is reported as a weak indicator only.',
  },
  'fcc-synchronicity': {
    id: 'fcc-synchronicity', framework: 'FCC 47 CFR 79.1', level: 'Quality — synchronicity',
    title: 'Synchronicity',
    requirement: 'Captions shall coincide with the corresponding spoken words and sounds.',
    assessment: 'partial',
    method: 'Word onsets, ordering, and cue overlap are checked. True alignment needs the audio.',
  },
  'fcc-completeness': {
    id: 'fcc-completeness', framework: 'FCC 47 CFR 79.1', level: 'Quality — completeness',
    title: 'Program completeness',
    requirement: 'Captions shall run from the beginning to the end of the program.',
    assessment: 'partial',
    method:
      'Coverage is measured as captioned time against programme duration where a duration is ' +
      'supplied. Long uncaptioned stretches are reported; whether they contain speech is not ' +
      'decidable here.',
  },
  'fcc-placement': {
    id: 'fcc-placement', framework: 'FCC 47 CFR 79.1', level: 'Quality — placement',
    title: 'Placement',
    requirement:
      'Captions shall not block other important on-screen information, and shall not run off ' +
      'the edge of the video screen.',
    assessment: 'partial',
    method:
      'The work area and line limit are checked (spec 2.4.2, 2.4.3). Whether captions obscure ' +
      'burned-in titles or other important picture requires a human review of the render.',
  },
  'cwi-attribution': {
    id: 'cwi-attribution', framework: 'CWI V1.0', level: '2.1',
    title: 'Speaker attribution',
    requirement: 'Every line of dialogue is attributable to a specific character.',
    assessment: 'automated',
    method: 'Every dialogue cue must name a character that exists in the cast.',
  },
  'cwi-lines': {
    id: 'cwi-lines', framework: 'CWI V1.0', level: '2.4.2',
    title: 'Two-line maximum',
    requirement: 'No more than two caption lines on a frame.',
    assessment: 'automated',
    method:
      'Lines are counted per cue. More than two overruns the work area defined in 2.4.3 and ' +
      'pushes captions over picture the spec reserves for the image.',
  },
  'cwi-colour-distinct': {
    id: 'cwi-colour-distinct', framework: 'CWI V1.0', level: '2.1.1, 2.1.3',
    title: 'Characters are visually distinct',
    requirement:
      'Character colours are distinct enough that a viewer can tell speakers apart, including ' +
      'under colour-vision deficiency.',
    assessment: 'automated',
    method:
      'Pairwise perceptual distance under normal vision and all three dichromacies. The spec ' +
      'itself sets no colour-vision requirement; this check goes beyond it deliberately.',
  },
};

/** Map validator issue codes onto the criteria they bear on. */
export const ISSUE_TO_CRITERION: Record<string, string> = {
  'no-speaker': 'cwi-attribution',
  'unknown-speaker': 'cwi-attribution',
  'too-many-lines': 'cwi-lines',
  'low-contrast': 'wcag-1.4.3',
  'collision-normal-vision': 'cwi-colour-distinct',
  'collision-protanopia': 'cwi-colour-distinct',
  'collision-deuteranopia': 'cwi-colour-distinct',
  'collision-tritanopia': 'cwi-colour-distinct',
  'reading-rate': 'en-7.1.4',
  'bad-timing': 'fcc-synchronicity',
  'token-order': 'fcc-synchronicity',
  'token-bounds': 'fcc-synchronicity',
  'overlap': 'fcc-synchronicity',
};

export function issuesFor(criterionId: string, issues: Issue[]): Issue[] {
  return issues.filter((i) => ISSUE_TO_CRITERION[i.code] === criterionId);
}

/**
 * Does anything other than colour distinguish one speaker from another?
 *
 * Conventional captioning uses speaker labels and ">>" change markers, both
 * non-colour. CWI replaces them with hue, which is why the base design fails
 * WCAG 1.4.1 — and why a track that keeps a non-colour cue does not.
 */
export function nonColourAttributionCues(m: CwiManifest): string[] {
  const cues: string[] = [];
  const speakers = new Set(m.cues.filter((c) => c.kind === 'dialogue').map((c) => c.speaker));
  if (speakers.size <= 1) cues.push('single speaker — attribution is not ambiguous');

  // A name or ">>" carried in the caption text itself is a non-colour cue.
  const labelled = m.cues.filter((c) =>
    c.kind === 'dialogue' &&
    c.lines.some((l) => /^(>>|\[?[A-Z][A-Z .'-]{0,24}\]?:)/.test(l.tokens.map((t) => t.text).join(' '))));
  if (labelled.length && labelled.length >= m.cues.filter((c) => c.kind === 'dialogue').length * 0.9) {
    cues.push('speaker labels in the caption text');
  }
  return cues;
}
