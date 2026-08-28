/**
 * Accessibility audit — a report a compliance team can file.
 *
 * `validate` answers "is this manifest well-formed". This answers a different
 * question: "against the criteria we are actually held to, what is wrong with
 * this caption track, and what do we do about it".
 *
 * It is deliberately not a compliance certificate. Accuracy against the audio,
 * whether captions obscure important picture, and whether a viewer can follow
 * the result are not decidable from a manifest. Criteria needing a human say
 * so and are reported as `review` rather than quietly passing — a green report
 * that hid an unanswerable question would be worse than no report.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  validate, speakerStats, simulateCvd, deltaE, contrastRatio, withDefaults,
  resolveToken, DELTA_E_FLOOR, getProfile, colourOnlyPairs, hasNonColourAttribution,
  type CwiManifest, type CwiOptions, type Issue, type CvdType,
} from 'chorus-core';
import { readManifest } from './ops.js';
import { CRITERIA, issuesFor, nonColourAttributionCues, type Finding, type Verdict } from './criteria.js';

export interface AuditOptions {
  manifest: string;
  /** Programme duration in seconds, for the completeness check. */
  duration?: number;
  /** Injected for reproducible output in tests. */
  now?: string;
}

export interface AuditReport {
  title: string;
  manifest: { path: string; sha256: string; bytes: number };
  generated: string;
  toolVersion: string;
  specVersion: string;
  summary: Record<Verdict, number>;
  findings: Finding[];
  cast: Array<{ id: string; name: string; color?: string; words: number; seconds: number }>;
  counts: { characters: number; cues: number; tokens: number; captionedSeconds: number };
  /** Stated plainly at the top of every rendering of this report. */
  disclaimer: string;
}

const TOOL_VERSION = '0.1.0';
const SPEC_VERSION = 'Caption with Intention, Design System and Caption Guidelines V1.0 (2025.1)';
const DISCLAIMER =
  'Automated checks against published criteria. This is not a legal determination of ' +
  'compliance. Criteria that require the audio or a human reviewer are reported as "review" ' +
  'and must be assessed separately.';

export function audit(opts: AuditOptions): AuditReport {
  const path = resolve(opts.manifest);
  const raw = readFileSync(path);
  const m = readManifest(path);
  const o: CwiOptions = withDefaults(m.options);
  const issues = validate(m);
  const findings: Finding[] = [];

  const add = (id: string, verdict: Verdict, detail: string, remediation?: string, affected?: string[]) =>
    findings.push({ criterion: CRITERIA[id], verdict, detail, remediation, affected });

  // --- WCAG 1.4.1: the headline finding -----------------------------------
  const speakerIds = new Set(m.cues.filter((c) => c.kind === 'dialogue' && c.speaker).map((c) => c.speaker!));
  const speakers = m.characters.filter((c) => speakerIds.has(c.id));
  const profile = getProfile(m.profile);
  const nonColour = nonColourAttributionCues(m);
  // Assessed per PAIR: declaring a second channel is not enough if two speakers
  // share a slot on it, because telling those two apart still needs colour.
  const shared = colourOnlyPairs(
    speakers.map((c) => ({ id: c.id, position: c.position, glyph: c.glyph })), profile);

  if (speakerIds.size <= 1) {
    add('wcag-1.4.1', 'pass',
      'Only one speaker, so no information is conveyed by colour difference.');
  } else if (nonColour.some((c) => c.includes('label'))) {
    add('wcag-1.4.1', 'pass',
      `Speaker identity is also carried without colour (${nonColour.join('; ')}).`);
  } else if (hasNonColourAttribution(profile) && shared.length === 0) {
    add('wcag-1.4.1', 'pass',
      `Profile "${profile.id}" carries speaker identity by ` +
      `${[...new Set(speakers.map((c) => c.glyph ? 'position and mark' : 'position'))].join(', ')} ` +
      `as well as colour, and every one of the ${speakerIds.size} speakers is distinguishable on that ` +
      'channel alone.');
  } else if (hasNonColourAttribution(profile)) {
    add('wcag-1.4.1', 'fail',
      `Profile "${profile.id}" carries a non-colour channel, but ${shared.length} speaker pair(s) ` +
      `share a slot on it, so only colour tells them apart: ` +
      shared.map(([a, b]) => `${a}/${b}`).join(', ') + '. This criterion is assessed per pair, so ' +
      'a shared slot fails it even though the track as a whole has a second channel.',
      'Give the affected characters distinct positions, add a further non-colour channel such as ' +
      'a per-character glyph, or reduce how many speakers are tracked simultaneously.',
      shared.flat());
  } else {
    add('wcag-1.4.1', 'fail',
      `${speakerIds.size} speakers are distinguished by colour alone. Caption with Intention ` +
      'attributes speakers by hue (2.1) and defines no non-colour cue for identity, so a track ' +
      'using the base design does not satisfy this Level A criterion. Conventional captioning ' +
      'conventions — a speaker label, or ">>" on a speaker change — do satisfy it, so this is a ' +
      'regression against ordinary practice on this specific point, not merely a gap.',
      'Carry speaker identity by a second, non-colour channel. Options, roughly in order of ' +
      'how little they disturb the design: place each speaker\'s captions consistently ' +
      'left/centre/right; prefix a label on speaker change; give each character a small ' +
      'persistent glyph. Off-camera italics (2.1.5) is a non-colour cue but marks *where* a ' +
      'voice is, not *whose* it is, so it does not resolve this.',
      [...speakerIds].map(String));
  }

  // --- Contrast -----------------------------------------------------------
  const lowContrast = m.characters
    .filter((c) => c.color)
    .map((c) => ({ c, ratio: contrastRatio(c.color!, '#1A1A1A') }))
    .filter((x) => x.ratio < 4.5);
  add('wcag-1.4.3', lowContrast.length ? 'fail' : 'pass',
    lowContrast.length
      ? `${lowContrast.length} character colour(s) below 4.5:1 against the caption box: ` +
        lowContrast.map((x) => `${x.c.name ?? x.c.id} ${x.c.color} at ${x.ratio.toFixed(2)}:1`).join(', ')
      : `All ${m.characters.filter((c) => c.color).length} character colours meet 4.5:1.`,
    lowContrast.length
      ? 'Raise the caption box opacity, or assign the affected characters a lighter swatch. ' +
        'CI Main Red (#E51717) reaches only 3.70:1 and cannot pass at any box opacity below opaque.'
      : undefined,
    lowContrast.map((x) => x.c.id));

  // --- Colour-vision distinctness ----------------------------------------
  const coloured = m.characters.filter((c) => c.color);
  const collisions: string[] = [];
  for (const mode of [null, 'protanopia', 'deuteranopia', 'tritanopia'] as const) {
    for (let i = 0; i < coloured.length; i++) {
      for (let j = i + 1; j < coloured.length; j++) {
        const sim = (h: string) => (mode ? simulateCvd(h, mode as CvdType) : h);
        const d = deltaE(sim(coloured[i].color!), sim(coloured[j].color!));
        if (d < DELTA_E_FLOOR) {
          collisions.push(`${coloured[i].name ?? coloured[i].id}/${coloured[j].name ?? coloured[j].id} ` +
            `ΔE ${d.toFixed(1)} under ${mode ?? 'normal vision'}`);
        }
      }
    }
  }
  add('cwi-colour-distinct', collisions.length ? 'fail' : 'pass',
    collisions.length
      ? `${collisions.length} character pair(s) are not reliably distinguishable: ${collisions.join('; ')}`
      : 'All character pairs remain distinguishable under normal vision and all three dichromacies.',
    collisions.length
      ? 'Re-run colour assignment with the colour-vision constraint enabled. If it reports that ' +
        'no assignment clears the floor, the cast is larger than the CWI palette can separate — ' +
        'demote a character to a supporting tier, or add a non-colour cue.'
      : undefined,
    collisions);

  // --- CWI structural -----------------------------------------------------
  for (const [id, label] of [['cwi-attribution', 'attribution'], ['cwi-lines', 'line limit']] as const) {
    const hits = issuesFor(id, issues);
    add(id, hits.length ? 'fail' : 'pass',
      hits.length ? `${hits.length} ${label} problem(s): ${hits.map((h) => h.message).join(' ')}`
                  : `No ${label} problems.`,
      hits.length ? 'Run `cwi validate` for the affected cues.' : undefined,
      hits.map((h) => h.ref ?? '').filter(Boolean));
  }

  // --- Legibility ---------------------------------------------------------
  const allTokens = m.cues.flatMap((c) => c.lines.flatMap((l) => l.tokens));
  const sizes = allTokens.map((t) => resolveToken(t, o).size);
  const rate = issuesFor('en-7.1.4', issues);
  const outOfRange = sizes.filter((s) => s < o.minSizePct - 0.01 || s > o.maxSizePct + 0.01);
  add('en-7.1.4',
    outOfRange.length ? 'fail' : rate.length ? 'warn' : 'pass',
    outOfRange.length
      ? `${outOfRange.length} token(s) resolve outside the ${o.minSizePct}–${o.maxSizePct}% size range.`
      : rate.length
        ? `${rate.length} cue(s) exceed a comfortable reading rate: ${rate.map((r) => r.message).join(' ')}`
        : `All ${allTokens.length} tokens sit within the size range, and no cue exceeds the reading-rate ceiling.`,
    rate.length ? 'Split the affected cues, or extend their duration.' : undefined);

  // --- Synchronicity ------------------------------------------------------
  const sync = ['fcc-synchronicity', 'bad-timing', 'token-order', 'token-bounds']
    .flatMap((c) => issuesFor('fcc-synchronicity', issues))
    .filter((v, i, a) => a.indexOf(v) === i);
  const withOnsets = allTokens.filter((t) => Number.isFinite(t.start)).length;
  add('fcc-synchronicity', sync.length ? 'fail' : 'review',
    sync.length
      ? `${sync.length} timing problem(s): ${sync.map((s) => s.message).join(' ')}`
      : `All ${withOnsets} tokens carry word-level onsets and are correctly ordered. ` +
        'Whether they align with the audio cannot be determined from the manifest.',
    'Confirm alignment by reviewing a render against the audio.');
  add('en-7.1.2', sync.length ? 'fail' : 'review',
    sync.length ? 'See the synchronicity finding above.'
                : 'Word-level onsets are present and ordered; alignment to audio needs review.');

  // --- Completeness -------------------------------------------------------
  const captioned = m.cues.reduce((n, c) => n + (c.end - c.start), 0);
  const programme = opts.duration;
  if (programme && programme > 0) {
    const coverage = captioned / programme;
    const gaps = findGaps(m, programme).filter((g) => g[1] - g[0] > 15);
    add('fcc-completeness', gaps.length ? 'warn' : 'pass',
      `Captions cover ${(coverage * 100).toFixed(1)}% of a ${programme.toFixed(0)}s programme` +
      (gaps.length ? `, with ${gaps.length} uncaptioned stretch(es) over 15s: ` +
        gaps.slice(0, 5).map(([a, b]) => `${a.toFixed(0)}–${b.toFixed(0)}s`).join(', ') : '.'),
      gaps.length ? 'Confirm each gap is genuinely silent rather than uncaptioned speech.' : undefined);
  } else {
    add('fcc-completeness', 'review',
      `${captioned.toFixed(1)}s captioned. No programme duration supplied, so coverage cannot be computed.`,
      'Pass --duration with the programme length.');
  }

  // --- Placement ----------------------------------------------------------
  add('fcc-placement', issuesFor('cwi-lines', issues).length ? 'fail' : 'review',
    `Captions are laid out in the lower ${(o.workAreaPct * 100).toFixed(0)}% of frame with ` +
    `safe margins, at most ${o.maxLines} lines. Whether they obscure important picture — ` +
    'burned-in titles, lower thirds, on-screen text — requires reviewing the render.',
    'Review a render of the full programme for collisions with picture.');

  // --- Criteria that cannot be automated ----------------------------------
  const nonSpeech = m.cues.filter((c) => c.kind !== 'dialogue').length;
  add('fcc-accuracy', 'review',
    `${nonSpeech} non-speech cue(s) (sound effects, music) are present. Accuracy against the ` +
    'spoken audio cannot be assessed from a manifest.',
    'Have a human check the transcript against the audio.');
  add('wcag-1.4.4', 'review',
    'Type size is a percentage of frame height, so captions scale with the picture. Burned-in ' +
    'captions cannot be resized by the viewer; a sidecar track can.',
    'Ship the conventional sidecar track alongside any burned-in delivery.');
  add('wcag-1.4.12', 'review', CRITERIA['wcag-1.4.12'].method);
  add('en-7.1.1', 'review',
    'Whether the viewer can turn captions on and off depends on delivery, not on the manifest. ' +
    'Burned-in open captions cannot be disabled.',
    'Ship a sidecar caption track so viewers retain control.');

  const stats = speakerStats(m.cues);
  const summary: Record<Verdict, number> = { pass: 0, fail: 0, warn: 0, review: 0 };
  for (const f of findings) summary[f.verdict]++;

  return {
    title: m.meta?.title ?? basename(path),
    manifest: { path, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length },
    generated: opts.now ?? new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    specVersion: SPEC_VERSION,
    summary,
    findings,
    cast: m.characters.map((c) => ({
      id: c.id, name: c.name ?? c.id, color: c.color,
      words: stats.get(c.id)?.words ?? 0,
      seconds: +(stats.get(c.id)?.seconds ?? 0).toFixed(2),
    })),
    counts: {
      characters: m.characters.length,
      cues: m.cues.length,
      tokens: allTokens.length,
      captionedSeconds: +captioned.toFixed(2),
    },
    disclaimer: DISCLAIMER,
  };
}

function findGaps(m: CwiManifest, duration: number): Array<[number, number]> {
  const spans = m.cues.map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of spans) {
    if (a > cursor) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < duration) gaps.push([cursor, duration]);
  return gaps;
}

void (undefined as unknown as Issue);
