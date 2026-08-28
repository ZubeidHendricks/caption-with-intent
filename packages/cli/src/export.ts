import {
  withDefaults, resolveToken,
  type CwiManifest, type CwiOptions, type Cue,
} from '@chorus/core';

/** #RRGGBB -> ASS &HBBGGRR& */
function assColor(hex: string): string {
  const h = hex.replace('#', '');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

function assTime(t: number): string {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

export interface AssResult {
  ass: string;
  /** What the format could not carry. Always report these — silently degrading
   *  an accessibility feature is worse than not shipping it. */
  lost: string[];
}

/**
 * Export to Advanced SubStation Alpha for `ffmpeg -vf subtitles=...` burn-in.
 *
 * This is the "ship it today" path the spec itself prescribes (3.2: until
 * decoders catch up, distribute as burned-in open captions). It is LOSSY:
 *
 *   carried  — per-character colour, per-word size, karaoke word timing,
 *              the caption box, oblique for off-camera
 *   lost     — the variable-font weight and width axes, i.e. the whole
 *              intonation layer for pitch and harmonics (2.3.7-2.3.10)
 *
 * libass has no variable-font axis support: weight is a binary bold flag and
 * `\fscx` scales glyphs geometrically rather than interpolating a width axis,
 * which distorts stroke contrast instead of redrawing it. There is no way to
 * express `wght 776` in ASS. A faithful burn-in has to come from a renderer
 * that can drive the axes — the web renderer offscreen, or the After Effects
 * project from the CWI team.
 */
export function toAss(manifest: CwiManifest, opts?: Partial<CwiOptions>, frameH = 1080, frameW = 1920): AssResult {
  const o = withDefaults({ ...manifest.options, ...opts });
  const colors = new Map(manifest.characters.map((c) => [c.id, c.color ?? '#FFFFFF']));
  const lost = new Set<string>();

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frameW}`,
    `PlayResY: ${frameH}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // BorderStyle 3 = opaque box, which is the closest ASS has to spec 2.4.1.
    `Style: CWI,Roboto Flex,${Math.round((o.baselineSizePct / 100) * frameH)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H${Math.round((1 - o.boxOpacity) * 255).toString(16).padStart(2, '0').toUpperCase()}000000,0,0,0,0,100,100,0,0,3,0,0,2,${Math.round((o.safeArea.left / 100) * frameW)},${Math.round((o.safeArea.right / 100) * frameW)},${Math.round((o.safeArea.bottom / 100) * frameH)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  for (const cue of manifest.cues) {
    const speakerColor = cue.kind === 'dialogue' && !o.monochrome
      ? colors.get(cue.speaker ?? '') ?? '#FFFFFF' : '#FFFFFF';

    for (const line of cue.lines.slice(0, o.maxLines)) {
      const parts: string[] = [];
      // Read-ahead white, then karaoke reveal in the character's colour.
      parts.push(`{\\1c&H00FFFFFF&\\alpha&H${Math.round((1 - o.readAheadOpacity) * 255).toString(16).padStart(2, '0').toUpperCase()}&}`);
      if (cue.onCamera === false) parts.push('{\\i1}');

      for (const tok of line.tokens) {
        const st = resolveToken(tok, o);
        if (st.wght !== o.baselineWeight) lost.add('font weight (pitch)');
        if (st.wdth !== o.baselineWidth) lost.add('font width (harmonics)');
        // \k takes centiseconds and reveals in PrimaryColour.
        const k = Math.max(1, Math.round((tok.end - tok.start) * 100));
        const fs = Math.round((st.size / 100) * frameH);
        parts.push(`{\\k${k}\\fs${fs}\\1c${assColor(speakerColor)}}${tok.text} `);
      }
      events.push(
        `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},CWI,${cue.speaker ?? cue.kind},0,0,0,,${parts.join('')}`,
      );
    }
    if (cue.breakout) lost.add('box breakout for sudden loud speech (spec 2.4.1)');
  }
  lost.add('the 15% word-onset pop (spec 2.2.3) — ASS \\t can approximate it per word but not without one override tag per word, which most players render poorly');

  return { ass: [...head, ...events].join('\n') + '\n', lost: [...lost] };
}

/**
 * Export to WebVTT with inline word timestamps and per-speaker cue classes.
 *
 * Carried: speaker identity (as a class, styleable via `::cue(.speaker-id)`),
 * word-level timing (VTT's `<00:00:01.000>` syntax, which players already use
 * for karaoke highlighting).
 * Lost: everything typographic. VTT has no per-word sizing and no font axes.
 *
 * Worth shipping anyway: it degrades to a correct, conventional caption track
 * on every existing player, and it is the natural regulatory-compliance
 * companion the spec asks for in 3.4.
 */
export function toVtt(manifest: CwiManifest): { vtt: string; lost: string[] } {
  const names = new Map(manifest.characters.map((c) => [c.id, c.name ?? c.id]));
  const out = ['WEBVTT', ''];

  // Cue styling blocks let a player recover speaker colour without CWI support.
  for (const c of manifest.characters) {
    if (!c.color) continue;
    out.push('STYLE', `::cue(.${cssIdent(c.id)}) { color: ${c.color}; }`, '');
  }

  for (const cue of manifest.cues) {
    out.push(cue.id ?? '');
    out.push(`${vttTime(cue.start)} --> ${vttTime(cue.end)}`);
    for (const line of cue.lines) {
      const body = line.tokens
        .map((t, i) => (i === 0 ? '' : `<${vttTime(t.start)}>`) + t.text)
        .join(' ');
      const inner = cue.onCamera === false ? `<i>${body}</i>` : body;
      out.push(cue.speaker ? `<v.${cssIdent(cue.speaker)} ${names.get(cue.speaker)}>${inner}` : inner);
    }
    out.push('');
  }
  return {
    vtt: out.join('\n'),
    lost: [
      'type size (volume) — VTT has no per-word sizing',
      'font weight and width (pitch, harmonics) — no variable-font axis support',
      'the word-onset pop (spec 2.2.3)',
      'the caption box treatment (spec 2.4.1) beyond a player default',
    ],
  };
}

function vttTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function cssIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^(\d)/, '_$1');
}

/** Duration each character is on screen — useful for sanity-checking tiers. */
export function summarize(cues: Cue[]) {
  return cues.reduce((n, c) => n + (c.end - c.start), 0);
}
