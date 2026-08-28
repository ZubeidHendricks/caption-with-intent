/**
 * Remove the copies `bundle-assets.mjs` made for packing.
 *
 * Those copies exist only inside a tarball. Left in the working tree they
 * *shadow* the real sources: `findPipeline()` prefers the package-local
 * pipeline/ so that an npm install works, which means after any local `npm
 * pack` or `npm publish` every subsequent command runs the copy that was
 * frozen at pack time. A new pipeline module simply does not exist, and an
 * edited one silently has no effect — the failure looks like a broken
 * environment rather than a stale copy.
 *
 * Runs on `postpack`, so packing cleans up after itself.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

for (const name of ['pipeline', 'conformance']) {
  const dir = join(pkgRoot, name);
  // Only remove a copy, never a real source directory: the repo's own live in
  // the root, and this script only ever looks inside the package.
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`[chorus] removed packed copy ${name}/`);
  }
}
