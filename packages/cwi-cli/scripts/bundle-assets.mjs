/**
 * Copy the repo-level data this package needs into the tarball before packing.
 *
 * Two directories live above the package in the repo and are found by walking
 * up. In an npm install nothing is above node_modules, so anything not copied
 * in here simply does not exist for anyone who installed from the registry:
 *
 *   pipeline/     `cwi analyze` and `cwi scene` shell out to it
 *   conformance/  `cwi conform` and `cwi conform-render` read their vectors,
 *                 scenes and mutants from it
 *
 * The conformance data is the part an integrator most needs and the part they
 * are least able to reconstruct — shipping a conformance runner with no
 * vectors is worse than shipping no runner, because it fails at the moment
 * someone is trying to prove their implementation correct.
 *
 * Runs on `prepack`, so it happens for `npm pack` and `npm publish` alike.
 */
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const copies = [
  {
    name: 'pipeline',
    source: join(pkgRoot, '..', '..', 'pipeline'),
    dest: join(pkgRoot, 'pipeline'),
    needed: '`cwi analyze` and `cwi scene`',
    // Test fixtures and media are large and not needed to run the pipeline.
    filter: (src) => !/(__pycache__|\.pyc$|[/\\]test[/\\]?$|\.wav$|\.mp4$)/.test(src),
  },
  {
    name: 'conformance',
    source: join(pkgRoot, '..', '..', 'conformance'),
    dest: join(pkgRoot, 'conformance'),
    needed: '`cwi conform` and `cwi conform-render`',
    filter: () => true,
  },
];

let missing = false;
for (const c of copies) {
  if (!existsSync(c.source)) {
    console.error(`[cwi] ${c.name} source not found at ${c.source} — packing without it.`);
    console.error(`[cwi] ${c.needed} will not work in this build.`);
    missing = true;
    continue;
  }
  rmSync(c.dest, { recursive: true, force: true });
  mkdirSync(c.dest, { recursive: true });
  cpSync(c.source, c.dest, { recursive: true, filter: c.filter });
  console.error(`[cwi] bundled ${c.name} -> ${c.dest}`);
}

if (missing) process.exit(1);
