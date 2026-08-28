/**
 * Attach an existing subtitle file to a manifest as a switchable language.
 *
 * Translation itself is not done here, and deliberately so: every film already
 * has professionally translated subtitles, in SRT or VTT, and they are better
 * than anything a machine would produce on the spot. What is missing is not the
 * translation — it is that those files are flat text with no speaker, no
 * acoustics and no word-level timing, so switching to them today means losing
 * everything this design exists to convey.
 *
 * So: take the words from the translation, and take who-spoke, when, how loudly
 * and at what pitch from the analysed soundtrack. A viewer switching to German
 * gets German words carrying the original actor's delivery.
 *
 * Cues are matched by time overlap rather than by index. Subtitle files are
 * segmented for reading comfort, not for utterances, so a translation routinely
 * splits one line into two or merges two into one; matching by position would
 * silently drift the whole film after the first disagreement.
 */
import { readFileSync } from 'node:fs';
import { isUnspacedText, type CwiManifest } from '@corerus/chorus-core';
import { CwiError } from './ops.js';

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

/** Parse SRT or WebVTT. Both are the same shape once the header is dropped. */
export function parseSubtitles(src: string): SubtitleEntry[] {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const body = text.startsWith('WEBVTT') ? text.slice(text.indexOf('\n')) : text;
  const entries: SubtitleEntry[] = [];

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // An optional numeric counter, then the timing line, then the text.
    const timingAt = lines.findIndex((l) => l.includes('-->'));
    if (timingAt < 0) continue;
    const m = lines[timingAt].match(
      /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/);
    if (!m) continue;
    const body_ = lines.slice(timingAt + 1)
      // Strip the tag soup subtitle files accumulate: <i>, {\an8}, speaker
      // dashes at line start. None of it survives into a caption manifest.
      .map((l) => l.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/^[-–—]\s*/, '')
      .trim();
    if (!body_) continue;
    entries.push({ start: toSeconds(m[1]), end: toSeconds(m[2]), text: body_ });
  }
  if (!entries.length) {
    throw new CwiError('No subtitle entries found in that file.',
      'Expected SRT or WebVTT with "00:00:01,000 --> 00:00:03,000" timing lines.');
  }
  return entries;
}

function toSeconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return h * 3600 + m * 60 + s;
}

/**
 * Split a translated line into reveal units.
 *
 * Chinese, Japanese, Thai, Khmer and Lao are written without word spaces, so
 * whitespace tokenisation yields one token for a whole sentence and the line
 * turns over as a block — word-level synchronisation disappears entirely. Those
 * scripts reveal per character, which is what karaoke subtitling has always
 * done for them.
 */
export function tokenize(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (isUnspacedText(w) && [...w].length > 1) out.push(...[...w]);
    else out.push(w);
  }
  return out;
}

/** Right-to-left if the text is mostly RTL letters. */
export function detectDirection(text: string): 'ltr' | 'rtl' {
  let rtl = 0, ltr = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff)
      || (cp >= 0xfe70 && cp <= 0xfeff)) rtl++;
    else if (/\p{L}/u.test(ch)) ltr++;
  }
  return rtl > ltr ? 'rtl' : 'ltr';
}

export interface MatchReport {
  /** One entry per manifest cue: the translated words, or null if none matched. */
  perCue: Array<string[][] | null>;
  matched: number;
  total: number;
  /** Subtitle entries that overlapped no cue at all. */
  orphans: SubtitleEntry[];
  direction: 'ltr' | 'rtl';
}

/**
 * Match subtitle entries onto manifest cues by time overlap.
 *
 * An entry contributes to a cue when they overlap by more than `minOverlap` of
 * the entry's duration. That threshold matters: subtitle files habitually
 * overshoot a line's end by half a second for readability, and without it every
 * entry would bleed into the following cue and duplicate its text there.
 */
export function matchByTime(
  m: CwiManifest,
  entries: SubtitleEntry[],
  maxLines = 2,
  minOverlap = 0.4,
): MatchReport {
  const used = new Set<SubtitleEntry>();
  const perCue: Array<string[][] | null> = m.cues.map((cue) => {
    if (!cue.lines.length) return null;
    const hits = entries.filter((e) => {
      const overlap = Math.min(cue.end, e.end) - Math.max(cue.start, e.start);
      return overlap > 0 && overlap >= Math.min(e.end - e.start, cue.end - cue.start) * minOverlap;
    });
    if (!hits.length) return null;
    hits.forEach((h) => used.add(h));
    const words = tokenize(hits.map((h) => h.text).join(' '));
    if (!words.length) return null;
    return balance(words, maxLines);
  });

  return {
    perCue,
    matched: perCue.filter(Boolean).length,
    total: m.cues.filter((c) => c.lines.length).length,
    orphans: entries.filter((e) => !used.has(e)),
    direction: detectDirection(entries.map((e) => e.text).join(' ').slice(0, 4000)),
  };
}

/** Split words into at most `maxLines` roughly equal lines. */
function balance(words: string[], maxLines: number): string[][] {
  if (words.length <= 1 || maxLines <= 1) return [words];
  const per = Math.ceil(words.length / maxLines);
  const out: string[][] = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per));
  return out.slice(0, maxLines);
}

export function readSubtitles(path: string): SubtitleEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CwiError(`Could not read ${path}.`, 'Pass an SRT or WebVTT file.');
  }
  return parseSubtitles(raw);
}
