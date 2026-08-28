/**
 * Derive a colour-vision-safe speaker palette.
 *
 * The CWI V1.0 palette distinguishes speakers by hue alone and was not selected
 * against dichromatic vision: Red/Orange, Yellow/Green and Green/Orange all
 * collapse under deuteranopia, and CI Main Red fails WCAG AA contrast against
 * the caption box. This searches for a palette that does not.
 *
 * Objective: maximise the SMALLEST pairwise perceptual distance, evaluated
 * across normal vision and all three dichromacies simultaneously. Optimising
 * the average would let one indistinguishable pair hide behind nine good ones —
 * and the pair that collapses is exactly the failure a viewer experiences.
 *
 * Constraint: every colour must clear 4.5:1 against the caption box composited
 * over a bright frame (WCAG 1.4.3, Level AA).
 */
import { simulateCvd, deltaE, contrastRatio, hexToLab } from '@chorus/core';

const BOX = '#1A1A1A';
const MODES = [null, 'protanopia', 'deuteranopia', 'tritanopia'];

/** Worst-case separation between two colours across every vision mode. */
function separation(a, b) {
  let worst = Infinity;
  for (const m of MODES) {
    const x = m ? simulateCvd(a, m) : a;
    const y = m ? simulateCvd(b, m) : b;
    worst = Math.min(worst, deltaE(x, y));
  }
  return worst;
}

function minPairwise(set) {
  let worst = Infinity;
  for (let i = 0; i < set.length; i++)
    for (let j = i + 1; j < set.length; j++)
      worst = Math.min(worst, separation(set[i], set[j]));
  return worst;
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Candidate pool: colours bright enough to read on the caption box, sampled
// across hue, saturation and lightness. Captions are light-on-dark, so the
// useful region is the upper half of the lightness range.
const candidates = [];
for (let h = 0; h < 360; h += 4)
  for (let s = 0.35; s <= 1.001; s += 0.15)
    for (let l = 0.5; l <= 0.88; l += 0.06) {
      const c = hslToHex(h, s, l);
      if (contrastRatio(c, BOX) >= 4.5) candidates.push(c);
    }

console.log(`candidate pool: ${candidates.length} colours clearing 4.5:1 on the caption box\n`);

/** Greedy max-min seed, then local search swapping one colour at a time. */
function derive(n, seedHue) {
  let best = [candidates.reduce((a, c) =>
    Math.abs(((parseInt(c.slice(1, 3), 16)) - seedHue)) < 1 ? c : a, candidates[0])];

  while (best.length < n) {
    let pick = null, pickScore = -1;
    for (const c of candidates) {
      if (best.includes(c)) continue;
      const score = Math.min(...best.map((b) => separation(c, b)));
      if (score > pickScore) { pickScore = score; pick = c; }
    }
    best.push(pick);
  }

  let improved = true;
  let score = minPairwise(best);
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length; i++) {
      for (const c of candidates) {
        if (best.includes(c)) continue;
        const trial = [...best];
        trial[i] = c;
        const s = minPairwise(trial);
        if (s > score + 1e-9) { best = trial; score = s; improved = true; }
      }
    }
  }
  return { palette: best, score };
}

for (const n of [4, 6]) {
  const { palette, score } = derive(n, 0);
  // Order by lightness so the set reads as a deliberate ramp, not a scatter.
  palette.sort((a, b) => hexToLab(a)[0] - hexToLab(b)[0]);
  console.log(`--- ${n} main colours — worst-case ΔE ${score.toFixed(1)} ---`);
  for (const c of palette) {
    const worst = MODES.map((m) => {
      const others = palette.filter((x) => x !== c);
      return Math.min(...others.map((o) => {
        const a = m ? simulateCvd(c, m) : c, b = m ? simulateCvd(o, m) : o;
        return deltaE(a, b);
      }));
    });
    console.log(`  ${c}  contrast ${contrastRatio(c, BOX).toFixed(2).padStart(5)}:1   ` +
      `min ΔE  normal ${worst[0].toFixed(0).padStart(3)}  prot ${worst[1].toFixed(0).padStart(3)}` +
      `  deut ${worst[2].toFixed(0).padStart(3)}  trit ${worst[3].toFixed(0).padStart(3)}`);
  }
  console.log();
}
