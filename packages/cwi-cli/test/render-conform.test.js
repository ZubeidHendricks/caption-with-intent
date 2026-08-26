/**
 * The render conformance checker, checked.
 *
 * A conformance suite that cannot fail anything is worse than none: it hands
 * out certification while the picture is broken. So each test here starts from
 * a report that a perfect renderer would produce, breaks exactly one thing,
 * and asserts that the specific check meant to catch it does — and, just as
 * importantly, that the others stay quiet.
 *
 * The model report is computed from the scene by the same core the checker
 * uses, which would be circular if it were testing the mapping. It is not:
 * what is under test is whether a *wrong picture* is detected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToken, withDefaults } from 'cwi-core';
import { checkReport, loadScene, loadScenes, cueAt, toHex } from 'cwi-cli/render-conform';

const scene = loadScene('dialogue-2speaker');
const opts = withDefaults(scene.manifest.options ?? {});
const chars = new Map(scene.manifest.characters.map((c) => [c.id, c]));

/** What a renderer that gets everything right would report. */
function modelReport(s = scene) {
  const o = withDefaults(s.manifest.options ?? {});
  return {
    cwiRenderReport: '1.0',
    implementation: 'model',
    scene: s.id,
    frame: s.frame,
    samples: s.samples.map((t) => {
      const cue = cueAt(s.manifest, t);
      const tokens = cue ? cue.lines.flatMap((l) => l.tokens) : [];
      const ch = cue?.speaker ? new Map(s.manifest.characters.map((c) => [c.id, c])).get(cue.speaker) : null;
      let x = s.frame.w * 0.1;
      return {
        t,
        tokens: tokens.map((k) => {
          const style = resolveToken(k, o);
          const sizePx = (style.size / 100) * s.frame.h;
          const spoken = t >= k.start;
          const tok = {
            text: k.text,
            spoken,
            sizePx,
            // Read-ahead text is neutral until the playhead reaches it.
            colour: spoken ? (ch?.color ?? '#ffffff') : 'rgba(255, 255, 255, 0.9)',
            wght: style.wght,
            wdth: style.wdth,
            leftPx: Math.round(x),
            topPx: Math.round(s.frame.h * 0.85),
          };
          // Layout is a function of the cue, not of the playhead: the same
          // token sits in the same place at every sample within its cue.
          x += k.text.length * sizePx * 0.55 + sizePx * 0.3;
          return tok;
        }),
        marks: ch?.glyph ? [ch.glyph] : [],
        lineCount: cue ? cue.lines.length : 0,
        box: cue
          ? { left: s.frame.w * 0.1, top: s.frame.h * 0.8, width: s.frame.w * 0.8, height: s.frame.h * 0.08 }
          : undefined,
      };
    }),
  };
}

const failed = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);

test('a correct report is certified at the highest level', () => {
  const r = checkReport(scene, modelReport());
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((c) => !c.ok), null, 2));
  assert.equal(r.level, 'AAA');
  assert.equal(r.ok, true);
});

test('every shipped scene is satisfiable — the bar is reachable', () => {
  // A scene whose own model report cannot pass would fail every implementation
  // for a reason that is the suite's fault, not theirs.
  for (const s of loadScenes()) {
    const r = checkReport(s, modelReport(s));
    assert.deepEqual(failed(r), [], `${s.id}: ${failed(r).join(', ')}`);
  }
});

test('drawing the wrong words fails R-A1', () => {
  const rep = modelReport();
  rep.samples[0].tokens[1].text = 'GATEWAY';
  assert.ok(failed(rep0(rep)).includes('R-A1'));
});

test('a line that turns over as a block fails the synchronisation checks', () => {
  const rep = modelReport();
  // The classic wrong implementation: reveal the whole cue at its start.
  for (const s of rep.samples) for (const k of s.tokens) k.spoken = true;
  const f = failed(rep0(rep));
  assert.ok(f.includes('R-A2'), 'per-word onsets are not honoured');
  assert.ok(f.includes('R-A3'), 'no sample is ever partially revealed');
});

test('a renderer that reports the reveal but never draws it fails R-A6', () => {
  const rep = modelReport();
  // Flags perfect, picture static: every word drawn in the speaker colour.
  for (const s of rep.samples) {
    const cue = cueAt(scene.manifest, s.t);
    const colour = chars.get(cue?.speaker)?.color;
    if (colour) for (const k of s.tokens) k.colour = colour;
  }
  const f = failed(rep0(rep));
  assert.deepEqual(f, ['R-A6'], `expected only R-A6, got ${f.join(', ')}`);
});

test('drawing a speaker in another speaker’s colour fails R-A4', () => {
  const rep = modelReport();
  const wrong = scene.manifest.characters[1].color;
  for (const k of rep.samples[0].tokens) if (k.spoken) k.colour = wrong;
  assert.ok(failed(rep0(rep)).includes('R-A4'));
});

test('collapsing two speakers to one colour fails R-A5', () => {
  const rep = modelReport();
  // Both speakers drawn in the same colour, consistently — so each cue looks
  // internally fine and only the cross-speaker comparison catches it.
  const s = { ...scene, manifest: { ...scene.manifest,
    characters: scene.manifest.characters.map((c) => ({ ...c, color: '#17E517' })) } };
  const r = checkReport(s, modelReport(s));
  assert.ok(failed(r).includes('R-A5'), failed(r).join(', '));
  assert.equal(rep.implementation, 'model');
});

test('type size that ignores loudness fails R-B1', () => {
  const rep = modelReport();
  // A fixed size: correct for ordinary speech, wrong for the shout and the
  // whisper, which is exactly the failure a flat renderer produces.
  for (const s of rep.samples) for (const k of s.tokens) k.sizePx = 0.05 * scene.frame.h;
  const f = failed(rep0(rep));
  assert.ok(f.includes('R-B1'), f.join(', '));
  assert.ok(!f.includes('R-A2'), 'sizing has nothing to do with synchronisation');
});

test('a static face forfeits AA without failing A', () => {
  const rep = modelReport();
  for (const s of rep.samples) for (const k of s.tokens) { delete k.wght; delete k.wdth; }
  const r = checkReport(scene, rep);
  assert.equal(r.ok, true, 'a static face still attributes and synchronises correctly');
  assert.equal(r.level, 'A', 'so it earns A, and stops there');
  assert.equal(r.byLevel.AA.skipped, 2, 'the two axis checks had nothing to read');
});

test('a pop that moves the line fails R-C1', () => {
  const rep = modelReport();
  // Reflow: the token grows and pushes its neighbours along the line. Every
  // other check still passes, which is why this needs its own check.
  const popped = rep.samples.find((s) => s.tokens.length > 1 && s.t > 0);
  popped.tokens[1].leftPx += 12;
  const f = failed(rep0(rep));
  assert.deepEqual(f, ['R-C1'], f.join(', '));
});

test('running past the safe area fails R-C3', () => {
  const rep = modelReport();
  rep.samples[0].box = { left: 0, top: 900, width: scene.frame.w, height: 100 };
  assert.ok(failed(rep0(rep)).includes('R-C3'));
});

test('a third line fails R-C2', () => {
  const rep = modelReport();
  rep.samples[0].lineCount = 3;
  assert.ok(failed(rep0(rep)).includes('R-C2'));
});

test('dropping the non-colour marks fails R-C4 under a profile that uses them', () => {
  const four = loadScene('chorus-4speaker');
  const rep = modelReport(four);
  // Everything drawn centred, no marks: the picture now carries speaker
  // identity in hue alone, which is the WCAG 1.4.1 failure the profile exists
  // to fix. The manifest still asks for positions, so only the report shows it.
  for (const s of rep.samples) {
    s.marks = [];
    if (s.box) s.box.left = four.frame.w * 0.1;
  }
  const r = checkReport(four, rep);
  assert.ok(failed(r).includes('R-C4'), failed(r).join(', '));
  assert.equal(r.ok, true, 'this is a AAA failure, not an A one');
  assert.equal(r.level, 'AA');
});

test('a report at the wrong frame size is rejected outright', () => {
  const rep = modelReport();
  rep.frame = { w: 1280, h: 720 };
  assert.throws(() => checkReport(scene, rep), /1280x720/);
});

test('a report missing samples is rejected outright', () => {
  const rep = modelReport();
  rep.samples.pop();
  assert.throws(() => checkReport(scene, rep), /missing 1 of/);
});

test('colours are read in the forms renderers actually emit', () => {
  assert.equal(toHex('#AABBCC'), '#aabbcc');
  assert.equal(toHex('#abc'), '#aabbcc');
  assert.equal(toHex('rgb(17, 229, 23)'), '#11e517');
  assert.equal(toHex('rgba(17, 229, 23, 0.9)'), '#11e517');
  assert.throws(() => toHex('rebeccapurple'), /Cannot read the colour/);
});

/** Run the checker over a mutated report. */
function rep0(rep) {
  return checkReport(scene, rep);
}
