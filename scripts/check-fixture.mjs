import { resolveToken, DEFAULT_OPTIONS } from 'chorus-core';
import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync('pipeline/test/fixture.cwi.json','utf8'));
console.log('id'.padEnd(6),'tier'.padEnd(11),'name');
for (const c of m.characters) console.log(c.id.padEnd(6), c.tier.padEnd(11), c.name);
console.log('\nspk    onCam  word          f0    cent      dB  ->  size%  wght  wdth');
for (const cue of m.cues) for (const l of cue.lines) for (const t of l.tokens) {
  const s = resolveToken(t, DEFAULT_OPTIONS);
  console.log(cue.speaker.padEnd(6), String(cue.onCamera).padEnd(6), t.text.padEnd(12),
    String(t.f0).padStart(6), String(Math.round(t.centroid)).padStart(6), String(t.db).padStart(7),
    ' -> ', s.size.toFixed(2).padStart(6), String(s.wght).padStart(5), String(s.wdth).padStart(5));
}
