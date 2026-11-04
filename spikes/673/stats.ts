// plan-673 — the two statistics helpers the Phase-1 and Phase-1b gates report with.
//
// They live here and not in the MuJoCo wrapper because they have nothing to do
// with MuJoCo: Phase 1b uses them on signal-write timings with no physics in
// sight. Phase 1 originally kept them next to its own throwaway wrapper; when
// that wrapper was deleted in favour of the product one
// (`@rv-private/mujoco/rv-mujoco-world`), these came here rather than into the
// product class, which has no business carrying a percentile.

/** p-th percentile of `values` (0..1), nearest-rank. Mutates nothing. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
