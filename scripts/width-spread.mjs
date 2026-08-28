import { widthFromCentroid } from 'chorus-core';
const voices = [['SpudsOxley',770],['AdamStone',798],['Archer',802],['MichaelC',848],
  ['DavidCastlemore',1232],['Ivy',1260],['Annie',1285],['Hope',1519],['Cassidy',1546],['MonikaSogam',1569]];
const w = voices.map(([n,c])=>[n,c,widthFromCentroid(c)]);
console.log('voice              centroid  wdth');
for (const [n,c,x] of w) console.log(`  ${n.padEnd(16)} ${String(c).padStart(6)} ${String(x).padStart(5)}`);
const xs = w.map(r=>r[2]);
console.log(`\n  spread: ${Math.min(...xs)} .. ${Math.max(...xs)}  (axis is 25..151)`);
console.log(`  uses ${Math.round((Math.max(...xs)-Math.min(...xs))/(151-25)*100)}% of the available width axis`);
