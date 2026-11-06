/** mulberry32: small, seedable, reproducible. */
export function random(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Linear-interpolated quantile (numpy's default), q in [0, 1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b), pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * 95% percentile-bootstrap interval that resamples tasks, not runs: repeats of
 * one task are correlated, so tasks are the independent unit (README §2 rule 10).
 */
export function bootstrapByTask<T>(groups: readonly T[], statistic: (sample: readonly T[]) => number, seed: number, rounds = 2000): [number, number] {
  if (groups.length < 2) return [NaN, NaN];
  const next = random(seed), values: number[] = [];
  for (let b = 0; b < rounds; b++) {
    const sample = Array.from({ length: groups.length }, () => groups[Math.floor(next() * groups.length)]!);
    const value = statistic(sample);
    if (Number.isFinite(value)) values.push(value);
  }
  return [quantile(values, 0.025), quantile(values, 0.975)];
}
