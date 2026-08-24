/**
 * Copy the Python pipeline into this package before packing.
 *
 * `cwi analyze` and `cwi scene` shell out to it. In the repo it lives at
 * ../../pipeline and is found by walking up; in an npm install nothing is above
 * node_modules, so it has to travel inside the tarball or those two commands
 * break the moment anyone installs from the registry.
 *
 * Runs on `prepack`, so it happens for `npm pack` and `npm publish` alike.
 */
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const source = join(pkgRoot, '..', '..', 'pipeline');
const dest = join(pkgRoot, 'pipeline');

if (!existsSync(source)) {
  console.error(`[cwi] pipeline source not found at ${source} — packing without it.`);
  console.error('[cwi] `cwi analyze` and `cwi scene` will not work in this build.');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

cpSync(source, dest, {
  recursive: true,
  filter: (src) => !/(__pycache__|\.pyc$|[/\\]test[/\\]?$|\.wav$|\.mp4$)/.test(src),
});

console.error(`[cwi] bundled pipeline -> ${dest}`);
