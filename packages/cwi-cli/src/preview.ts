/**
 * Zero-config preview server.
 *
 * Point it at a manifest and (optionally) a video and it serves a working
 * player. No bundler, no scaffolding, no node_modules in the output — the
 * browser gets the packages' own ESM `dist` over an import map, so what you
 * preview is exactly the published renderer rather than a copy of it.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { CwiError, readManifest } from './ops.js';

const require_ = createRequire(import.meta.url);

const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.map': 'application/json',
};

/**
 * Locate a workspace package's dist directory.
 *
 * Resolved through the package's main entry rather than its package.json: an
 * `exports` map blocks subpath access unless it explicitly lists
 * "./package.json", so resolving the manifest is the fragile way to do this.
 */
function distOf(pkg: string): string {
  try {
    return dirname(require_.resolve(pkg));
  } catch {
    throw new CwiError(`Cannot resolve ${pkg}.`, 'Run `npm install` at the repo root.');
  }
}

/**
 * Serve a file with HTTP range support.
 *
 * Media needs this: without a 206 path browsers will not seek, and some refuse
 * to start playback at all. It is the single most common reason a hand-rolled
 * static server "works" for HTML and silently fails for video.
 */
function sendFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}

export interface PreviewOptions {
  manifest: string;
  video?: string;
  port?: number;
  host?: string;
  /** Show the cast list and live validation panel alongside the frame. */
  inspector?: boolean;
}

export interface PreviewHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startPreview(opts: PreviewOptions): Promise<PreviewHandle> {
  const manifestPath = resolve(opts.manifest);
  readManifest(manifestPath);                       // fail fast on a bad manifest
  const videoPath = opts.video ? resolve(opts.video) : undefined;
  if (videoPath && !existsSync(videoPath)) throw new CwiError(`No such video: ${videoPath}`);

  const coreDist = distOf('cwi-core');
  const webDist = distOf('cwi-web');
  const html = playerHtml({ hasVideo: !!videoPath, inspector: opts.inspector !== false });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(html);
      return;
    }
    // Bare caption surface for offscreen capture: no chrome, no video, no
    // background — just the captions, at exactly the frame size, on alpha.
    if (p === '/render') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
        .end(renderHtml(Number(url.searchParams.get('w')) || 1920, Number(url.searchParams.get('h')) || 1080));
      return;
    }
    if (p === '/manifest.cwi.json') return sendFile(req, res, manifestPath);
    if (p === '/media') {
      if (!videoPath) { res.writeHead(404).end('no video'); return; }
      return sendFile(req, res, videoPath);
    }
    if (p.startsWith('/_cwi/core/')) return sendFile(req, res, join(coreDist, p.slice('/_cwi/core/'.length)));
    if (p.startsWith('/_cwi/web/')) return sendFile(req, res, join(webDist, p.slice('/_cwi/web/'.length)));
    res.writeHead(404).end('not found');
  });

  const port = await listen(server, opts.port ?? 0, opts.host ?? '127.0.0.1');
  const url = `http://${opts.host ?? '127.0.0.1'}:${port}/`;
  return {
    url,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<number> {
  return new Promise((res, rej) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      rej(e.code === 'EADDRINUSE'
        ? new CwiError(`Port ${port} is already in use.`, 'Pass --port with a free port, or omit it to pick one automatically.')
        : e);
    });
    server.listen(port, host, () => res((server.address() as { port: number }).port));
  });
}

function playerHtml({ hasVideo, inspector }: { hasVideo: boolean; inspector: boolean }): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Caption with Intention — preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wdth,wght@8..144,-10..0,25..151,100..1000&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0c0e;--panel:#141619;--line:#24272c;--ink:#e8eaed;--dim:#8b9198;--accent:#E5E517;--err:#ff6b6b;--warn:#ffb454;--ok:#6bd68a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 'IBM Plex Mono',ui-monospace,monospace;
 display:grid;grid-template-columns:minmax(0,1fr) ${inspector ? '330px' : '0'};min-height:100vh}
@media(max-width:900px){body{grid-template-columns:1fr}}
main{padding:20px;min-width:0}
h1{font-size:14px;margin:0 0 3px;font-weight:500}
.sub{color:var(--dim);font-size:12px;margin-bottom:14px}
#stage{position:relative;width:100%;aspect-ratio:16/9;border:1px solid var(--line);border-radius:4px;overflow:hidden;
 background:radial-gradient(120% 90% at 22% 18%,#22323a 0%,#16222a 45%,#0a1116 80%)}
#stage video{width:100%;height:100%;display:block;object-fit:contain}
#capture{position:absolute;inset:0}
.transport{display:flex;gap:10px;align-items:center;margin-top:12px}
button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:3px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}
button[data-on=true]{background:var(--accent);color:#111;border-color:var(--accent)}
input[type=range]{flex:1;accent-color:var(--accent)}
.time{color:var(--dim);font-size:12px;min-width:96px;text-align:right}
aside{background:var(--panel);border-left:1px solid var(--line);padding:18px 16px;overflow-y:auto;max-height:100vh;${inspector ? '' : 'display:none'}}
aside h2{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:20px 0 8px;font-weight:500}
aside h2:first-child{margin-top:0}
.seg{display:flex;gap:4px;flex-wrap:wrap}.seg button{padding:4px 8px;font-size:11px}
.cast div{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:5px}
.sw{width:24px;height:12px;border-radius:2px;flex:none}
.tier{color:var(--dim);font-size:10px;margin-left:auto}
.issue{padding:6px 8px;border-radius:3px;border-left:2px solid;background:#1a1d21;font-size:11px;line-height:1.45;margin-bottom:6px}
.issue.error{border-color:var(--err)}.issue.warning{border-color:var(--warn)}.issue.info{border-color:var(--dim)}
.issue code{color:var(--dim);font-size:10px;display:block}
.clean{color:var(--ok);font-size:12px}
.warnbar{background:#2a2214;border:1px solid #5a4a1e;color:var(--warn);padding:8px 10px;border-radius:3px;font-size:12px;margin-bottom:12px;display:none}
</style></head><body>
<main>
  <h1>Caption with Intention — preview</h1>
  <div class="sub" id="stat">loading…</div>
  <div class="warnbar" id="warnbar"></div>
  <div id="stage">${hasVideo ? '<video id="vid" playsinline muted preload="auto"></video>' : ''}<div id="capture"></div></div>
  <div class="transport">
    <button id="play">Play</button>
    <input id="scrub" type="range" min="0" max="10" step="0.01" value="0">
    <span class="time" id="time">0.00 / 0.00</span>
  </div>
</main>
<aside>
  <h2>Colour-vision simulation</h2>
  <div class="seg" id="cvd">
    <button data-cvd="none" data-on="true">Normal</button><button data-cvd="prot">Protan</button>
    <button data-cvd="deut">Deutan</button><button data-cvd="trit">Tritan</button>
  </div>
  <h2>Cast</h2><div class="cast" id="cast"></div>
  <h2>Validation</h2><div id="issues"></div>
</aside>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<filter id="f-prot" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="0.152286 1.052583 -0.204868 0 0 0.114503 0.786281 0.099216 0 0 -0.003882 -0.048116 1.051998 0 0 0 0 0 1 0"/></filter>
<filter id="f-deut" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="0.367322 0.860646 -0.227968 0 0 0.280085 0.672501 0.047413 0 0 -0.011820 0.042940 0.968881 0 0 0 0 0 1 0"/></filter>
<filter id="f-trit" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="1.255528 -0.076749 -0.178779 0 0 -0.078411 0.930809 0.147602 0 0 0.004733 0.691367 0.303900 0 0 0 0 0 1 0"/></filter>
</defs></svg>
<script type="importmap">
{"imports":{"cwi-core":"/_cwi/core/index.js","cwi-web":"/_cwi/web/index.js"}}
</script>
<script type="module">
import { CwiRenderer } from 'cwi-web';
import { validate, speakerStats } from 'cwi-core';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), capture = $('capture'), video = $('vid');
const manifest = await fetch('/manifest.cwi.json').then(r => r.json());

const renderer = new CwiRenderer(capture, {});
renderer.load(manifest);

const duration = Math.max(...manifest.cues.map(c => c.end)) + 1;
$('scrub').max = String(duration);
let t = 0, playing = false, last = performance.now(), bound = false;

if (video) {
  video.src = '/media';
  renderer.observe(video);
  video.addEventListener('loadedmetadata', () => { bound = true; renderer.seek(t); }, { once: true });
  // Media in a background tab may never load; say so rather than showing black.
  setTimeout(() => {
    if (!bound && document.hidden) {
      $('warnbar').style.display = 'block';
      $('warnbar').textContent = 'The video has not loaded — browsers defer media in background tabs. Focus this tab and it will start.';
    }
  }, 4000);
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (playing) {
    t += dt; if (t >= duration) t = 0;
    $('scrub').value = String(t);
    if (bound && Math.abs(video.currentTime - t) > 0.25) video.currentTime = t;
  }
  renderer.seek(t);
  $('time').textContent = t.toFixed(2) + ' / ' + duration.toFixed(2);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('play').onclick = async () => {
  playing = !playing;
  $('play').textContent = playing ? 'Pause' : 'Play';
  $('play').dataset.on = String(playing);
  if (bound) { if (playing) await video.play().catch(()=>{}); else video.pause(); }
};
$('scrub').oninput = (e) => { t = +e.target.value; if (bound) video.currentTime = t; renderer.seek(t); };

const FILTERS = { none:'', prot:'url(#f-prot)', deut:'url(#f-deut)', trit:'url(#f-trit)' };
$('cvd').querySelectorAll('button').forEach(b => b.onclick = () => {
  $('cvd').querySelectorAll('button').forEach(x => x.dataset.on = 'false');
  b.dataset.on = 'true';
  stage.style.filter = FILTERS[b.dataset.cvd];
  document.querySelectorAll('.sw').forEach(s => s.style.filter = FILTERS[b.dataset.cvd]);
});

const st = speakerStats(manifest.cues);
$('cast').innerHTML = manifest.characters.map(c => {
  const s = st.get(c.id);
  return '<div><span class="sw" style="background:' + (c.color || '#fff') + '"></span><span>' +
    (c.name || c.id) + '</span><span class="tier">' + c.tier + (s ? ' · ' + s.words + 'w' : '') + '</span></div>';
}).join('');

const issues = validate(manifest);
$('issues').innerHTML = issues.length
  ? issues.map(i => '<div class="issue ' + i.severity + '"><code>' + i.code + (i.ref ? ' · ' + i.ref : '') + '</code>' + i.message + '</div>').join('')
  : '<div class="clean">No issues.</div>';

const errs = issues.filter(i => i.severity === 'error').length;
const warns = issues.filter(i => i.severity === 'warning').length;
const tokens = manifest.cues.reduce((n,c) => n + c.lines.reduce((k,l) => k + l.tokens.length, 0), 0);
$('stat').textContent = (manifest.meta?.title ? manifest.meta.title + ' · ' : '') +
  manifest.characters.length + ' characters · ' + manifest.cues.length + ' cues · ' +
  tokens + ' tokens · ' + errs + ' errors, ' + warns + ' warnings';
</script></body></html>`;
}

/**
 * The capture surface used by `cwi render`.
 *
 * Deliberately the same renderer the preview uses — a burned-in master and the
 * on-screen preview come from one implementation, so they cannot drift. The
 * page exposes `__cwiSeek` and `__cwiReady` for the capture loop to drive.
 */
function renderHtml(w: number, h: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wdth,wght@8..144,-10..0,25..151,100..1000&display=block" rel="stylesheet">
<style>
  html,body{margin:0;padding:0;background:transparent}
  #frame{position:relative;width:${w}px;height:${h}px;overflow:hidden}
</style></head>
<body><div id="frame"></div>
<script type="importmap">
{"imports":{"cwi-core":"/_cwi/core/index.js","cwi-web":"/_cwi/web/index.js"}}
</script>
<script type="module">
import { CwiRenderer } from 'cwi-web';
const manifest = await fetch('/manifest.cwi.json').then(r => r.json());
const frame = document.getElementById('frame');
const renderer = new CwiRenderer(frame, { frame: { width: ${w}, height: ${h} } });
renderer.load(manifest);
renderer.seek(0);

// Fonts must be resolved before the first capture, or early frames render in a
// fallback face and the whole intonation layer is silently wrong.
//
// But never block forever on it. Roboto Flex comes from a font CDN, and a slow
// or blocked network would otherwise hang the page indefinitely — which turns a
// transient network problem into a render that never finishes and a test suite
// that silently skips itself. Race the load and report the outcome instead.
const fontsLoaded = await Promise.race([
  (async () => {
    await document.fonts.load("400 100px 'Roboto Flex'");
    await document.fonts.load("900 100px 'Roboto Flex'");
    await document.fonts.ready;
    return true;
  })(),
  new Promise((r) => setTimeout(() => r(false), 15000)),
]);

window.__cwiFontsLoaded = fontsLoaded;
if (!fontsLoaded) {
  console.warn('[cwi] Roboto Flex did not load within 15s — rendering in a fallback face. ' +
    'The variable-font axes carry the intonation layer, so this output is not spec-accurate.');
}

window.__cwiSeek = (t) => { renderer.seek(t); };
// Exposed so tests can swap the manifest without a page reload, which would
// mean re-fetching the font on every case.
window.__cwiManifest = manifest;
window.__cwiReload = (m) => { renderer.load(m); renderer.seek(0); };
window.__cwiReady = true;
</script></body></html>`;
}
