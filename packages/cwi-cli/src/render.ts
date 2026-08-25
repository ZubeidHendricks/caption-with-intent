/**
 * Burn Caption with Intention captions into a video.
 *
 * Why this exists: no deployed caption decoder can carry CWI. Nothing in
 * WebVTT, SRT, CEA-608/708 or IMSC1/TTML2 expresses per-word colour transitions
 * plus variable-font axis animation, and no platform's caption renderer —
 * YouTube's included — can display it. Spec 3.2 says so itself and prescribes
 * burned-in open captions until decoders catch up. So this is not a convenience
 * export; for now it is the *only* faithful delivery path.
 *
 * Captions are captured offscreen from the same renderer the preview uses, at
 * the source's exact pixel dimensions, on transparent frames, then composited
 * with ffmpeg. One implementation drives both preview and master, so what you
 * reviewed is what ships.
 *
 * ASS/libass is the usual burn-in route and cannot do this: it has no
 * variable-font axis support, so the entire intonation layer is lost.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CwiError, readManifest } from './ops.js';
import { startPreview, type PreviewHandle } from './preview.js';

const run = promisify(execFile);

export interface Preset {
  label: string;
  crf: number;
  preset: string;
  pixFmt: string;
  extra: string[];
  note: string;
}

/**
 * Delivery presets.
 *
 * These change encoding, not caption design — the spec's geometry is relative
 * to frame height, so captions scale correctly at any resolution without
 * per-target tuning.
 */
export const PRESETS: Record<string, Preset> = {
  web: {
    label: 'Web / general',
    crf: 20, preset: 'medium', pixFmt: 'yuv420p',
    extra: ['-movflags', '+faststart'],
    note: 'H.264 High, faststart for progressive download.',
  },
  youtube: {
    label: 'YouTube',
    // YouTube re-encodes everything, so the upload wants to be visibly
    // over-quality; artefacts here are permanent, theirs are not.
    crf: 16, preset: 'slow', pixFmt: 'yuv420p',
    extra: ['-movflags', '+faststart', '-g', '15', '-bf', '2', '-colorspace', 'bt709',
            '-color_primaries', 'bt709', '-color_trc', 'bt709'],
    note: 'High-bitrate bt709 master. YouTube transcodes on ingest, so upload above target quality.',
  },
  cinema: {
    label: 'Cinema / DCP source master',
    // Not a DCP — a DCP needs JPEG2000 in MXF, XYZ colour and usually a KDM.
    // This is the picture master a DCP house ingests, kept visually lossless so
    // the J2K encode is the only generation loss.
    crf: 8, preset: 'slow', pixFmt: 'yuv420p',
    extra: ['-profile:v', 'high', '-level', '5.1'],
    note: 'Near-lossless master for DCP creation (DCP-o-matic / OpenDCP). Not itself a DCP.',
  },
  prores: {
    label: 'ProRes 422 HQ (editorial)',
    crf: 0, preset: '', pixFmt: 'yuv422p10le',
    extra: ['-c:v', 'prores_ks', '-profile:v', '3'],
    note: 'For handing back into an NLE. Large files.',
  },
};

export interface RenderOptions {
  manifest: string;
  video?: string;
  out: string;
  preset?: keyof typeof PRESETS | string;
  fps?: number;
  width?: number;
  height?: number;
  /** Render only this many seconds — for checking a look before committing. */
  duration?: number;
  from?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  out: string;
  frames: number;
  captured: number;
  skipped: number;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  preset: string;
}

interface Probe { width: number; height: number; fps: number; duration: number; hasAudio: boolean }

async function probe(path: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
    path,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'video');
  if (!v) throw new CwiError(`${path} has no video stream.`);
  const [n, d] = String(v.r_frame_rate ?? '25/1').split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: d ? n / d : 25,
    duration: Number(j.format?.duration ?? 0),
    hasAudio: (j.streams ?? []).some((s: { codec_type: string }) => s.codec_type === 'audio'),
  };
}

/** playwright-core is optional: only `render` needs a browser. */
async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new CwiError(
      'Rendering needs a headless browser, and playwright-core is not installed.',
      'npm install playwright-core   (then `npx playwright install chromium` if no Chrome is present)',
    );
  }
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    const exe = process.env.CWI_CHROME;
    if (exe) return await chromium.launch({ headless: true, executablePath: exe });
    throw new CwiError(
      `Could not launch a browser: ${(e as Error).message.split('\n')[0]}`,
      'Run `npx playwright install chromium`, or set CWI_CHROME to a Chrome/Chromium binary.',
    );
  }
}

/**
 * Runs inside the page, so it must not close over anything from this module.
 * Typed loosely because this file compiles without the DOM lib.
 */
const seekInPage = (t: number) => {
  (globalThis as unknown as { __cwiSeek: (n: number) => void }).__cwiSeek(t);
};

/** Frame windows where at least one cue is on screen. Everything else is blank. */
export function activeWindows(cues: Array<{ start: number; end: number }>): Array<[number, number]> {
  const sorted = [...cues].map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([...w]);
  }
  return out;
}

export async function render(opts: RenderOptions): Promise<RenderResult> {
  const manifestPath = resolve(opts.manifest);
  const manifest = readManifest(manifestPath);
  const videoPath = opts.video ? resolve(opts.video) : undefined;
  if (videoPath && !existsSync(videoPath)) throw new CwiError(`No such video: ${videoPath}`);

  const presetName = String(opts.preset ?? 'web');
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new CwiError(`Unknown preset "${presetName}".`, `Available: ${Object.keys(PRESETS).join(', ')}`);
  }

  const src = videoPath ? await probe(videoPath) : null;
  const width = opts.width ?? src?.width ?? 1920;
  const height = opts.height ?? src?.height ?? 1080;
  const fps = opts.fps ?? src?.fps ?? 25;
  const manifestEnd = Math.max(...manifest.cues.map((c) => c.end), 0);
  const from = opts.from ?? 0;
  const seconds = opts.duration ?? Math.max((src?.duration ?? manifestEnd) - from, 0);
  const total = Math.max(1, Math.round(seconds * fps));

  // Odd dimensions break yuv420p; nothing downstream reports this usefully.
  if (width % 2 || height % 2) {
    throw new CwiError(`Frame size ${width}x${height} has an odd dimension.`,
      'H.264 with yuv420p needs even width and height. Pass --width/--height.');
  }

  let preview: PreviewHandle | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;

  try {
    preview = await startPreview({ manifest: manifestPath, port: 0, inspector: false });
    browser = await launchBrowser();
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.goto(`${preview.url}render?w=${width}&h=${height}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__cwiReady === true', null, { timeout: 30000 });

    const windows = activeWindows(manifest.cues);
    const isActive = (t: number) => windows.some(([a, b]) => t >= a && t <= b);

    const ff = spawnFfmpeg({ videoPath, out: resolve(opts.out), width, height, fps, preset, from, seconds, hasAudio: !!src?.hasAudio });

    let blank: Buffer | undefined;
    let captured = 0;
    let skipped = 0;

    for (let i = 0; i < total; i++) {
      const t = from + i / fps;
      let png: Buffer;
      if (isActive(t)) {
        await page.evaluate(seekInPage, t);
        png = await page.screenshot({ omitBackground: true });
        captured++;
      } else {
        // Nothing on screen: reuse one transparent frame rather than paying for
        // a screenshot. On typical dialogue this is a large share of the film.
        if (!blank) {
          await page.evaluate(seekInPage, -1);
          blank = await page.screenshot({ omitBackground: true });
        }
        png = blank!;
        skipped++;
      }
      if (!ff.stdin.write(png)) {
        await new Promise<void>((r) => ff.stdin.once('drain', () => r()));
      }
      opts.onProgress?.(i + 1, total);
    }

    ff.stdin.end();
    await ff.done;

    return { out: resolve(opts.out), frames: total, captured, skipped, width, height, fps, seconds, preset: presetName };
  } finally {
    await browser?.close().catch(() => {});
    await preview?.close().catch(() => {});
  }
}

function spawnFfmpeg(a: {
  videoPath?: string; out: string; width: number; height: number; fps: number;
  preset: Preset; from: number; seconds: number; hasAudio: boolean;
}) {
  const args: string[] = ['-y', '-loglevel', 'error'];

  if (a.videoPath) {
    if (a.from) args.push('-ss', String(a.from));
    args.push('-t', String(a.seconds), '-i', a.videoPath);
  } else {
    args.push('-f', 'lavfi', '-t', String(a.seconds), '-i', `color=c=black:s=${a.width}x${a.height}:r=${a.fps}`);
  }

  args.push('-f', 'image2pipe', '-framerate', String(a.fps), '-i', '-');

  // Scale the source to the caption frame size if it differs, then overlay.
  args.push('-filter_complex',
    `[0:v]scale=${a.width}:${a.height}:flags=lanczos,fps=${a.fps}[base];` +
    `[base][1:v]overlay=0:0:format=auto,format=${a.preset.pixFmt}[v]`);
  args.push('-map', '[v]');

  if (a.videoPath && a.hasAudio) args.push('-map', '0:a', '-c:a', 'aac', '-b:a', '192k');

  if (a.preset.extra.includes('-c:v')) {
    args.push(...a.preset.extra);
  } else {
    args.push('-c:v', 'libx264', '-crf', String(a.preset.crf), '-preset', a.preset.preset, ...a.preset.extra);
  }
  args.push(a.out);

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const done = new Promise<void>((res, rej) => {
    proc.on('error', (e) => rej(new CwiError(`ffmpeg failed to start: ${e.message}`, 'Is ffmpeg on PATH?')));
    proc.on('close', (code) => {
      if (code === 0) res();
      else rej(new CwiError(`ffmpeg exited ${code}:\n${stderr.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
  // A broken pipe here means ffmpeg already died; its stderr is the real error.
  proc.stdin.on('error', () => {});
  return { stdin: proc.stdin, done };
}
