/**
 * Check every package name against the registry before publishing anything.
 *
 * Two things go wrong here, and both are cheap to check and expensive to hit:
 *
 *   1. A name is taken by someone else. npm's error for this is a 403 partway
 *      through a loop, after earlier packages in the same release have already
 *      gone out — a half-published release that cannot be undone.
 *   2. A name is ours but the version already exists. Same shape of failure.
 *
 * Neither is hypothetical. The unscoped name `chorus-mcp` was free when this
 * project chose it and was published by an unrelated party hours later; the
 * first the release knew of it was a 403, and only an unrelated failure earlier
 * in the loop kept that from being a half-published release. Moving under a
 * scope removes the race, and this check is what proves it stayed removed.
 *
 * Run before the publish step. Network access is the point, so this is not part
 * of the offline preflight in check.mjs.
 *
 *   node scripts/release/names.mjs [--whoami <npm-user>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** Directory names under packages/; the scoped name is read from each package.json. */
const PACKAGES = ['core', 'web', 'cli', 'mcp'];

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Who we publish as. Without it, ownership cannot be judged, only existence. */
const me = arg('whoami');

let failed = 0;
const note = (name, msg) => { console.error(`  ✗ ${name}: ${msg}`); failed++; };

for (const dir of PACKAGES) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
  const { name, version } = pkg;

  let res;
  try {
    res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  } catch (e) {
    note(name, `could not reach the registry: ${e.message}`);
    continue;
  }

  if (res.status === 404) {
    console.log(`  ✓ ${name}@${version} — name is free`);
    continue;
  }
  if (!res.ok) {
    note(name, `registry returned ${res.status}`);
    continue;
  }

  const meta = await res.json();
  const owners = (meta.maintainers ?? []).map((m) => m.name);

  if (me && !owners.includes(me)) {
    note(name, `taken by ${owners.join(', ') || 'someone else'} — "${meta.description ?? ''}"`.slice(0, 160));
    continue;
  }
  if (!me) {
    note(name, `already exists (maintainers: ${owners.join(', ') || 'unknown'}); ` +
      'pass --whoami to confirm it is yours');
    continue;
  }
  if (meta.versions?.[version]) {
    note(name, `${version} is already published and npm versions are immutable`);
    continue;
  }
  console.log(`  ✓ ${name}@${version} — yours, and this version is new`);
}

if (failed) {
  console.error(`\n${failed} name(s) cannot be published as configured.`);
  console.error('Fix the names before tagging: a partly-published release cannot be undone.');
  process.exit(1);
}
console.log('\n✓ every package name is publishable');
