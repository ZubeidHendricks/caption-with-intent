/** Injected once per document. Kept in a constant so the renderer stays
 *  dependency-free and embeddable inside a host app's shadow DOM. */
export const CWI_CSS = `
.cwi-root {
  position: absolute; inset: 0; pointer-events: none;
  display: flex; flex-direction: column; justify-content: flex-end; align-items: center;
  overflow: hidden;
  font-family: 'Roboto Flex', 'Roboto', system-ui, sans-serif;
  font-kerning: normal;
  -webkit-font-smoothing: antialiased;
  contain: layout paint;
}
.cwi-stack { display: flex; flex-direction: column; align-items: center; gap: 0.35em; width: 100%; }
/* Horizontal placement as a second, non-colour attribution channel. Colour
   alone fails WCAG 1.4.1 for any scene with more than one speaker. */
.cwi-cue { display: flex; flex-direction: column; width: 100%; align-items: center; }
/* Physical margins, not flex-start/flex-end: those resolve against the inline
   direction, so under dir=rtl a speaker pinned left silently rendered right.
   Position is a spatial attribution cue and must not mirror with the script. */
.cwi-cue--left  > .cwi-line { margin-right: auto; }
.cwi-cue--right > .cwi-line { margin-left: auto; }
/* Inline layout follows the root dir attribute, so an RTL track reveals right
   to left without any per-token handling. */
.cwi-root[dir='rtl'] .cwi-line { direction: rtl; }
.cwi-line {
  /* Inline layout, not flex: flex items that contain only whitespace collapse
     to zero width, which silently welds the words together. Inline-block
     tokens on a nowrap line keep natural spacing and share a baseline even
     when adjacent words differ in size. */
  display: block; white-space: nowrap; text-align: center;
  border-radius: 0.12em;
}
.cwi-line--boxed { background: rgba(0,0,0,var(--cwi-box-opacity, .9)); }
.cwi-tok {
  display: inline-block; vertical-align: baseline;
  /* Laid out once at its final volume-derived size, so the pop below can never
     reflow the line. This is the whole trick. */
  transform-origin: 50% 85%;
  transform: scale(1);
  will-change: transform, color;
  transition: color 60ms linear;
  color: rgba(255,255,255,var(--cwi-read-ahead, .9));
}
.cwi-tok--spoken { color: var(--cwi-speaker, #fff); }
.cwi-glyph { opacity: 0.85; vertical-align: baseline; }
.cwi-sp { display: inline-block; vertical-align: baseline; white-space: pre; }
.cwi-root--offcam .cwi-tok { font-variation-settings: var(--cwi-axes), 'slnt' var(--cwi-slnt, -10); }
/* The pop is a transform written per frame from the seek time, not a CSS
   animation — see applyPop(). prefers-reduced-motion is honoured there, because
   the renderer must also be able to ignore it when rendering offscreen. */
`;

let injected = false;
export function injectStyle(target: Document | ShadowRoot = document): void {
  const root = target as Document;
  if (root === document) {
    if (injected) return;
    injected = true;
  }
  const el = document.createElement('style');
  el.dataset.cwi = '';
  el.textContent = CWI_CSS;
  (target instanceof Document ? target.head : target).appendChild(el);
}
