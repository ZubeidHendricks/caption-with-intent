/**
 * Palettes transcribed verbatim from the Caption with Intention design system
 * V1.0 (2025.1), sections 2.1.1 – 2.1.4.
 */

export interface Swatch {
  name: string;
  hex: string;
  /** Hue in degrees, derived. Used for the spacing rules in 2.1.1 / 2.1.3. */
  hue: number;
}

/** Spec 2.1.1 — six main-character colours. */
export const MAIN_COLORS: Swatch[] = [
  { name: 'CI Main Yellow', hex: '#E5E517', hue: 60 },
  { name: 'CI Main Green', hex: '#17E517', hue: 120 },
  { name: 'CI Main Blue', hex: '#17E5E5', hue: 180 },
  { name: 'CI Main Pink', hex: '#E517E5', hue: 300 },
  { name: 'CI Main Red', hex: '#E51717', hue: 0 },
  { name: 'CI Main Orange', hex: '#E58017', hue: 30 },
];

/** Spec 2.1.2 — twelve supporting colours, sitting between the main hues. */
export const SUPPORTING_COLORS: Swatch[] = [
  { name: 'CI Support Orange', hex: '#E85C2E', hue: 15 },
  { name: 'CI Support Yellow', hex: '#EBC247', hue: 45 },
  { name: 'CI Support Green I', hex: '#C2EB47', hue: 75 },
  { name: 'CI Support Green II', hex: '#82ED5E', hue: 105 },
  { name: 'CI Support Green III', hex: '#47EB70', hue: 135 },
  { name: 'CI Support Cyan', hex: '#5EEDC9', hue: 165 },
  { name: 'CI Support Blue I', hex: '#47C2EB', hue: 195 },
  { name: 'CI Support Blue II', hex: '#5E82ED', hue: 225 },
  { name: 'CI Support Purple I', hex: '#8C6BED', hue: 255 },
  { name: 'CI Support Purple II', hex: '#CC6BED', hue: 285 },
  { name: 'CI Support Pink I', hex: '#EB47C2', hue: 315 },
  { name: 'CI Support Pink II', hex: '#ED5E82', hue: 345 },
];

/**
 * Spec 2.1.4 — minor characters take pastels from the centre of the wheel at a
 * fixed S:30% B:90%, which encodes character importance in saturation.
 */
export const MINOR_HUES = [
  0, 7, 24, 40, 58, 73, 87, 102, 120, 133, 149, 162,
  178, 193, 207, 222, 240, 251, 267, 282, 298, 313, 327, 342,
] as const;

export const MINOR_SATURATION = 0.3;
export const MINOR_BRIGHTNESS = 0.9;

/** HSB/HSV -> #RRGGBB. h in degrees, s and v in 0..1. */
export function hsbToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`.toUpperCase();
}

/** The nth minor-character colour, per spec 2.1.4. Wraps around the wheel. */
export function minorColor(index: number): string {
  const hue = MINOR_HUES[index % MINOR_HUES.length];
  return hsbToHex(hue, MINOR_SATURATION, MINOR_BRIGHTNESS);
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Smallest absolute distance between two hues, in degrees (0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Relative luminance per WCAG 2.x. Used by the contrast audit — the spec
 * documents no contrast floor, which is one of its real gaps.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
