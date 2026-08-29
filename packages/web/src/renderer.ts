import {
  withDefaults, resolveToken, wordGap, needsWordGap, linesFor, directionFor, languagesOf,
  type CwiManifest, type CwiOptions, type Cue, type Token, type Character,
} from '@corerus/chorus-core';
import { injectStyle } from './style.js';

export interface RendererOptions extends Partial<CwiOptions> {
  /**
   * Frame box the captions are laid out against. When bound to a media element
   * this is computed from the element's rendered content box (letterboxing
   * excluded), because the spec measures type size as a percentage of *frame*
   * height, not element height.
   */
  frame?: { width: number; height: number };
  /** Render into a shadow root instead of the host document. */
  shadow?: boolean;
}

interface TokenView {
  el: HTMLElement;
  token: Token;
  spoken: boolean;
  /** Last applied pop scale, so we only touch style when it actually changes. */
  scale: number;
}

/**
 * Pop shape: rise to the peak at 45% of the duration, then settle.
 *
 * Mirrors the previous CSS keyframes (0% → 45% peak → 100%) with a slight
 * overshoot on the rise, so the motion reads as a flick toward the live word
 * rather than a symmetrical throb.
 */
function popCurve(p: number): number {
  const PEAK = 0.45;
  if (p <= PEAK) {
    const x = p / PEAK;
    return 1 - Math.pow(1 - x, 3);            // ease-out cubic
  }
  const x = (p - PEAK) / (1 - PEAK);
  return 1 - (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);  // ease-in-out cubic
}

interface CueView {
  cue: Cue;
  root: HTMLElement;
  tokens: TokenView[];
  /** Whether the fit-to-width pass has run. It needs the element in the DOM. */
  fitted?: boolean;
}

/**
 * Reference renderer for the Caption with Intention design system.
 *
 * Two things it does that a naive implementation gets wrong:
 *
 *  1. Each word is laid out once, at the size/weight/width its measured
 *     acoustics imply. The read-ahead white line therefore already occupies its
 *     final geometry, and the 15% onset pop is a pure `transform` — so nothing
 *     reflows mid-line. The spec does not address this conflict.
 *
 *  2. Type size is resolved against the *video frame*, not the DOM element, so
 *     letterboxed and pillarboxed playback still yields the spec's 5% baseline.
 */
export class CwiRenderer {
  readonly el: HTMLElement;
  private opts: CwiOptions;
  private manifest: CwiManifest | null = null;
  /** Subtitle language currently drawn. Undefined means the manifest's own. */
  private language: string | undefined;
  private chars = new Map<string, Character>();
  private active = new Map<Cue, CueView>();
  private stack: HTMLElement;
  private media: HTMLMediaElement | null = null;
  private frameSource: HTMLMediaElement | null = null;
  private raf = 0;
  private frame: { width: number; height: number };
  private ro: ResizeObserver | null = null;
  private lastTime = -1;
  private reducedMotion = false;

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.opts = withDefaults(options);
    this.frame = options.frame ?? { width: container.clientWidth, height: container.clientHeight };

    const host = document.createElement('div');
    host.className = 'cwi-root';
    this.stack = document.createElement('div');
    this.stack.className = 'cwi-stack';
    host.appendChild(this.stack);

    if (options.shadow) {
      const sr = container.attachShadow({ mode: 'open' });
      injectStyle(sr);
      sr.appendChild(host);
    } else {
      injectStyle(document);
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(host);
    }
    this.el = host;
    // Honour the viewer's motion preference. Offscreen rendering has no such
    // preference, so a burned-in master always carries the motion.
    this.reducedMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.applyLayoutVars();
  }

  load(manifest: CwiManifest): void {
    this.manifest = manifest;
    this.opts = withDefaults({ ...manifest.options, ...this.opts });
    this.chars = new Map(manifest.characters.map((c) => [c.id, c]));
    // Base writing direction. Left-to-right layout of a right-to-left script
    // runs the word reveal backwards through the line, which is worse than not
    // revealing at all. Position classes stay literal: position is a spatial
    // attribution cue and should not mirror with the text.
    this.el.dir = manifest.meta?.direction ?? 'ltr';
    if (this.language && !languagesOf(manifest).includes(this.language)) this.language = undefined;
    this.clear();
  }

  /**
   * Subtitle languages this manifest can draw, the original first.
   *
   * A player builds its language menu from this. It is derived from the cues
   * rather than trusted from metadata, so a language that is declared but not
   * actually present never appears in a menu as a dead option.
   */
  languages(): string[] {
    return this.manifest ? languagesOf(this.manifest) : [];
  }

  /** The language currently drawn. */
  get subtitleLanguage(): string | undefined {
    return this.language;
  }

  /**
   * Switch subtitle language, live.
   *
   * Rebuilds only what is on screen and re-seeks to the same instant, so a
   * viewer changing language mid-sentence sees the same moment in the new
   * language rather than a blank frame or a restarted cue. Cheap because the
   * timing and acoustics are shared: this swaps text and re-lays out at most
   * two cues.
   *
   * Passing a language the manifest does not carry falls back to the original
   * rather than throwing — a player should not be able to crash a film by
   * offering a stale menu entry.
   */
  setLanguage(lang: string | undefined): void {
    const next = lang && this.languages().includes(lang) ? lang : undefined;
    if (next === this.language) return;
    this.language = next;
    if (!this.manifest) return;
    // Drop every built cue: their tokens are the old language's.
    for (const [, view] of this.active) view.root.remove();
    this.active.clear();
    this.seek(this.lastTime);
  }

  /**
   * Track a media element's rendered frame box for sizing, without taking its
   * clock. Use this when the host app owns the timebase (an NLE playhead, a
   * scrubbing preview, a compositor) and calls `seek()` itself.
   */
  observe(media: HTMLMediaElement): void {
    this.frameSource = media;
    this.measureFrame();
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.measureFrame());
    this.ro.observe(media);
  }

  /** Observe the element AND drive playback from its clock. */
  bind(media: HTMLMediaElement): void {
    this.observe(media);
    this.media = media;
    this.start();
  }

  start(): void {
    if (this.raf) return;
    const tick = () => {
      const t = this.media ? this.media.currentTime : this.lastTime;
      this.seek(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Render the state at time `t` (seconds). Idempotent and cheap to call per frame. */
  seek(t: number): void {
    if (!this.manifest) return;
    const rewound = t < this.lastTime - 0.05;
    this.lastTime = t;

    // Retire cues that have left the window.
    for (const [cue, view] of this.active) {
      if (t < cue.start || t > cue.end) {
        view.root.remove();
        this.active.delete(cue);
      }
    }
    // Admit cues that have entered it.
    for (const cue of this.manifest.cues) {
      if (t >= cue.start && t <= cue.end && !this.active.has(cue)) {
        this.active.set(cue, this.buildCue(cue));
      }
    }
    // Reorder to manifest order so simultaneous speakers stay stable on screen.
    const ordered = [...this.active.values()].sort((a, b) => a.cue.start - b.cue.start);
    ordered.forEach((v, i) => {
      if (this.stack.children[i] !== v.root) this.stack.insertBefore(v.root, this.stack.children[i] ?? null);
    });


    // Per-token state.
    void rewound;
    for (const view of this.active.values()) {
      for (const tv of view.tokens) {
        const spoken = t >= tv.token.start;
        if (spoken !== tv.spoken) {
          tv.spoken = spoken;
          tv.el.classList.toggle('cwi-tok--spoken', spoken);
        }
        this.applyPop(tv, t);
      }
    }

    // Fit last, and only once the cue is in the document.
    //
    // Two orderings matter here and both were learned the hard way. Measuring
    // in buildCue reads scrollWidth off a detached element, which is always 0,
    // so nothing was ever found to be too wide. And fitting *before* the state
    // loop forces a style flush between inserting a cue and setting its spoken
    // classes — which turns the 60ms colour transition into a real animation
    // that had never run before, so a word read as white for a frame after its
    // own onset. Reading geometry has side effects; do it after the frame's
    // state is settled.
    for (const v of ordered) {
      if (!v.fitted) {
        this.fitToFrame(v.root);
        v.fitted = true;
      }
    }
  }

  /**
   * Spec 2.2.3 — 15% scale-up on word onset, guiding the eye to the live word.
   *
   * Computed from the seek time rather than run as a CSS animation. A CSS
   * animation plays on wall-clock, which means it is wrong in every case where
   * the clock is not simply running forward at 1x: scrubbing backwards, pausing
   * mid-pop, and — the one that matters most — offscreen frame-by-frame
   * rendering, where every captured frame would show the pop at whatever phase
   * the render loop happened to catch. Deriving it from `t` makes the renderer
   * a pure function of time, so a preview and a burned-in master agree frame
   * for frame.
   */
  private applyPop(tv: TokenView, t: number): void {
    const o = this.opts;
    const age = t - tv.token.start;
    let scale = 1;
    if (!this.reducedMotion && age >= 0 && age < o.popDurationSec && o.popScale > 0) {
      scale = 1 + o.popScale * popCurve(age / o.popDurationSec);
    }
    // Writing the same value every frame still dirties style; skip when equal.
    if (Math.abs(scale - tv.scale) > 0.0005) {
      tv.scale = scale;
      tv.el.style.transform = scale === 1 ? '' : `scale(${scale.toFixed(4)})`;
    }
  }

  private buildCue(cue: Cue): CueView {
    const o = this.opts;
    const root = document.createElement('div');
    root.className = 'cwi-cue';
    // Direction is per cue, not per manifest: an English film with Arabic
    // subtitles is an RTL track on an LTR manifest, and the reveal has to run
    // the way the chosen language reads.
    root.dir = directionFor(this.manifest!, cue, this.language);
    const speaker = cue.speaker ? this.chars.get(cue.speaker) : undefined;

    // Horizontal placement carries speaker identity without colour. Profiles
    // that do not use it leave `position` unset and everything stays centred.
    if (speaker?.position && speaker.position !== 'center') {
      root.classList.add(`cwi-cue--${speaker.position}`);
    }

    // Spec 2.4.4 / 2.4.5: sound effects and music are always white.
    const color = cue.kind === 'dialogue' && !o.monochrome && speaker?.color
      ? speaker.color : '#FFFFFF';
    root.style.setProperty('--cwi-speaker', color);

    // Spec 2.1.5: off-camera speech is obliqued.
    if (cue.onCamera === false) root.classList.add('cwi-root--offcam');
    root.style.setProperty('--cwi-slnt', String(o.offCameraSlant));

    const tokens: TokenView[] = [];
    const lines = linesFor(this.manifest!, cue, this.language).slice(0, o.maxLines);
    // A per-character mark, where the profile escalated to one. Rendered in the
    // speaker's colour but distinguishable by shape, so it works when the
    // colour does not.
    const glyph = cue.kind === 'dialogue' ? speaker?.glyph : undefined;

    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'cwi-line';
      // Spec 2.4.1 exception: sudden loud speech may break out of the box.
      if (!cue.breakout) lineEl.classList.add('cwi-line--boxed');

      const maxSize = Math.max(...line.tokens.map((t) => resolveToken(t, o).size), o.baselineSizePct);
      lineEl.style.padding = `${maxSize * 0.14}px ${maxSize * 0.3}px`;

      if (glyph && line === lines[0]) {
        const g = document.createElement('span');
        g.className = 'cwi-tok cwi-tok--spoken cwi-glyph';
        g.textContent = glyph;
        g.style.fontSize = `${(o.baselineSizePct / 100) * this.frame.height * 0.62}px`;
        lineEl.appendChild(g);
        const sp = document.createElement('span');
        sp.className = 'cwi-sp';
        sp.textContent = '\u00A0';
        sp.style.fontSize = g.style.fontSize;
        lineEl.appendChild(sp);
      }
      line.tokens.forEach((token, i) => {
        const st = resolveToken(token, o);
        const el = document.createElement('span');
        el.className = 'cwi-tok';
        el.textContent = cue.kind === 'music' ? token.text : token.text;
        // Type size as a percentage of FRAME height (spec 2.3.4).
        el.style.fontSize = `${(st.size / 100) * this.frame.height}px`;
        el.style.setProperty('--cwi-axes', `'wght' ${st.wght}, 'wdth' ${st.wdth}`);
        el.style.fontVariationSettings = cue.onCamera === false
          ? `'wght' ${st.wght}, 'wdth' ${st.wdth}, 'slnt' ${o.offCameraSlant}`
          : `'wght' ${st.wght}, 'wdth' ${st.wdth}`;

        // Spec 2.4.5: music descriptors are static — no colour change, no pop.
        if (cue.kind === 'music') {
          el.classList.add('cwi-tok--spoken');
          el.style.color = '#FFFFFF';
        }
        lineEl.appendChild(el);
        // No gap between two unspaced-script characters: they are segmented per
        // character so synchronisation survives, and gapping them would render
        // the line as spaced-out glyphs.
        if (i < line.tokens.length - 1 && needsWordGap(token.text, line.tokens[i + 1].text)) {
          const next = resolveToken(line.tokens[i + 1], o);
          const sp = document.createElement('span');
          sp.className = 'cwi-sp';
          // Non-breaking space: a plain space is still collapsible at line edges.
          sp.textContent = ' ';
          // Word gap comes from core (see `wordGap`) so every renderer backend
          // spaces identically. Set as an explicit width rather than relying on
          // the font's space advance, which is calibrated for regular weight.
          const gapPct = wordGap(st, next, o, cue.onCamera === false);
          const gapPx = (gapPct / 100) * this.frame.height;
          sp.style.fontSize = `${(Math.min(st.size, next.size) / 100) * this.frame.height}px`;
          sp.style.width = `${gapPx}px`;
          lineEl.appendChild(sp);
        }
        if (cue.kind !== 'music') tokens.push({ el, token, spoken: false, scale: 1 });
      });
      root.appendChild(lineEl);
    }
    const drawn = linesFor(this.manifest!, cue, this.language);
    if (drawn.length > o.maxLines) {
      console.warn(`[cwi] cue ${cue.id ?? cue.start} has ${drawn.length} lines; spec 2.4.2 allows ${o.maxLines}. Extra lines dropped.`);
    }
    return { cue, root, tokens };
  }

  /**
   * Shrink a cue that is wider than the picture.
   *
   * Type size is a percentage of frame *height* (spec 2.3.4), which silently
   * assumes a landscape frame. On a portrait video the frame is tall and
   * narrow, so 5% of height is enormous next to the available width, and a
   * line set `nowrap` runs off the side of the picture and is simply not
   * readable. Vertical video is most of what gets captioned now, so this is
   * not an edge case.
   *
   * The whole cue is scaled by one factor rather than re-sizing words
   * individually. The volume mapping is *relative* — a shout is larger than
   * the speech around it — and a uniform scale preserves every one of those
   * relationships while making the line fit. Re-fitting word by word would
   * flatten exactly the differences the design exists to show.
   *
   * A line that does not overflow is untouched, so nothing changes for the
   * landscape material the spec was written against.
   */
  private fitToFrame(root: HTMLElement): void {
    const o = this.opts;
    const available = this.frame.width
      * (1 - (o.safeArea.left + o.safeArea.right) / 100);
    if (available <= 0) return;

    let widest = 0;
    for (const lineEl of Array.from(root.querySelectorAll<HTMLElement>('.cwi-line'))) {
      widest = Math.max(widest, lineEl.scrollWidth);
    }
    if (widest <= available) return;

    const scale = available / widest;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.cwi-tok, .cwi-sp'))) {
      const px = parseFloat(el.style.fontSize);
      if (px) el.style.fontSize = `${px * scale}px`;
      const w = parseFloat(el.style.width);
      if (w) el.style.width = `${w * scale}px`;
    }
    for (const lineEl of Array.from(root.querySelectorAll<HTMLElement>('.cwi-line'))) {
      const pad = lineEl.style.padding.split(' ').map((v) => parseFloat(v) * scale);
      if (pad.length === 2 && pad.every(Number.isFinite)) {
        lineEl.style.padding = `${pad[0]}px ${pad[1]}px`;
      }
    }
  }

  /** Measure the video's *content* box, excluding letterbox/pillarbox bars. */
  private measureFrame(): void {
    const m = this.frameSource as HTMLVideoElement | null;
    if (!m) return;
    const box = m.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Before metadata arrives videoWidth/Height are 0; fall back to the element
    // box so captions size sensibly instead of collapsing to 0px type.
    const vw = m.videoWidth || box.width;
    const vh = m.videoHeight || box.height;
    const scale = Math.min(box.width / vw, box.height / vh);
    const w = vw * scale, h = vh * scale;
    this.frame = { width: w, height: h };
    // Position the caption root over the frame, not the element.
    this.el.style.left = `${(box.width - w) / 2}px`;
    this.el.style.top = `${(box.height - h) / 2}px`;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
    this.applyLayoutVars();
    this.rebuild();
  }

  /** Work area and safe margins (spec 2.4.3). */
  private applyLayoutVars(): void {
    const o = this.opts;
    const h = this.frame.height;
    this.el.style.setProperty('--cwi-box-opacity', String(o.boxOpacity));
    this.el.style.setProperty('--cwi-read-ahead', String(o.readAheadOpacity));
    this.el.style.setProperty('--cwi-pop-scale', String(1 + o.popScale));
    this.el.style.setProperty('--cwi-pop-dur', `${o.popDurationSec}s`);
    this.el.style.paddingBottom = `${(o.safeArea.bottom / 100) * h}px`;
    this.el.style.paddingLeft = `${(o.safeArea.left / 100) * this.frame.width}px`;
    this.el.style.paddingRight = `${(o.safeArea.right / 100) * this.frame.width}px`;
    // Captions live in the lower `workAreaPct` of the frame.
    this.stack.style.maxHeight = `${o.workAreaPct * h}px`;
  }

  /** Re-lay-out currently visible cues, e.g. after a resize. */
  private rebuild(): void {
    const t = this.lastTime;
    this.clear();
    this.lastTime = -1;
    this.seek(t);
  }

  setOptions(patch: Partial<CwiOptions>): void {
    this.opts = withDefaults({ ...this.opts, ...patch });
    this.applyLayoutVars();
    this.rebuild();
  }

  getOptions(): CwiOptions { return { ...this.opts }; }

  clear(): void {
    for (const v of this.active.values()) v.root.remove();
    this.active.clear();
  }

  destroy(): void {
    this.stop();
    this.ro?.disconnect();
    this.clear();
    this.el.remove();
  }
}
