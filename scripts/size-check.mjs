import { sizeFromDb, DEFAULT_OPTIONS as O } from 'cwi-core';
console.log('dB   -> size%   (baseline 5, knee ±' + O.dbKneeDb + 'dB)');
for (const db of [-18,-14,-10,-6,-3,0,3,6,9,12,16]) {
  const s = sizeFromDb(db);
  const bar = '█'.repeat(Math.round(s * 3));
  console.log(String(db).padStart(4), '->', s.toFixed(2).padStart(5), bar);
}
