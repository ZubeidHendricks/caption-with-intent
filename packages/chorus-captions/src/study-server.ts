/**
 * Serves the study to participants and records their answers.
 *
 * The answer key never leaves the server: the client is sent a cue and a list
 * of candidate speakers, and posts back a choice. Grading happens here.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { CwiError } from './ops.js';
import {
  answerKey, buildTrials, loadVariants, recordResponse,
  type Trial, type Variant,
} from './study.js';

const require_ = createRequire(import.meta.url);
const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

export interface StudyOptions {
  variants: string[];
  video?: string;
  results: string;
  port?: number;
  host?: string;
  /** Cap trials per participant so a session stays under ~15 minutes. */
  maxTrials?: number;
}

export interface StudyHandle {
  url: string;
  port: number;
  variants: Variant[];
  close: () => Promise<void>;
}

function sendFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(path)) { res.writeHead(404).end('not found'); return; }
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
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

const distOf = (pkg: string) => dirname(require_.resolve(pkg));

export async function startStudy(opts: StudyOptions): Promise<StudyHandle> {
  const variants = loadVariants(opts.variants);
  const key = answerKey(variants);
  const video = opts.video ? resolve(opts.video) : undefined;
  if (video && !existsSync(video)) throw new CwiError(`No such video: ${video}`);

  const coreDist = distOf('chorus-core');
  const webDist = distOf('chorus-web');
  const sessions = new Map<string, Trial[]>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
        .end(studyHtml(!!video));
      return;
    }

    if (p === '/session' && req.method === 'POST') {
      const participant = randomUUID();
      const trials = buildTrials(variants, participant, opts.maxTrials);
      sessions.set(participant, trials);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        participant,
        hasVideo: !!video,
        // The answer key is deliberately absent.
        trials: trials.map((t) => ({
          id: t.id, cueId: t.cueId, start: t.start, end: t.end, options: t.options,
        })),
        manifests: Object.fromEntries(variants.map((v) => [v.id, `/manifest/${v.id}`])),
        order: trials.map((t) => t.variantId),
      }));
      return;
    }

    if (p === '/answer' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { participant, trialId, answerId, ms } = JSON.parse(body);
          const trial = sessions.get(participant)?.find((t) => t.id === trialId);
          if (!trial) { res.writeHead(400).end('unknown trial'); return; }
          const expected = key.get(`${trial.variantId}:${trial.cueId}`);
          recordResponse(opts.results, {
            trialId, variantId: trial.variantId, cueId: trial.cueId,
            answerId, correct: answerId === expected, ms,
            participant, at: new Date().toISOString(),
          });
          // Withheld: telling a participant whether they were right teaches them
          // the cast and inflates accuracy on every later trial.
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        } catch (e) {
          res.writeHead(400).end(String((e as Error).message));
        }
      });
      return;
    }

    if (p.startsWith('/manifest/')) {
      const v = variants.find((x) => x.id === p.slice('/manifest/'.length));
      if (!v) { res.writeHead(404).end('no such variant'); return; }
      return sendFile(req, res, v.manifestPath);
    }
    if (p === '/media' && video) return sendFile(req, res, video);
    if (p.startsWith('/_cwi/core/')) return sendFile(req, res, join(coreDist, p.slice(11)));
    if (p.startsWith('/_cwi/web/')) return sendFile(req, res, join(webDist, p.slice(10)));
    res.writeHead(404).end('not found');
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(
      e.code === 'EADDRINUSE'
        ? new CwiError(`Port ${opts.port} is already in use.`, 'Pass a free --port, or omit it.')
        : e));
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1',
      () => resolvePort((server.address() as { port: number }).port));
  });

  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/`,
    port, variants,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function studyHtml(hasVideo: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Caption study</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wdth,wght@8..144,-10..0,25..151,100..1000&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0d0f11;--panel:#16191c;--line:#2a2f34;--ink:#eceef0;--dim:#98a0a8;--accent:#7ee081}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:17px/1.6 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
  main{width:100%;max-width:940px}
  h1{font-size:22px;margin:0 0 8px}
  p.lead{color:var(--dim);margin:0 0 22px}
  #stage{position:relative;width:100%;aspect-ratio:16/9;border:1px solid var(--line);border-radius:6px;
         overflow:hidden;background:radial-gradient(120% 90% at 22% 18%,#22323a 0%,#16222a 45%,#0a1116 80%)}
  #stage video{width:100%;height:100%;display:block;object-fit:contain}
  #caps{position:absolute;inset:0}
  .q{margin:24px 0 10px;font-size:19px}
  .opts{display:flex;gap:10px;flex-wrap:wrap}
  button{background:var(--panel);color:var(--ink);border:2px solid var(--line);border-radius:6px;
         padding:14px 22px;font:inherit;cursor:pointer;min-width:132px}
  button:hover{border-color:#3d444b}
  button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
  .bar{height:5px;background:var(--panel);border-radius:3px;overflow:hidden;margin:22px 0 6px}
  .bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .25s}
  .meta{color:var(--dim);font-size:14px}
  .done{text-align:center;padding:64px 0}
  kbd{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:2px 7px;font-size:14px}
</style></head><body><main>
<div id="intro">
  <h1>Caption study</h1>
  <p class="lead">You will see short captioned clips. After each one, choose who you think was
  speaking. There are no trick questions and no time limit — answer as you naturally would.
  Nothing here uses sound.</p>
  <p class="lead">You can answer with the number keys <kbd>1</kbd>–<kbd>9</kbd> or by clicking.</p>
  <button id="begin">Begin</button>
</div>

<div id="task" hidden>
  <div id="stage">${hasVideo ? '<video id="vid" playsinline muted preload="auto"></video>' : ''}<div id="caps"></div></div>
  <p class="q" id="question">Who was speaking?</p>
  <div class="opts" id="opts"></div>
  <div class="bar"><i id="prog"></i></div>
  <p class="meta" id="count"></p>
</div>

<div id="done" hidden class="done">
  <h1>Finished</h1>
  <p class="lead">Thank you. Your answers have been recorded.</p>
</div>
</main>
<script type="importmap">
{"imports":{"chorus-core":"/_cwi/core/index.js","chorus-web":"/_cwi/web/index.js"}}
</script>
<script type="module">
import { CwiRenderer } from 'chorus-web';

const $ = (id) => document.getElementById(id);
const video = $('vid');
let session, i = 0, shownAt = 0, renderer = null;
const manifests = {};

$('begin').onclick = async () => {
  session = await fetch('/session', { method: 'POST' }).then(r => r.json());
  for (const [id, url] of Object.entries(session.manifests)) {
    manifests[id] = await fetch(url).then(r => r.json());
  }
  if (video) video.src = '/media';
  renderer = new CwiRenderer($('caps'), {});
  if (video) renderer.observe(video);
  $('intro').hidden = true;
  $('task').hidden = false;
  show();
};

function show() {
  const t = session.trials[i];
  const shownIndex = i;
  const variantId = session.order[i];
  renderer.load(manifests[variantId]);

  // Paint the cue's start state synchronously before animating. rAF does not
  // fire in a background tab, so a participant who tabbed away and back — or is
  // on a throttled machine — would otherwise be asked to name a speaker while
  // looking at an empty frame.
  renderer.seek(t.start);
  if (video) video.currentTime = t.start;

  // Play the cue once, then hold on its final state so the whole line stays
  // readable while the participant decides.
  let clock = t.start;
  const step = () => {
    clock = Math.min(clock + 1 / 30, t.end);
    if (video && Math.abs(video.currentTime - clock) > 0.2) video.currentTime = clock;
    renderer.seek(clock);
    if (clock < t.end) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  // Guarantee the hold state on a timer as well. If rAF never runs, the
  // participant still ends up looking at the complete line rather than a
  // half-revealed one, which would make the trial measure the wrong thing.
  const holdAt = Math.max(t.start, t.end - 0.01);
  setTimeout(() => { if (i === shownIndex) renderer.seek(holdAt); },
    Math.min(6000, (t.end - t.start) * 1000 + 200));

  $('opts').innerHTML = t.options.map((o, n) =>
    \`<button data-id="\${o.id}">\${n + 1}. \${o.name}</button>\`).join('');
  for (const b of $('opts').querySelectorAll('button')) b.onclick = () => answer(b.dataset.id);
  $('opts').querySelector('button')?.focus();

  $('prog').style.width = \`\${(i / session.trials.length) * 100}%\`;
  $('count').textContent = \`\${i + 1} of \${session.trials.length}\`;
  shownAt = performance.now();
}

async function answer(answerId) {
  await fetch('/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participant: session.participant, trialId: session.trials[i].id,
      answerId, ms: Math.round(performance.now() - shownAt),
    }),
  });
  i++;
  if (i >= session.trials.length) {
    $('task').hidden = true;
    $('done').hidden = false;
    return;
  }
  show();
}

addEventListener('keydown', (e) => {
  if ($('task').hidden) return;
  const n = Number(e.key);
  if (!n) return;
  const b = $('opts').querySelectorAll('button')[n - 1];
  if (b) b.click();
});
</script></body></html>`;
}
