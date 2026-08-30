/**
 * A local web app: drop in a video, get captions, export.
 *
 * Everything it does already existed as a command. What did not exist was a
 * way to do it without knowing the commands, and that is most of why a tool
 * like this goes unused — the people who caption things are not the people who
 * enjoy argument parsers.
 *
 * It runs on the operator's own machine rather than a server, which is not a
 * limitation dressed up as a feature. Media is large, ffmpeg and a headless
 * browser are already local, and a caption workflow means uploading unreleased
 * footage to somebody's cloud — a thing productions are contractually forbidden
 * from doing. Nothing here leaves the machine.
 *
 * The honest constraint is transcription. Turning a video into captions means
 * knowing the words, and knowing the words means ASR. WhisperX is supported and
 * is the intended production path, but it pulls multi-gigabyte models and is
 * not installed by default, so the app works without it: bring a subtitle file
 * — every production already has one — and the words come from there while
 * everything this design contributes comes from the soundtrack.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync,
  readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { assignColors, getProfile, type CwiManifest } from '@corerus/chorus-core';
import { CwiError, analyzeMedia, checkPipelineEnv } from './ops.js';
import { render } from './render.js';
import { readSubtitles, matchByTime } from './translate.js';
import { studioHtml } from './studio-html.js';
import { runTeam, type StageReport } from './team.js';

export interface StudioOptions {
  port?: number;
  host?: string;
  /** Where uploads and renders live. Defaults to a temp directory. */
  workdir?: string;
}

export interface StudioHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface Job {
  id: string;
  stage: 'uploaded' | 'analyzing' | 'ready' | 'rendering' | 'done' | 'failed';
  message: string;
  /** Live stage-by-stage record from the team, for the page to show. */
  stages?: StageReport[];
  open?: string[];
  progress?: number;
  media?: string;
  manifest?: CwiManifest;
  manifestPath?: string;
  output?: string;
  error?: string;
}

const require_ = createRequire(import.meta.url);

/**
 * Serve each package's whole dist directory, not one entry file.
 *
 * A module's imports are its own business: index.js reaches for ./renderer.js
 * and for the core package by bare specifier. Serving a single file gives the
 * browser an entry point and no way to follow it. The page resolves the bare
 * specifier through an import map, exactly as the preview does.
 */
function distOf(pkg: string): string {
  try {
    return dirname(require_.resolve(pkg));
  } catch {
    throw new CwiError(`Cannot resolve ${pkg}.`, 'Run `npm install` at the repo root.');
  }
}

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;      // 2 GB
const jobs = new Map<string, Job>();

export async function startStudio(opts: StudioOptions = {}): Promise<StudioHandle> {
  const work = opts.workdir ?? mkdtempSync(join(tmpdir(), 'chorus-studio-'));
  mkdirSync(work, { recursive: true });

  const server = createServer((req, res) => {
    handle(req, res, work).catch((e) => {
      const msg = e instanceof CwiError ? `${e.message}\n${(e as CwiError).hint ?? ''}` : String(e?.message ?? e);
      json(res, 500, { error: msg.trim() });
    });
  });

  const port = opts.port ?? 4600;
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = (server.address() as { port: number }).port;

  return {
    url: `http://${host}:${actual}/`,
    port: actual,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, work: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(studioHtml());
    return;
  }

  // The renderer and core, served from the installed packages so the page has
  // no build step and no bundler.
  if (path.startsWith('/vendor/core/')) {
    streamFile(req, res, join(distOf('@corerus/chorus-core'), path.slice('/vendor/core/'.length)));
    return;
  }
  if (path.startsWith('/vendor/web/')) {
    streamFile(req, res, join(distOf('@corerus/chorus-web'), path.slice('/vendor/web/'.length)));
    return;
  }

  if (path === '/api/environment') {
    const env = await checkPipelineEnv();
    json(res, 200, {
      ok: env.ok,
      detail: env.detail,
      // Stated plainly in the UI rather than discovered at the moment of
      // failure: without ASR the app needs a subtitle file, and that changes
      // what the operator has to bring.
      asr: await asrAvailable(),
    });
    return;
  }

  if (path === '/api/plan') {
    // Billing belongs to the hosted service, not to a local install. The local
    // app has no plan and no limits, and says so with a 404 rather than
    // inventing a "free tier" that would imply this one has a ceiling.
    if (!process.env.CHORUS_PLAN) { res.writeHead(404).end('{}'); return; }
    json(res, 200, {
      plan: { id: process.env.CHORUS_PLAN, label: process.env.CHORUS_PLAN_LABEL ?? 'Plan',
              includedMinutes: Number(process.env.CHORUS_PLAN_MINUTES ?? 0) },
      minutesUsed: Number(process.env.CHORUS_MINUTES_USED ?? 0),
      upgradeUrl: process.env.CHORUS_UPGRADE_URL,
    });
    return;
  }

  if (path === '/api/upload' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name') ?? 'video.mp4');
    const id = `job${jobs.size + 1}-${Date.now().toString(36)}`;
    const dir = join(work, id);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, name);
    await saveBody(req, dest);
    jobs.set(id, { id, stage: 'uploaded', message: `${name} received`, media: dest });
    json(res, 200, { id, name, size: statSync(dest).size });
    return;
  }

  if (path === '/api/subtitles' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? '';
    const job = jobs.get(id);
    if (!job) throw new CwiError('No such job.');
    const dir = join(work, id);
    const dest = join(dir, safeName(url.searchParams.get('name') ?? 'subs.srt'));
    await saveBody(req, dest);
    // Parse now so a bad file is rejected while the operator is still looking
    // at the file picker, not three minutes into an analysis.
    const entries = readSubtitles(dest);
    json(res, 200, { entries: entries.length, first: entries[0]?.text.slice(0, 80) ?? '', path: dest });
    return;
  }

  if (path === '/api/analyze' && req.method === 'POST') {
    const body = await readJson(req);
    const job = jobs.get(String(body.id));
    if (!job?.media) throw new CwiError('No such job, or it has no media.');
    job.stage = 'analyzing';
    job.message = 'reading the soundtrack';
    json(res, 200, { ok: true });
    // Analysis is minutes on a feature; the page polls /api/job.
    void analyze(job, work, body).catch((e) => {
      job.stage = 'failed';
      job.error = e instanceof CwiError ? e.message : String(e?.message ?? e);
    });
    return;
  }

  if (path === '/api/job') {
    const job = jobs.get(url.searchParams.get('id') ?? '');
    if (!job) throw new CwiError('No such job.');
    json(res, 200, {
      stage: job.stage, message: job.message, progress: job.progress,
      error: job.error, manifest: job.manifest, stages: job.stages, open: job.open,
      output: job.output ? basename(job.output) : undefined,
    });
    return;
  }

  if (path === '/api/manifest' && req.method === 'POST') {
    // The page owns the manifest once analysis is done — renaming a character,
    // recolouring, switching profile — and posts it back before export.
    const body = await readJson(req);
    const job = jobs.get(String(body.id));
    if (!job) throw new CwiError('No such job.');
    job.manifest = body.manifest as CwiManifest;
    writeFileSync(job.manifestPath!, JSON.stringify(job.manifest, null, 2));
    json(res, 200, { ok: true });
    return;
  }

  if (path === '/api/cast' && req.method === 'POST') {
    // Renaming a speaker is the one correction that is always worth making by
    // hand: no amount of acoustic cleverness knows that Speaker 2 is the
    // interviewer, and a person watching the video knows instantly.
    const body = await readJson(req);
    const job = jobs.get(String(body.id));
    if (!job?.manifest || !job.manifestPath) throw new CwiError('No analysed job to edit.');
    const edits = body.characters as Array<{ id: string; name?: string }>;
    if (!Array.isArray(edits)) throw new CwiError('Expected a characters array.');

    const byId = new Map(edits.map((c) => [c.id, c]));
    job.manifest.characters = job.manifest.characters.map((c) => {
      const e = byId.get(c.id);
      return e?.name ? { ...c, name: e.name } : c;
    });
    writeFileSync(job.manifestPath, JSON.stringify(job.manifest, null, 2));
    json(res, 200, { characters: job.manifest.characters });
    return;
  }

  if (path === '/api/export' && req.method === 'POST') {
    const body = await readJson(req);
    const job = jobs.get(String(body.id));
    if (!job?.manifest || !job.media) throw new CwiError('Nothing to export yet.');
    job.stage = 'rendering';
    job.message = 'rendering';
    job.progress = 0;
    json(res, 200, { ok: true });
    void exportVideo(job, Boolean(body.alpha)).catch((e) => {
      job.stage = 'failed';
      job.error = e instanceof CwiError ? e.message : String(e?.message ?? e);
    });
    return;
  }

  if (path.startsWith('/media/')) {
    const job = jobs.get(path.slice('/media/'.length));
    if (!job?.media) { res.writeHead(404).end(); return; }
    streamFile(req, res, job.media);
    return;
  }

  if (path.startsWith('/download/')) {
    const job = jobs.get(path.slice('/download/'.length));
    if (!job?.output || !existsSync(job.output)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${basename(job.output)}"`,
      'Content-Length': String(statSync(job.output).size),
    });
    createReadStream(job.output).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
}

async function analyze(job: Job, work: string, body: Record<string, unknown>): Promise<void> {
  const dir = join(work, job.id);
  const out = join(dir, 'captions.cwi.json');
  const subtitles = body.subtitles ? String(body.subtitles) : undefined;

  if (!subtitles && !body.asr) {
    throw new CwiError(
      'Captions need the words, and there is no transcript.',
      'Add a subtitle file, or install faster-whisper to transcribe here.');
  }

  // The same team the CLI runs, so the page shows the real verdicts rather
  // than a spinner and a guess. Every stage that can refuse still refuses.
  job.stages = [];
  const r = await runTeam({
    media: job.media!,
    subtitles,
    asr: !subtitles,
    diarize: Boolean(body.diarize),
    profile: String(body.profile ?? 'chorus-1.0'),
    out,
    onStage: (s) => {
      job.stages!.push(s);
      job.message = `${s.stage}: ${s.summary}`;
    },
  });

  job.open = r.open;
  if (!r.ok) {
    const stopped = r.reports.find((s) => s.verdict === 'stop');
    throw new CwiError(stopped?.summary ?? 'the team stopped', stopped?.advice);
  }

  job.manifest = JSON.parse(readFileSync(out, 'utf8')) as CwiManifest;
  job.manifestPath = out;
  job.stage = 'ready';
  job.message = `${job.manifest.cues.length} cues, ${job.manifest.characters.length} speakers`;
}

/**
 * SRT in, VTT out.
 *
 * analyze.py speaks WebVTT and the world ships SRT. Converting here rather than
 * teaching the pipeline a second format keeps one parser authoritative.
 */
async function srtToVtt(path: string, dir: string): Promise<string> {
  const entries = readSubtitles(path);
  const stamp = (t: number) => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  };
  const vtt = 'WEBVTT\n\n' + entries
    .map((e) => `${stamp(e.start)} --> ${stamp(e.end)}\n${e.text}`)
    .join('\n\n') + '\n';
  const out = join(dir, 'subtitles.vtt');
  writeFileSync(out, vtt);
  return out;
}

async function exportVideo(job: Job, alpha: boolean): Promise<void> {
  const dir = join(job.manifestPath!, '..');
  const out = join(dir, alpha ? 'captions-overlay.mov' : 'captioned.mp4');
  const r = await render({
    manifest: job.manifestPath!,
    video: alpha ? undefined : job.media,
    out,
    ...(alpha ? { alpha: 'prores4444' as const } : {}),
    onProgress: (done, total) => {
      job.progress = total ? done / total : 0;
      job.message = `rendering frame ${done} of ${total}`;
    },
  });
  job.output = r.out ?? out;
  job.stage = 'done';
  job.message = 'ready to download';
  job.progress = 1;
}

// --- plumbing ---------------------------------------------------------------

/** Which speech recognition, if any, is installed. */
async function asrAvailable(): Promise<'whisperx' | 'faster-whisper' | null> {
  try {
    const env = await checkPipelineEnv();
    if (!env.ok) return null;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { findPython } = await import('./ops.js');
    const run = promisify(execFile);
    for (const [mod, name] of [['whisperx', 'whisperx'], ['faster_whisper', 'faster-whisper']] as const) {
      try {
        await run(findPython(), ['-c', `import ${mod}`]);
        return name as 'whisperx' | 'faster-whisper';
      } catch { /* try the next one */ }
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip anything that could escape the job directory. */
function safeName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ]+/g, '_');
  return base || 'file';
}

function saveBody(req: IncomingMessage, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(dest);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        reject(new CwiError(`That file is over ${Math.round(MAX_UPLOAD / 1e9)} GB.`,
          'Trim the section you are captioning, or point the CLI at it directly.'));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CwiError('Malformed request body.');
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(text);
}

/** Range requests, so the preview can scrub without downloading the whole file. */
function streamFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404).end(); return; }
  const size = statSync(path).size;
  const ext = extname(path);
  const type = ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.map' ? 'application/json'
    : ext === '.webm' ? 'video/webm' : 'video/mp4';
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' });
    createReadStream(path).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
  });
  createReadStream(path, { start, end }).pipe(res);
}

export { jobs as _jobs };
