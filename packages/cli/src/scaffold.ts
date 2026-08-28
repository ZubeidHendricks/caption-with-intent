/**
 * `cwi init` — scaffold a working Caption with Intention app.
 *
 * The output runs immediately: a Vite app that loads a manifest, renders it
 * over a video, and has the colour-vision simulator and validation panel
 * wired up. Starting from something that works beats starting from an empty
 * directory and a README.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignColors, type CwiManifest } from '@chorus/core';
import { CwiError } from './ops.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, so scaffolded projects can depend on the workspace packages. */
function repoRoot(): string | null {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'packages', '@chorus/core', 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

export interface InitOptions {
  dir: string;
  name?: string;
  force?: boolean;
}

export function init(opts: InitOptions): { dir: string; files: string[]; next: string[] } {
  const dir = resolve(opts.dir);
  const name = opts.name ?? dir.split(/[/\\]/).pop() ?? 'cwi-app';

  if (existsSync(dir) && readdirSync(dir).length && !opts.force) {
    throw new CwiError(`${dir} is not empty.`, 'Pass --force to scaffold into it anyway.');
  }
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'captions'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });

  const root = repoRoot();
  const dep = (pkg: string) =>
    root ? `file:${relative(dir, join(root, 'packages', pkg)).replace(/\\/g, '/')}` : '^0.1.0';

  const files: Array<[string, string]> = [
    ['package.json', JSON.stringify({
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { '@chorus/core': dep('@chorus/core'), '@chorus/web': dep('@chorus/web') },
      devDependencies: { vite: '^5.4.0', typescript: '^5.6.0' },
    }, null, 2) + '\n'],

    ['vite.config.js',
      `import { defineConfig } from 'vite';\n\n` +
      `export default defineConfig({\n` +
      `  // Workspace packages are rebuilt in place by tsc; pre-bundling them\n` +
      `  // makes Vite serve a stale copy after every rebuild.\n` +
      `  optimizeDeps: { exclude: ['@chorus/core', '@chorus/web'] },\n});\n`],

    ['index.html', INDEX_HTML(name)],
    ['src/main.ts', MAIN_TS],
    ['captions/example.cwi.json', JSON.stringify(exampleManifest(), null, 2) + '\n'],
    ['.gitignore', 'node_modules/\ndist/\n'],
    ['README.md', README(name)],
  ];

  for (const [rel, content] of files) writeFileSync(join(dir, rel), content);

  return {
    dir,
    files: files.map(([f]) => f),
    next: [
      `cd ${opts.dir}`,
      'npm install',
      'npm run dev',
      '',
      'Drop a video at public/scene.mp4 and it will play behind the captions.',
      'Replace captions/example.cwi.json with your own — `cwi analyze` produces one.',
    ],
  };
}

function exampleManifest(): CwiManifest {
  const { characters } = assignColors([
    { id: 'vale', name: 'Detective Vale', tier: 'main', role: 'hero', rank: 0 },
    { id: 'kroft', name: 'Kroft', tier: 'main', role: 'villain', rank: 1 },
  ]);
  // Hand-written timings; a real manifest comes from the analyzer, which
  // measures onsets and acoustics off the audio.
  const line = (speaker: string, start: number, words: string[], db = 0, f0 = 180) => {
    let t = start;
    const tokens = words.map((w) => {
      const dur = 0.16 + 0.05 * w.length;
      const tok = { text: w, start: +t.toFixed(3), end: +(t + dur).toFixed(3), db, f0 };
      t += dur + 0.05;
      return tok;
    });
    return {
      id: `c${Math.round(start * 1000)}`,
      start, end: +(t + 0.3).toFixed(3),
      speaker, kind: 'dialogue' as const, onCamera: true,
      lines: [{ tokens }],
    };
  };
  return {
    cwi: '1.0',
    meta: { title: 'Example', aspectRatio: '16:9', language: 'en' },
    characters,
    cues: [
      line('vale', 0.5, ['The', 'gate', 'opened', 'from', 'the', 'inside.'], 0, 200),
      line('kroft', 4.0, ['Then', 'somebody', 'here', 'opened', 'it.'], 0, 105),
    ],
  };
}

const INDEX_HTML = (name: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Roboto Flex is required: the intonation layer animates its wght and wdth axes. -->
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wdth,wght@8..144,-10..0,25..151,100..1000&display=swap" rel="stylesheet">
<style>
  body { margin: 0; background: #0b0c0e; color: #e8eaed; font: 14px system-ui, sans-serif; padding: 24px; }
  #stage { position: relative; width: 100%; max-width: 1100px; aspect-ratio: 16/9;
           background: #16222a; border-radius: 4px; overflow: hidden; }
  #stage video { width: 100%; height: 100%; display: block; object-fit: contain; }
  #captions { position: absolute; inset: 0; }
  .row { display: flex; gap: 10px; align-items: center; max-width: 1100px; margin-top: 12px; }
  input[type=range] { flex: 1; }
</style>
</head>
<body>
  <div id="stage">
    <video id="video" playsinline muted preload="auto"></video>
    <div id="captions"></div>
  </div>
  <div class="row">
    <button id="play">Play</button>
    <input id="scrub" type="range" min="0" max="10" step="0.01" value="0" />
    <span id="time">0.00</span>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;

const MAIN_TS = `import { CwiRenderer } from '@chorus/web';
import { validate, type CwiManifest } from '@chorus/core';
import manifest from '../captions/example.cwi.json';

const stage = document.getElementById('stage')!;
const video = document.getElementById('video') as HTMLVideoElement;
const captions = document.getElementById('captions')!;
const scrub = document.getElementById('scrub') as HTMLInputElement;

const m = manifest as CwiManifest;

// Validate on load. A caption track that fails validation is an accessibility
// bug, not a cosmetic one — surface it rather than shipping it quietly.
const issues = validate(m);
for (const i of issues) {
  const log = i.severity === 'error' ? console.error : console.warn;
  log(\`[cwi] \${i.severity} \${i.code}\${i.ref ? ' ' + i.ref : ''}: \${i.message}\`);
}

const renderer = new CwiRenderer(captions, {});
renderer.load(m);

// The app owns the clock and the video follows it. That keeps captions
// authoritative even if the media element stalls, and mirrors how an editor
// integration works: the playhead leads, captions follow.
const duration = Math.max(...m.cues.map((c) => c.end)) + 1;
scrub.max = String(duration);

let t = 0;
let playing = false;
let last = performance.now();
let bound = false;

video.src = '/scene.mp4';
renderer.observe(video);
video.addEventListener('loadedmetadata', () => { bound = true; renderer.seek(t); }, { once: true });
video.addEventListener('error', () => console.info('[cwi] no video at public/scene.mp4 — captions render on their own'));

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (playing) {
    t += dt;
    if (t >= duration) t = 0;
    scrub.value = String(t);
    if (bound && Math.abs(video.currentTime - t) > 0.25) video.currentTime = t;
  }
  renderer.seek(t);
  document.getElementById('time')!.textContent = t.toFixed(2);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.getElementById('play')!.onclick = async () => {
  playing = !playing;
  if (bound) { if (playing) await video.play().catch(() => {}); else video.pause(); }
};
scrub.oninput = () => { t = +scrub.value; if (bound) video.currentTime = t; renderer.seek(t); };

void stage;
`;

const README = (name: string) => `# ${name}

A Caption with Intention app.

    npm install
    npm run dev

Put a video at \`public/scene.mp4\` and it plays behind the captions. Without
one the captions still render, so you can work on timing before you have picture.

## Where the captions come from

\`captions/example.cwi.json\` is a hand-written placeholder. Real manifests come
from the analyzer, which measures word onsets and per-word acoustics off the
audio:

    cwi analyze scene.mp4 --vtt scene.vtt --out captions/scene.cwi.json
    cwi assign captions/scene.cwi.json
    cwi validate captions/scene.cwi.json

## Things worth knowing

- **Roboto Flex is required.** The intonation layer animates its \`wght\` and
  \`wdth\` axes; a static font silently loses that whole dimension.
- **Validation is not cosmetic.** \`validate()\` catches unattributed dialogue,
  unreadable caption rates, and speaker colours that collide under
  colour-vision deficiency. This app logs them to the console on load.
- **Colours come from \`assignColors()\`**, which implements the spec's hue rules
  plus a colour-vision-safety constraint the spec itself lacks. Do not pick
  them by hand.
`;
