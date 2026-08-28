/** Minimal argument parsing. No dependency; the surface is small and stable. */
export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { positional, flags };
}

export const str = (a: Args, k: string): string | undefined =>
  typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined;
export const num = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} expects a number, got "${v}"`);
  return n;
};
export const bool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === 'true';
