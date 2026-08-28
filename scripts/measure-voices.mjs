// Map measured f0/centroid to the typography they will produce.
import { weightFromF0, widthFromCentroid } from '@chorus/core';
const rows = JSON.parse(process.argv[2]);
console.log('voice               f0 Hz  centroid  ->  wght  wdth');
for (const [n, f0, cen] of rows.sort((a,b)=>a[1]-b[1])) {
  console.log(n.padEnd(18), String(Math.round(f0)).padStart(6), String(Math.round(cen)).padStart(9),
              '  ', String(weightFromF0(f0)).padStart(5), String(widthFromCentroid(cen)).padStart(5));
}
