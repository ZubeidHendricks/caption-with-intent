import { assignColors, worstCaseSeparation } from '../dist/index.js';

const cast = [
  { id: 'batman',  name: 'Batman',            tier: 'main', role: 'hero',    rank: 0 },
  { id: 'joker',   name: 'The Joker',         tier: 'main', role: 'villain', rank: 1 },
  { id: 'gordon',  name: 'Comm. Gordon',      tier: 'main', rank: 2 },
  { id: 'rachel',  name: 'Rachel Dawes',      tier: 'main', rank: 3 },
  { id: 'alfred',  name: 'Alfred',            tier: 'supporting', rank: 0 },
  { id: 'fox',     name: 'Lucius Fox',        tier: 'supporting', rank: 1 },
  { id: 'thug1',   name: 'Bank Robber',       tier: 'minor', rank: 0 },
  { id: 'anchor',  name: 'News Anchor',       tier: 'minor', rank: 1 },
];

for (const cvdSafe of [false, true]) {
  const { characters, warnings } = assignColors(cast, { cvdSafe });
  const mains = characters.filter(c => c.tier === 'main');
  console.log(`\n--- cvdSafe: ${cvdSafe} ---`);
  for (const c of characters) console.log(`  ${c.tier.padEnd(11)} ${c.name.padEnd(18)} ${c.color}`);
  console.log(`  worst-case ΔE across mains (incl. all dichromacies): ${worstCaseSeparation(mains.map(c=>c.color)).toFixed(1)}`);
  warnings.forEach(w => console.log(`  ! ${w}`));
}
