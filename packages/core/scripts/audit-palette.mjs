import { MAIN_COLORS, SUPPORTING_COLORS, simulateCvd, deltaE, contrastRatio, auditColors } from '../dist/index.js';

const chars = MAIN_COLORS.map((s, i) => ({ id: s.name.replace('CI Main ',''), tier: 'main', color: s.hex, rank: i }));
console.log('=== CWI six main colours: pairwise ΔE ===\n');
for (const mode of ['normal','protanopia','deuteranopia','tritanopia']) {
  const sim = (h) => mode === 'normal' ? h : simulateCvd(h, mode);
  const bad = [];
  for (let i=0;i<chars.length;i++) for (let j=i+1;j<chars.length;j++) {
    const d = deltaE(sim(chars[i].color), sim(chars[j].color));
    if (d < 20) bad.push(`${chars[i].id}/${chars[j].id} ΔE=${d.toFixed(1)}`);
  }
  console.log(`${mode.padEnd(13)} collisions(<20): ${bad.length ? bad.join('  ') : 'none'}`);
}
console.log('\n=== Contrast vs caption box (90% black over bright frame) ===');
for (const s of MAIN_COLORS) console.log(`  ${s.name.padEnd(16)} ${s.hex}  ${contrastRatio(s.hex,'#1A1A1A').toFixed(2)}:1`);
console.log('\n=== Deuteranopia simulation of the six mains ===');
for (const s of MAIN_COLORS) console.log(`  ${s.name.padEnd(16)} ${s.hex} -> ${simulateCvd(s.hex,'deuteranopia')}`);
