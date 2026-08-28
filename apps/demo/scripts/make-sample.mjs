/**
 * Generates a sample .cwi manifest with plausible per-word acoustics.
 * Original dialogue — this is a synthetic scene, not a transcription.
 */
import { assignColors } from '@corerus/chorus-core';
import { writeFileSync } from 'node:fs';

const cast = [
  { id: 'vale',   name: 'Detective Vale', tier: 'main',       role: 'hero',    rank: 0 },
  { id: 'kroft',  name: 'Kroft',          tier: 'main',       role: 'villain', rank: 1 },
  { id: 'ana',    name: 'Ana',            tier: 'main',       rank: 2 },
  { id: 'dispatch', name: 'Dispatch',     tier: 'supporting', rank: 0 },
  { id: 'bystander', name: 'Bystander',   tier: 'minor',      rank: 0 },
];

/** Rough voice profiles: median f0 (Hz) and spectral centroid (Hz). */
const VOICE = {
  vale:      { f0: 118, centroid: 1250 },
  kroft:     { f0: 92,  centroid: 780  },
  ana:       { f0: 215, centroid: 2300 },
  dispatch:  { f0: 178, centroid: 1900 },
  bystander: { f0: 240, centroid: 2800 },
};

let clock = 0.6;

/**
 * `spec` is a string where a word may carry a brace-delimited marker suffix, so
 * ordinary punctuation survives:
 *   hands{!!}  shout (+9 dB)    stop{!}   raised (+4)
 *   quiet{~}   hushed (-9)      shh{~~}   whisper (-15)
 *   up{^}      pitch +25%       low{_}    pitch -20%
 * Markers combine: `now{!!^}`.
 */
function cue(speaker, spec, { kind = 'dialogue', onCamera = true, gap = 0.45, rate = 0.30, breakout = false } = {}) {
  const start = clock + gap;
  let t = start;
  const tokens = spec.split(/\s+/).map((raw) => {
    let db = 0, f0m = 1;
    const text = raw.replace(/\{([^}]*)\}/g, (_, marks) => {
      if (marks.includes('!!')) db = 9;
      else if (marks.includes('~~')) db = -15;
      else if (marks.includes('!')) db = 4;
      else if (marks.includes('~')) db = -9;
      if (marks.includes('^')) f0m = 1.25;
      else if (marks.includes('_')) f0m = 0.8;
      return '';
    });

    const v = VOICE[speaker] ?? { f0: 170, centroid: 1600 };
    // Longer words take longer; louder words land slightly harder.
    const dur = Math.max(0.13, rate * (0.55 + text.length * 0.075)) * (db > 5 ? 1.25 : 1);
    const tok = {
      text,
      start: +t.toFixed(3),
      end: +(t + dur).toFixed(3),
      db,
      f0: Math.round(v.f0 * f0m * (1 + (db / 100))), // louder speech rides a little higher
      centroid: Math.round(v.centroid * (db > 5 ? 1.15 : db < -8 ? 0.85 : 1)),
    };
    t += dur + 0.045;
    return tok;
  });
  const end = t + 0.55;
  clock = end;
  return {
    id: `c${String(Math.round(start * 100)).padStart(5, '0')}`,
    start: +start.toFixed(3), end: +end.toFixed(3),
    speaker: kind === 'dialogue' ? speaker : undefined,
    kind, onCamera, breakout,
    lines: [{ tokens }],
  };
}

function nonDialogue(kind, text, dur = 1.8, gap = 0.2) {
  const start = clock + gap;
  const words = text.split(/\s+/);
  const step = dur / words.length;
  const tokens = words.map((w, i) => ({
    text: w,
    start: +(start + i * step).toFixed(3),
    end: +(start + (i + 1) * step).toFixed(3),
    db: kind === 'sfx' ? 6 : -3,
  }));
  clock = start + dur + 0.3;
  return { id: `n${String(Math.round(start * 100))}`, start: +start.toFixed(3), end: +(start + dur + 0.3).toFixed(3), kind, onCamera: true, lines: [{ tokens }] };
}

const cues = [
  nonDialogue('music', '\u266a low strings, unresolved \u266a', 2.4, 0),
  cue('vale',  'You said the freight yard was empty.'),
  cue('ana',   'It was empty{^} an hour ago.'),
  cue('kroft', 'Nothing{_} out here is ever empty,{_} Detective.', { onCamera: false }),
  nonDialogue('sfx', '[metal door sliding]', 1.4),
  cue('vale',  'Show me your hands!{!!} Now!{!!}', { breakout: true, gap: 0.15 }),
  cue('kroft', 'You{~} really{~} should have stayed{~} in the car.', { gap: 0.5 }),
  cue('ana',   'Vale \u2014 behind{!!} you!{!!}', { gap: 0.2, breakout: true }),
  cue('dispatch', 'All units, shots reported at the east gate.', { onCamera: false }),
  cue('bystander', 'I didn\u2019t{~~} see anything.{~~}', { gap: 0.6 }),
  cue('vale',  'Then start remembering.'),
];

const { characters, warnings } = assignColors(cast, { cvdSafe: true });
warnings.forEach((w) => console.warn('assign:', w));

const manifest = {
  cwi: '1.0',
  meta: {
    title: 'Freight Yard (synthetic demo scene)',
    aspectRatio: '16:9',
    frameRate: 24,
    language: 'en-US',
    generator: 'cwi make-sample 0.1.0 — synthetic acoustics, original dialogue',
  },
  characters,
  cues,
};

writeFileSync(new URL('../public/sample.cwi.json', import.meta.url), JSON.stringify(manifest, null, 2));
console.log(`wrote ${cues.length} cues, ${cues.reduce((n,c)=>n+c.lines[0].tokens.length,0)} tokens, ${clock.toFixed(1)}s`);
