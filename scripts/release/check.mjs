/**
 * Refuse to publish something broken.
 *
 * Publishing is irreversible — a version number can never be reused, and an
 * unpublish window is 72 hours at best. Everything cheap to verify beforehand
 * gets verified here.
 *
 *   node scripts/release/check.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_REPO } from './stamp.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const NAMES = ['cwi-core', 'cwi-web', 'cwi-cli', 'cwi-mcp'];

const problems = [];
const notes = [];
const fail = (pkg, msg) => problems.push(`${pkg}: ${msg}`);

const pkgs = Object.fromEntries(NAMES.map((n) => {
  const p = join(root, 'packages', n, 'package.json');
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return [n, { dir: join(root, 'packages', n), json: JSON.parse(readFileSync(p, 'utf8')) }];
}));

// --- versions agree -------------------------------------------------------
const versions = new Set(NAMES.map((n) => pkgs[n].json.version));
if (versions.size !== 1) {
  problems.push(`versions disagree across packages: ${[...versions].join(', ')}`);
}
const version = pkgs['cwi-core'].json.version;

for (const name of NAMES) {
  const { dir, json } = pkgs[name];

  if (json.private) fail(name, 'marked private — it will not publish');
  if (json.name !== name) fail(name, `name is "${json.name}", expected "${name}"`);
  for (const field of ['description', 'license', 'author', 'homepage', 'repository', 'bugs', 'engines', 'files']) {
    if (!json[field]) fail(name, `missing "${field}"`);
  }
  if (json.description && json.description.length < 30) fail(name, 'description is too short to be useful on npm');
  if (!json.keywords?.length) fail(name, 'no keywords — nobody will find it');

  const repoUrl = json.repository?.url ?? '';
  if (repoUrl.includes('OWNER') || repoUrl.includes(PLACEHOLDER_REPO)) {
    fail(name, 'repository URL is still the placeholder — run stamp.mjs --repo <url>');
  }

  for (const f of ['README.md', 'LICENSE']) {
    if (!existsSync(join(dir, f))) fail(name, `missing ${f}`);
  }
  const readme = join(dir, 'README.md');
  if (existsSync(readme) && readFileSync(readme, 'utf8').length < 400) {
    fail(name, 'README is a stub');
  }

  // Built output must exist and be referenced correctly.
  if (!existsSync(join(dir, 'dist'))) fail(name, 'dist/ missing — run npm run build');
  const entry = json.exports?.['.']?.default ?? json.main;
  if (entry && !existsSync(join(dir, entry))) fail(name, `entry point ${entry} does not exist`);
  for (const [sub, target] of Object.entries(json.exports ?? {})) {
    const t = typeof target === 'string' ? target : target.default;
    if (t && !existsSync(join(dir, t))) fail(name, `exports["${sub}"] -> ${t} does not exist`);
  }

  // Binaries must exist and be executable, or the install produces a dead command.
  for (const [bin, target] of Object.entries(json.bin ?? {})) {
    const t = join(dir, target);
    if (!existsSync(t)) { fail(name, `bin "${bin}" -> ${target} does not exist`); continue; }
    if (!(statSync(t).mode & 0o111)) fail(name, `bin "${bin}" is not executable (chmod +x ${target})`);
    const head = readFileSync(t, 'utf8').slice(0, 20);
    if (!head.startsWith('#!')) fail(name, `bin "${bin}" has no shebang`);
  }

  // Internal deps must point at this exact release.
  for (const [dep, range] of Object.entries(json.dependencies ?? {})) {
    if (!NAMES.includes(dep)) continue;
    if (!range.includes(version)) fail(name, `depends on ${dep}@${range}, expected ^${version}`);
  }

  // What actually lands in the tarball.
  // Lifecycle scripts (prepack) echo to stdout ahead of the JSON, so slice from
  // the first bracket rather than trusting the whole stream to be parseable.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--silent'],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const start = out.indexOf('[');
  if (start < 0) { fail(name, `npm pack produced no JSON:\n${out.slice(0, 300)}`); continue; }
  const [meta] = JSON.parse(out.slice(start));
  const files = meta.files.map((f) => f.path);
  if (!files.some((f) => f === 'README.md')) fail(name, 'README.md not in the tarball');
  if (!files.some((f) => f === 'LICENSE')) fail(name, 'LICENSE not in the tarball');
  if (!files.some((f) => f.startsWith('dist/'))) fail(name, 'no dist/ in the tarball');
  if (files.some((f) => f.startsWith('src/') || f.startsWith('test/'))) {
    fail(name, 'source or tests are leaking into the tarball — check "files"');
  }
  if (name === 'cwi-cli' && !files.some((f) => f.startsWith('pipeline/'))) {
    fail(name, 'pipeline/ is missing — `cwi analyze` breaks for anyone installing from npm');
  }
  notes.push(`  ${name.padEnd(9)} ${String(files.length).padStart(3)} files  ${(meta.size / 1024).toFixed(0)} kB packed  ${(meta.unpackedSize / 1024).toFixed(0)} kB unpacked`);
}

console.log(`release check — version ${version}\n`);
console.log(notes.join('\n'));

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n✓ all packages look publishable');
