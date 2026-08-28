/**
 * Stamp consistent publish metadata across every package.
 *
 * Four package.json files drifting apart is a when-not-if problem: one ends up
 * with a stale repository URL or a missing `files` array and ships something
 * broken. This is the single source of truth; run it instead of hand-editing.
 *
 *   node scripts/release/stamp.mjs [--repo https://github.com/you/repo]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Only stamp when run directly; check.mjs imports the placeholder constant. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

/**
 * Sentinel for un-set metadata. `check.mjs` refuses to pass while this stands,
 * so a fork that never sets its own repository cannot publish pointing at
 * nothing.
 */
export const PLACEHOLDER_REPO = 'https://github.com/OWNER/caption-with-intent';

/** The real home. Running stamp with no --repo must not revert to the sentinel. */
export const DEFAULT_REPO = 'https://github.com/ZubeidHendricks/caption-with-intent';

if (isMain) main();

function main() {
const REPO = arg('repo', DEFAULT_REPO);
const VERSION = arg('version', null);
const AUTHOR = arg('author', 'Zubeid Hendricks');
const LICENSE = 'MIT';

const COMMON_KEYWORDS = [
  'captions', 'subtitles', 'accessibility', 'a11y', 'deaf', 'hard-of-hearing',
  'caption-with-intention', 'cwi', 'variable-fonts', 'webvtt',
];

const PACKAGES = {
  'core': {
    keywords: [...COMMON_KEYWORDS, 'colour-blindness', 'color-vision-deficiency', 'wcag'],
    sideEffects: false,
    files: ['dist', 'README.md', 'LICENSE'],
  },
  'web': {
    keywords: [...COMMON_KEYWORDS, 'renderer', 'video', 'roboto-flex'],
    sideEffects: false,
    files: ['dist', 'README.md', 'LICENSE'],
  },
  'cli': {
    keywords: [...COMMON_KEYWORDS, 'cli', 'ffmpeg', 'transcription'],
    files: ['dist', 'pipeline', 'conformance', 'README.md', 'LICENSE'],
  },
  'mcp': {
    keywords: [...COMMON_KEYWORDS, 'mcp', 'model-context-protocol', 'ai-agents'],
    files: ['dist', 'README.md', 'LICENSE'],
  },
};

/** Published names of the packages in this repo, for internal-dep matching. */
const INTERNAL = new Set(Object.keys(PACKAGES).map(
  (d) => JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8')).name));

const changed = [];
for (const [name, extra] of Object.entries(PACKAGES)) {
  const path = join(root, 'packages', name, 'package.json');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const before = JSON.stringify(p);

  if (VERSION) p.version = VERSION;
  p.license = LICENSE;
  p.author = AUTHOR;
  p.homepage = `${REPO}#readme`;
  p.repository = { type: 'git', url: `git+${REPO}.git`, directory: `packages/${name}` };
  p.bugs = { url: `${REPO}/issues` };
  p.engines = { node: '>=18' };
  // Unscoped packages are public anyway; stating it prevents a surprise if the
  // names ever move under a scope.
  p.publishConfig = { access: 'public' };
  Object.assign(p, extra);

  // Internal deps track the stamped version with a caret so patches flow.
  // PACKAGES is keyed by directory, so match on the published names instead —
  // keying on the directory silently matches nothing once the names are scoped.
  for (const field of ['dependencies', 'peerDependencies']) {
    if (!p[field]) continue;
    for (const dep of Object.keys(p[field])) {
      if (INTERNAL.has(dep)) p[field][dep] = `^${VERSION ?? p.version}`;
    }
  }

  const scripts = p.scripts ?? {};
  scripts.prepublishOnly = 'npm run build';
  p.scripts = scripts;

  const after = JSON.stringify(p);
  writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
  if (before !== after) changed.push(name);
}

/**
 * The demo is not published, but it depends on two packages that are. Pinning
 * it to an exact version means that the moment the workspace version moves,
 * npm stops satisfying the dependency locally and installs the *published*
 * package instead — the demo then silently exercises the registry copy rather
 * than the code in this repo. "*" always resolves to the workspace.
 */
const demoPath = join(root, 'apps', 'demo', 'package.json');
if (existsSync(demoPath)) {
  const demo = JSON.parse(readFileSync(demoPath, 'utf8'));
  let touched = false;
  for (const dep of Object.keys(demo.dependencies ?? {})) {
    if (INTERNAL.has(dep) && demo.dependencies[dep] !== '*') {
      demo.dependencies[dep] = '*';
      touched = true;
    }
  }
  if (touched) {
    writeFileSync(demoPath, JSON.stringify(demo, null, 2) + '\n');
    console.log('  demo repointed at the workspace');
  }
}

console.log(`stamped ${Object.keys(PACKAGES).length} packages` + (VERSION ? ` at ${VERSION}` : ''));
if (changed.length) console.log(`  changed: ${changed.join(', ')}`);
if (REPO === PLACEHOLDER_REPO) {
  console.log(`\n  repository is still the placeholder.`);
  console.log(`  run: node scripts/release/stamp.mjs --repo https://github.com/you/your-repo`);
} else {
  console.log(`  repository: ${REPO}`);
}
}
