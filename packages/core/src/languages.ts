/**
 * Multiple subtitle languages over one performance.
 *
 * A viewer switching subtitle language mid-film is switching *text*. Who spoke,
 * when they spoke, how loudly and at what pitch are properties of the actor's
 * delivery on the soundtrack — they do not change because the reader changed.
 * So a manifest carries one timing-and-acoustics backbone and N text tracks
 * over it, and the typography stays derived from the original performance in
 * every language.
 *
 * This is also why switching is cheap enough to do live: the renderer is
 * swapping token text and re-laying out one cue, not reloading a track.
 *
 * What it does *not* do is pretend the words line up. A translation has its own
 * word count and word order — German compounds where English uses four words,
 * Japanese puts the verb last. `retime` below is explicit about how far that
 * can honestly be taken.
 */
import type { Cue, CueLine, CueTrack, CwiManifest, Token } from './types.js';
import { displayWidth } from './mapping.js';

/** Every language in the manifest, the base language first. */
export function languagesOf(m: CwiManifest): string[] {
  const base = m.meta?.language ?? 'und';
  const seen = new Set<string>([base]);
  for (const c of m.cues) for (const k of Object.keys(c.tracks ?? {})) seen.add(k);
  return [...seen];
}

/** Does every cue with dialogue carry this language? */
export function coverageOf(m: CwiManifest, lang: string): { total: number; present: number } {
  const base = m.meta?.language ?? 'und';
  const cues = m.cues.filter((c) => c.lines.length > 0);
  if (lang === base) return { total: cues.length, present: cues.length };
  return {
    total: cues.length,
    present: cues.filter((c) => c.tracks?.[lang]?.lines.length).length,
  };
}

/**
 * The lines to draw for a cue in a given language.
 *
 * Falls back to the base track rather than drawing nothing: a partially
 * translated film should show the original for the lines nobody has translated
 * yet, which is what every subtitle workflow does and what a viewer expects.
 */
export function linesFor(m: CwiManifest, cue: Cue, lang?: string): CueLine[] {
  if (!lang || lang === (m.meta?.language ?? 'und')) return cue.lines;
  return cue.tracks?.[lang]?.lines ?? cue.lines;
}

/** Writing direction for a cue in a given language. */
export function directionFor(m: CwiManifest, cue: Cue, lang?: string): 'ltr' | 'rtl' {
  if (lang && lang !== (m.meta?.language ?? 'und')) {
    const t = cue.tracks?.[lang];
    if (t) return t.direction ?? m.meta?.direction ?? 'ltr';
  }
  return m.meta?.direction ?? 'ltr';
}

/**
 * Distribute a translated line's words across the source cue's span.
 *
 * **This is an approximation, and it is worth being exact about which one.**
 * Word-level synchronisation is honest only when a word's onset is when that
 * word was *spoken*. In a translation there is no such moment: the words are
 * not the ones on the soundtrack, and a translated word can correspond to
 * three source words, half of one, or to nothing at all.
 *
 * What survives translation is the *utterance* — its start, its end, and the
 * acoustics across it. So each target word is placed proportionally by display
 * width within the cue, and takes its acoustics from whichever source token was
 * being spoken at that moment. The reveal therefore stays in step with the
 * voice at the phrase level and the typography still reflects the real
 * delivery, while no claim is made that word 4 of the German is word 4 of the
 * English.
 *
 * Weight by display width rather than character count because a CJK glyph is
 * about twice as wide as a Latin one; weighting by count makes Japanese lines
 * reveal at roughly half the rate they are read.
 */
export function retime(
  source: Cue,
  words: string[],
  widthOf: (s: string) => number = displayWidth,
): Token[] {
  if (!words.length) return [];
  const src = source.lines.flatMap((l) => l.tokens);
  const start = src.length ? src[0].start : source.start;
  const end = src.length ? src[src.length - 1].end : source.end;
  const span = Math.max(end - start, 1e-6);

  const widths = words.map((w) => Math.max(widthOf(w), 1));
  const total = widths.reduce((a, b) => a + b, 0);

  let t = start;
  return words.map((text, i) => {
    const dur = (widths[i] / total) * span;
    const tok: Token = { text, start: round(t), end: round(t + dur) };
    // Acoustics come from whatever was actually being said at this instant, so
    // a shout stays large and a whisper small in every language.
    const at = midpoint(t, t + dur);
    const from = src.find((k) => at >= k.start && at < k.end) ?? nearest(src, at);
    if (from) {
      if (from.db !== undefined) tok.db = from.db;
      if (from.f0 !== undefined) tok.f0 = from.f0;
      if (from.centroid !== undefined) tok.centroid = from.centroid;
    }
    t += dur;
    return tok;
  });
}

/**
 * Attach a translated track to a manifest, retiming each cue against its own
 * source timings. `lines` is one entry per cue, already segmented into lines
 * and words by the caller — segmentation is script-specific and belongs with
 * the pipeline that knows about kinsoku and unspaced scripts.
 */
export function addTrack(
  m: CwiManifest,
  lang: string,
  perCue: Array<string[][] | null>,
  direction?: 'ltr' | 'rtl',
  widthOf: (s: string) => number = displayWidth,
): CwiManifest {
  if (perCue.length !== m.cues.length) {
    throw new Error(
      `translation has ${perCue.length} cues, manifest has ${m.cues.length}; ` +
      'they must correspond one to one');
  }
  const cues = m.cues.map((cue, i) => {
    const lines = perCue[i];
    if (!lines || !lines.length) return cue;                  // untranslated: falls back
    // Retime across the whole cue, then split back into the caller's lines.
    const flat = lines.flat();
    const timed = retime(cue, flat, widthOf);
    const out: CueLine[] = [];
    let k = 0;
    for (const line of lines) {
      out.push({ tokens: timed.slice(k, k + line.length) });
      k += line.length;
    }
    const track: CueTrack = { lines: out };
    if (direction) track.direction = direction;
    return { ...cue, tracks: { ...cue.tracks, [lang]: track } };
  });

  const languages = [...new Set([...(m.meta?.languages ?? languagesOf(m)), lang])];
  return { ...m, meta: { ...m.meta, languages }, cues };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const midpoint = (a: number, b: number) => a + (b - a) / 2;

function nearest(tokens: Token[], t: number): Token | undefined {
  let best: Token | undefined;
  let bestD = Infinity;
  for (const k of tokens) {
    const d = t < k.start ? k.start - t : t > k.end ? t - k.end : 0;
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
