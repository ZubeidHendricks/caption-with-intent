import { conform } from '@chorus/cli/conform';
import * as mutants from '../conformance/mutants/mutants.mjs';
console.log('mutant'.padEnd(20), 'caught', ' failing vectors');
let missed = 0;
for (const [name, impl] of Object.entries(mutants)) {
  const r = await conform(impl);
  const caught = !r.ok;
  if (!caught) missed++;
  const vectors = [...new Set(r.normativeFailures.map(f => f.vector))].join(', ') || '—';
  console.log(name.padEnd(20), caught ? ' yes  ' : ' NO   ', vectors.slice(0, 60));
}
console.log(missed ? `\n${missed} mutant(s) NOT caught — the suite has a hole` : '\nall mutants caught');
