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
.cwi-stack { display: flex; flex-direction: column; align-items: center; gap: 0.35em; }
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
.cwi-tok--pop { animation: cwi-pop var(--cwi-pop-dur, .18s) cubic-bezier(.34,1.56,.64,1); }
.cwi-sp { display: inline-block; vertical-align: baseline; white-space: pre; }
@keyframes cwi-pop {
  0%   { transform: scale(1); }
  45%  { transform: scale(var(--cwi-pop-scale, 1.15)); }
  100% { transform: scale(1); }
}
.cwi-root--offcam .cwi-tok { font-variation-settings: var(--cwi-axes), 'slnt' var(--cwi-slnt, -10); }
@media (prefers-reduced-motion: reduce) {
  .cwi-tok--pop { animation: none; }
}
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
