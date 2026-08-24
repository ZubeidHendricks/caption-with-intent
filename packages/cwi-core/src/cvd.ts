/**
 * Colour-vision-deficiency simulation and colour-distance utilities.
 *
 * The CWI V1.0 spec distinguishes speakers by hue alone and documents no
 * contrast floor or CVD fallback. Roughly 8% of men have a red-green
 * deficiency, and that population overlaps the DHH audience, so a colour plan
 * that is unambiguous to trichromats can still collapse in practice. These
 * helpers let the toolchain audit an assignment before it ships.
 *
 * Simulation matrices: Machado, Oliveira & Fernandes (2009), severity 1.0,
 * applied in linear RGB.
 */
import { hexToRgb } from './palette.js';

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

const MATRICES: Record<CvdType, number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Simulate how a colour appears under a given dichromacy. */
export function simulateCvd(hex: string, type: CvdType): string {
  const lin = hexToRgb(hex).map((v) => toLinear(v / 255));
  const m = MATRICES[type];
  const out = m.map((row) => clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  const to = (n: number) => Math.round(toSrgb(n) * 255).toString(16).padStart(2, '0');
  return `#${to(out[0])}${to(out[1])}${to(out[2])}`.toUpperCase();
}

/** sRGB -> CIE L*a*b* (D65). */
export function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255));
  // linear sRGB -> XYZ (D65)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE*ab. Crude next to CIEDE2000, but stable and adequate for a
 *  go/no-go check on large, saturated, moving type. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
