/**
 * The captioning team: one pass from a video to a checked caption track.
 *
 * Every stage here already existed as a command. What did not exist was
 * something that runs them in order, decides whether each result is good
 * enough to continue, and says why when it stops.
 *
 * The reference for this shape is Agent Opus, which runs eight sub-agents —
 * researcher, scriptwriter, storyboard artist, asset manager, hook designer,
 * motion designer, voice actor, editor — from a prompt to a publish-ready
 * short. Every one of those agents is generative, and there is no verification
 * agent anywhere in the chain; the documented workflow is two or three passes
 * of a human re-rolling until it looks right.
 *
 * That is the correct trade when the output is a marketing clip and the failure
 * mode is "boring". It is the wrong trade here. These captions are an
 * accessibility artifact, and the failure mode is a deaf viewer being told the
 * wrong person spoke — which looks exactly like success unless something
 * measures it. A confident wrong caption is indistinguishable from a right one
 * at a glance, which is the whole reason this repository keeps measuring things
 * rather than asserting them.
 *
 * So the team is arranged around verification rather than generation. Half the
 * stages produce something; the other half try to find fault with it, and can
 * stop the run. Each stage returns evidence rather than a verdict, so the log
 * says what was measured and not merely what was decided.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  assignColors, getProfile, colourOnlyPairs, deltaE, contrastRatio,
  type CwiManifest,
} from '@corerus/chorus-core';
import { CwiError, analyzeMedia, evaluateMedia, readManifest, validateManifest } from './ops.js';
import { audit } from './audit.js';
import { render } from './render.js';
import { readSubtitles, matchByTime } from './translate.js';

export type Verdict = 'ok' | 'warn' | 'stop';

export interface StageReport {
  stage: string;
  /** What this stage is answerable for, in one line. */
  role: string;
  verdict: Verdict;
  summary: string;
  /** What was measured. The reason a reader can disagree with the verdict. */
  evidence?: Record<string, unknown>;
  /** What a person should do about it. */
  advice?: string;
  seconds?: number;
}

export interface TeamOptions {
  media: string;
  subtitles?: string;
  profile?: string;
  out?: string;
  /** Also burn the captions into the video. */
  deliver?: boolean;
  /** Transcribe here rather than requiring a subtitle file. */
  asr?: boolean;
  /** Attempt acoustic speaker separation. Approximate; see pipeline/diarize.py. */
  diarize?: boolean;
  /** Treat every warning as a stop. For unattended runs. */
  strict?: boolean;
  onStage?: (r: StageReport) => void;
}

export interface TeamResult {
  media: string;
  manifest?: string;
  output?: string;
  reports: StageReport[];
  /** True when nothing stopped the run. Warnings do not clear this. */
  ok: boolean;
  /** Warnings a person still has to answer for before this ships. */
  open: string[];
}

/** Minimum perceptual distance between two speakers, across all dichromacies. */
const DELTA_E_FLOOR = 20;

export async function runTeam(opts: TeamOptions): Promise<TeamResult> {
  const reports: StageReport[] = [];
  const emit = (r: StageReport) => { reports.push(r); opts.onStage?.(r); return r; };
  const stopped = () => reports.some((r) => r.verdict === 'stop');

  if (!existsSync(opts.media)) {
    throw new CwiError(`No such media: ${opts.media}`);
  }
  const dir = dirname(opts.media);
  const manifestPath = opts.out ?? join(dir, basename(opts.media).replace(/\.[^.]+$/, '') + '.cwi.json');

  // --- 1. Probe -----------------------------------------------------------
  // Before anything is transcribed, ask whether this soundtrack can support
  // the measurements the design rests on. A scored scene answers "no", and
  // finding that out after a transcription pass wastes the expensive stage.
  let probe: Awaited<ReturnType<typeof evaluateMedia>> | undefined;
  await timed(emit, 'probe', 'is this soundtrack analysable at all', async () => {
    probe = await evaluateMedia(opts.media, emptyManifestFile(dir));
    const share = probe.dialogue_cues ? probe.suspect / probe.dialogue_cues : 0;
    return {
      verdict: share > 0.5 ? 'warn' : 'ok',
      summary: probe.verdict,
      evidence: {
        dialogueCues: probe.dialogue_cues,
        trustworthy: probe.trustworthy,
        typeSizeSpreadPct: probe.size_spread_pct,
      },
      advice: share > 0.5
        ? 'Most of this audio does not meet the assumptions the typography rests on. '
          + 'A dialogue stem, if the production has one, would fix it.'
        : undefined,
    };
  });

  // --- 2. Transcribe ------------------------------------------------------
  let manifest: CwiManifest | undefined;
  if (!stopped()) {
    await timed(emit, 'transcribe', 'turn the soundtrack into word-timed text', async () => {
      if (!opts.subtitles && !opts.asr) {
        return {
          verdict: 'stop',
          summary: 'no source of words',
          advice: 'Supply --subtitles, or --asr to transcribe here.',
        };
      }
      const vtt = opts.subtitles && !opts.subtitles.toLowerCase().endsWith('.vtt')
        ? srtToVtt(opts.subtitles, dir)
        : opts.subtitles;
      const r = await analyzeMedia({
        media: opts.media,
        out: manifestPath,
        ...(vtt ? { vtt } : { asr: true, diarize: opts.diarize }),
      });
      manifest = r.manifest;
      const words = manifest.cues.reduce(
        (n, c) => n + c.lines.reduce((m, l) => m + l.tokens.length, 0), 0);
      return {
        verdict: words ? 'ok' : 'stop',
        summary: `${manifest.cues.length} cues, ${words} words`,
        evidence: { cues: manifest.cues.length, words, source: vtt ? 'subtitles' : 'asr' },
      };
    });
  }

  // --- 3. Attribute -------------------------------------------------------
  // The stage most likely to be silently wrong, so it is the one that warns
  // loudest. One speaker is not an error; it is an entire design layer idle.
  if (!stopped() && manifest) {
    await timed(emit, 'attribute', 'work out who is speaking', async () => {
      const n = manifest!.characters.length;
      return {
        verdict: n < 2 ? 'warn' : 'ok',
        summary: n < 2 ? 'one speaker' : `${n} speakers`,
        evidence: { speakers: manifest!.characters.map((c) => c.name ?? c.id) },
        advice: n < 2
          ? 'Colour, position and marks all answer "who is talking", so with one '
            + 'speaker none of them convey anything. Label speakers in the subtitle '
            + 'file (VALE:) or install WhisperX, which diarizes.'
          : undefined,
      };
    });
  }

  // --- 4. Design ----------------------------------------------------------
  if (!stopped() && manifest) {
    await timed(emit, 'design', 'assign colours that survive colour blindness', async () => {
      const profile = getProfile(opts.profile ?? 'chorus-1.0');
      const assigned = assignColors(manifest!.characters, { profile });
      manifest!.profile = profile.id;
      manifest!.characters = assigned.characters;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const worst = worstSeparation(manifest!);
      const colourOnly = colourOnlyPairs(manifest!.characters, profile);
      return {
        verdict: worst !== null && worst < DELTA_E_FLOOR ? 'warn' : 'ok',
        summary: worst === null
          ? 'one speaker, nothing to separate'
          : `worst-case separation ΔE ${worst.toFixed(1)}`,
        evidence: {
          profile: profile.id,
          worstDeltaE: worst,
          floor: DELTA_E_FLOOR,
          pairsSeparableByColourAlone: colourOnly.length,
        },
        advice: worst !== null && worst < DELTA_E_FLOOR
          ? `Two speakers sit below the ΔE ${DELTA_E_FLOOR} floor under at least one `
            + 'form of colour blindness. The chorus-1.0 profile adds position and a '
            + 'mark so no pair depends on hue alone.'
          : undefined,
      };
    });
  }

  // --- 5. Audit -----------------------------------------------------------
  // The adversarial stage. It exists to find fault, and it can stop the run.
  if (!stopped() && manifest) {
    await timed(emit, 'audit', 'find where this fails WCAG, EN 301 549 and the FCC', async () => {
      const r = await audit({ manifest: manifestPath });
      return {
        verdict: r.summary.fail > 0 ? 'stop' : r.summary.warn > 0 ? 'warn' : 'ok',
        summary: `${r.summary.fail} failing, ${r.summary.warn} warning, ${r.summary.review} to review`,
        evidence: {
          failing: r.findings.filter((f) => f.verdict === 'fail').map((f) => f.criterion.id),
          warning: r.findings.filter((f) => f.verdict === 'warn').map((f) => f.criterion.id),
        },
        advice: r.summary.fail > 0
          ? 'These are standards failures, not preferences. Run `chorus audit` for the detail.'
          : undefined,
      };
    });
  }

  // --- 6. Validate --------------------------------------------------------
  if (!stopped() && manifest) {
    await timed(emit, 'validate', 'check the track is structurally sound', async () => {
      const v = validateManifest(manifest!);
      return {
        verdict: v.errors ? 'stop' : v.warnings ? 'warn' : 'ok',
        summary: v.issues.length ? `${v.errors} errors, ${v.warnings} warnings` : 'no issues',
        evidence: { codes: v.issues.slice(0, 8).map((i) => i.code) },
      };
    });
  }

  // --- 7. Deliver ---------------------------------------------------------
  let output: string | undefined;
  if (!stopped() && manifest && opts.deliver) {
    await timed(emit, 'deliver', 'burn the captions into the picture', async () => {
      const out = manifestPath.replace(/\.cwi\.json$/, '') + '.captioned.mp4';
      const r = await render({ manifest: manifestPath, video: opts.media, out });
      output = r.out ?? out;
      return { verdict: 'ok', summary: basename(output), evidence: { out: output } };
    });
  }

  const open = reports.filter((r) => r.verdict === 'warn').map((r) => `${r.stage}: ${r.summary}`);
  const hardStop = reports.some((r) => r.verdict === 'stop')
    || (opts.strict === true && open.length > 0);

  return {
    media: opts.media,
    manifest: manifest ? manifestPath : undefined,
    output,
    reports,
    ok: !hardStop,
    open,
  };
}

/** Worst-case separation between any two main speakers, across all vision types. */
function worstSeparation(m: CwiManifest): number | null {
  const colours = m.characters.map((c) => c.color).filter(Boolean) as string[];
  if (colours.length < 2) return null;
  let worst = Infinity;
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      worst = Math.min(worst, deltaE(colours[i], colours[j]));
    }
  }
  return worst;
}

async function timed(
  emit: (r: StageReport) => StageReport,
  stage: string,
  role: string,
  run: () => Promise<Omit<StageReport, 'stage' | 'role' | 'seconds'>>,
): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await run();
    emit({ stage, role, seconds: (Date.now() - t0) / 1000, ...r });
  } catch (e) {
    emit({
      stage,
      role,
      verdict: 'stop',
      summary: e instanceof CwiError ? e.message : String((e as Error)?.message ?? e),
      seconds: (Date.now() - t0) / 1000,
    });
  }
}

/** `evaluate` wants a manifest; before transcription there is not one yet. */
function emptyManifestFile(dir: string): string {
  const p = join(dir, '.chorus-probe.cwi.json');
  writeFileSync(p, JSON.stringify({ cwi: '1.0', characters: [], cues: [] }));
  return p;
}

function srtToVtt(path: string, dir: string): string {
  const entries = readSubtitles(path);
  const stamp = (t: number) => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  };
  const out = join(dir, '.chorus-team.vtt');
  writeFileSync(out, 'WEBVTT\n\n' + entries
    .map((e) => `${stamp(e.start)} --> ${stamp(e.end)}\n${e.text}`).join('\n\n') + '\n');
  return out;
}

export { matchByTime as _matchByTime, contrastRatio as _contrastRatio };
