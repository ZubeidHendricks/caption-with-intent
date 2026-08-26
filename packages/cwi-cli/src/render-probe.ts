/**
 * Produce a render report from the web renderer.
 *
 * This is one adapter, not the contract. Anything that can draw a `.cwi`
 * manifest can emit the report in `render-conform.ts` and be checked the same
 * way — the point of the report format is that the checker never has to know
 * what drew the picture. This adapter exists so the reference renderer is held
 * to the same bar as everyone else's, in CI, on every commit.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreview } from './preview.js';
import { CwiError } from './ops.js';
import type { RenderReport, RenderScene, ReportSample } from './render-conform.js';

/** Long enough for the renderer's 60ms colour transition to finish. */
const SETTLE_MS = 150;

export interface ProbeOptions {
  scene: RenderScene;
  /** Label recorded in the report. */
  implementation?: string;
}

export async function probeWebRenderer({ scene, implementation = 'cwi-web' }: ProbeOptions): Promise<RenderReport> {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    // playwright enforces its floor with process.exit rather than a throw, so
    // this has to be caught before the import or the process dies here.
    throw new CwiError(`Probing the web renderer needs Node 20 or newer; this is Node ${process.versions.node}.`,
      'Run the render conformance check on a newer Node, or supply a report from your own implementation.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'cwi-probe-'));
  const manifestPath = join(dir, `${scene.id}.cwi.json`);
  writeFileSync(manifestPath, JSON.stringify(scene.manifest));

  const preview = await startPreview({ manifest: manifestPath, port: 0, inspector: false });
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: scene.frame.w, height: scene.frame.h } });
    await page.goto(`${preview.url}render?w=${scene.frame.w}&h=${scene.frame.h}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__cwiReady === true', null, { timeout: 45000 });

    if (!(await page.evaluate(() => (globalThis as unknown as { __cwiFontsLoaded: boolean }).__cwiFontsLoaded))) {
      // Every size and axis reading would be taken from a substitute face, so
      // the report would describe a picture nobody will ever see.
      throw new CwiError('Roboto Flex did not load in the probe browser.',
        'Type size and the variable axes would be measured in a fallback face, so the report would be meaningless.');
    }

    const samples: ReportSample[] = [];
    for (const t of scene.samples) {
      await page.evaluate((n: number) =>
        (globalThis as unknown as { __cwiSeek: (x: number) => void }).__cwiSeek(n), t);
      // The colour turn is a CSS transition, so reading computed style in the
      // same tick catches every just-spoken word mid-fade and reports it as
      // still neutral. The pop is derived from the seek time rather than the
      // wall clock, so waiting here does not move anything else.
      await page.waitForTimeout(SETTLE_MS);
      samples.push(await page.evaluate(sampleAt, t) as ReportSample);
    }
    return { cwiRenderReport: '1.0', implementation, scene: scene.id, frame: scene.frame, samples };
  } finally {
    await browser?.close().catch(() => {});
    await preview.close().catch(() => {});
  }
}

/**
 * Runs in the page, after the seek has settled. Reads back what the renderer
 * laid out, in the terms the report format asks for — layout positions rather
 * than bounding rects, since a popped token's rect legitimately moves while
 * its layout box must not.
 */
/* c8 ignore start -- executes in the browser, not under the node coverage run */
function sampleAt(t: number): unknown {
  // This package targets Node and has no DOM lib, so the page's globals are
  // reached through one loosely-typed handle rather than a dozen casts.
  const g = globalThis as unknown as Record<string, any>;
  const style = (el: any) => g.getComputedStyle(el);

  const axis = (el: any, name: string): number | undefined => {
    const settings: string = style(el).fontVariationSettings ?? '';
    const m = settings.match(new RegExp(`"${name}"\\s+([\\d.]+)`));
    return m ? Number(m[1]) : undefined;
  };

  const all: any[] = [...g.document.querySelectorAll('.cwi-tok')];
  const marks = all.filter((e) => e.classList.contains('cwi-glyph'));
  const tokens = all.filter((e) => !e.classList.contains('cwi-glyph'));
  const lines: any[] = [...g.document.querySelectorAll('.cwi-line')];

  let box;
  if (lines.length) {
    const rects = lines.map((l) => l.getBoundingClientRect());
    const left = Math.min(...rects.map((r: any) => r.left));
    const top = Math.min(...rects.map((r: any) => r.top));
    box = {
      left,
      top,
      width: Math.max(...rects.map((r: any) => r.right)) - left,
      height: Math.max(...rects.map((r: any) => r.bottom)) - top,
    };
  }

  return {
    t,
    tokens: tokens.map((el) => ({
      text: el.textContent ?? '',
      spoken: el.classList.contains('cwi-tok--spoken'),
      sizePx: parseFloat(style(el).fontSize),
      colour: style(el).color,
      wght: axis(el, 'wght'),
      wdth: axis(el, 'wdth'),
      // Layout positions, not bounding rects: the pop is a transform, and a
      // transform must not be allowed to look like a reflow or to hide one.
      leftPx: el.offsetLeft,
      topPx: el.offsetTop,
    })),
    marks: marks.map((el) => el.textContent ?? ''),
    lineCount: lines.length,
    box,
  };
}
/* c8 ignore stop */
