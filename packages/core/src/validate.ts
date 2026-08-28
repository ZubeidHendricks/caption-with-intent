/**
 * Manifest validation and an accessibility audit that goes beyond what the
 * CWI V1.0 spec itself requires.
 */
import type { CwiManifest, CwiOptions, Cue } from './types.js';
import { withDefaults } from './options.js';
import { contrastRatio } from './palette.js';
import { simulateCvd, deltaE, type CvdType } from './cvd.js';

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  /** Cue id or character id the issue attaches to, when applicable. */
  ref?: string;
}

/** Perceived caption background: 90% black over arbitrary footage. Worst case
 *  for contrast is the box over a bright frame, so we evaluate against the
 *  box's own composite over mid-grey rather than pure black. */
const BOX_OVER_BRIGHT = '#1A1A1A';

/**
 * ΔE below this means two speakers' colours are hard to tell apart at a glance
 * on moving text. Chosen conservatively; not a figure from the spec.
 */
export const DELTA_E_FLOOR = 20;

export function validate(manifest: CwiManifest, opts?: Partial<CwiOptions>): Issue[] {
  const o: CwiOptions = withDefaults({ ...manifest.options, ...opts });
  const issues: Issue[] = [];
  const ids = new Set<string>();

  if (manifest.cwi !== '1.0') {
    issues.push({ severity: 'error', code: 'version', message: `Unknown manifest version "${manifest.cwi}".` });
  }

  for (const c of manifest.characters) {
    if (ids.has(c.id)) {
      issues.push({ severity: 'error', code: 'duplicate-character', message: `Duplicate character id "${c.id}".`, ref: c.id });
    }
    ids.add(c.id);
    if (!c.color) {
      issues.push({ severity: 'warning', code: 'no-color', message: `Character "${c.id}" has no colour. Run assignColors().`, ref: c.id });
    }
  }

  // --- Cue-level structural checks ---
  let prevEnd = -Infinity;
  for (const cue of manifest.cues) {
    const ref = cue.id ?? `${cue.start.toFixed(2)}s`;
    if (cue.end <= cue.start) {
      issues.push({ severity: 'error', code: 'bad-timing', message: `Cue ends at or before it starts.`, ref });
    }
    if (cue.kind === 'dialogue' && !cue.speaker) {
      issues.push({ severity: 'error', code: 'no-speaker', message: `Dialogue cue has no speaker — attribution is the point of the system.`, ref });
    }
    if (cue.speaker && !ids.has(cue.speaker)) {
      issues.push({ severity: 'error', code: 'unknown-speaker', message: `Cue references unknown character "${cue.speaker}".`, ref });
    }
    if (cue.lines.length > o.maxLines) {
      issues.push({ severity: 'error', code: 'too-many-lines', message: `${cue.lines.length} lines exceeds the spec's maximum of ${o.maxLines} per frame (2.4.2).`, ref });
    }
    if (cue.start < prevEnd) {
      issues.push({ severity: 'info', code: 'overlap', message: `Cue overlaps the previous one. Legal for simultaneous speakers, but check the box layout.`, ref });
    }
    prevEnd = Math.max(prevEnd, cue.end);

    // Token ordering and containment.
    for (const line of cue.lines) {
      let last = -Infinity;
      for (const t of line.tokens) {
        if (t.start < last - 1e-6) {
          issues.push({ severity: 'warning', code: 'token-order', message: `Token "${t.text}" starts before the previous token.`, ref });
        }
        if (t.start < cue.start - 1e-6 || t.end > cue.end + 1e-6) {
          issues.push({ severity: 'warning', code: 'token-bounds', message: `Token "${t.text}" falls outside its cue's time range.`, ref });
        }
        last = t.start;
      }
    }

    // Reading rate. The spec fixes type size and box geometry but says nothing
    // about caption rate, which existing caption standards do constrain.
    const words = cue.lines.reduce((n, l) => n + l.tokens.length, 0);
    const dur = Math.max(cue.end - cue.start, 1e-6);
    const wpm = (words / dur) * 60;
    if (cue.kind === 'dialogue' && wpm > 240) {
      issues.push({ severity: 'warning', code: 'reading-rate', message: `${wpm.toFixed(0)} wpm exceeds the ~240 wpm ceiling common to caption practice. Not constrained by CWI V1.0 — flagged as a gap.`, ref });
    }
  }

  issues.push(...auditColors(manifest));
  return issues;
}

/**
 * Colour audit: contrast against the caption box, and pairwise separation under
 * normal vision and all three dichromacies.
 */
export function auditColors(manifest: CwiManifest): Issue[] {
  const issues: Issue[] = [];
  const speaking = manifest.characters.filter((c) => c.color);

  for (const c of speaking) {
    const ratio = contrastRatio(c.color!, BOX_OVER_BRIGHT);
    if (ratio < 4.5) {
      issues.push({
        severity: 'warning', code: 'low-contrast', ref: c.id,
        message: `"${c.id}" (${c.color}) contrasts ${ratio.toFixed(1)}:1 against the caption box — below the 4.5:1 WCAG AA floor. CWI V1.0 sets no contrast requirement.`,
      });
    }
  }

  const modes: Array<{ label: string; fn: (hex: string) => string }> = [
    { label: 'normal vision', fn: (h) => h },
    ...(['protanopia', 'deuteranopia', 'tritanopia'] as CvdType[])
      .map((t) => ({ label: t, fn: (h: string) => simulateCvd(h, t) })),
  ];

  for (const mode of modes) {
    for (let i = 0; i < speaking.length; i++) {
      for (let j = i + 1; j < speaking.length; j++) {
        const a = speaking[i], b = speaking[j];
        const d = deltaE(mode.fn(a.color!), mode.fn(b.color!));
        if (d < DELTA_E_FLOOR) {
          issues.push({
            severity: mode.label === 'normal vision' ? 'error' : 'warning',
            code: `collision-${mode.label.replace(' ', '-')}`,
            ref: `${a.id}|${b.id}`,
            message: `"${a.id}" and "${b.id}" are only ΔE ${d.toFixed(1)} apart under ${mode.label} — below the ${DELTA_E_FLOOR} floor. Viewers may not be able to tell these two speakers apart.`,
          });
        }
      }
    }
  }
  return issues;
}

/** Total on-screen duration per character. Useful for tiering speakers. */
export function speakerStats(cues: Cue[]): Map<string, { seconds: number; words: number }> {
  const m = new Map<string, { seconds: number; words: number }>();
  for (const cue of cues) {
    if (!cue.speaker) continue;
    const cur = m.get(cue.speaker) ?? { seconds: 0, words: 0 };
    cur.seconds += cue.end - cue.start;
    cur.words += cue.lines.reduce((n, l) => n + l.tokens.length, 0);
    m.set(cue.speaker, cur);
  }
  return m;
}
