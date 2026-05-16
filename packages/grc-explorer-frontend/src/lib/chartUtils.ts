/**
 * Chart-helper primitives shared by the history pages (researchers,
 * projects, network). Heavier than what lives in
 * `components/charts/SvgChart.tsx` — those are render primitives
 * (frame provider, axes, line-path builder); these are pure data-
 * shape transforms (interpolation, year grouping) that the history
 * pages each rolled inline.
 */

/**
 * Fritsch–Carlson monotone cubic interpolation. Rounds the corners
 * of a piecewise-linear series without overshoot — important for the
 * project history charts because a non-monotone spline would invent
 * fractional active-project counts that read as "we re-listed half
 * a project" between superblocks.
 *
 * Returns null when there are fewer than 2 points (no segments to
 * draw). Generic so callers can plug in their own point shape and
 * value extractor.
 */
export function buildSmoothLinePath<T>(
  arr: T[],
  xOf: (p: T) => number,
  yOf: (v: number) => number,
  pickValue: (p: T) => number,
): string | null {
  const n = arr.length;
  if (n < 2) return null;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = xOf(arr[i]);
    ys[i] = yOf(pickValue(arr[i]));
  }
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const h = xs[i + 1] - xs[i];
    d[i] = h === 0 ? 0 : (ys[i + 1] - ys[i]) / h;
  }
  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) m[i] = (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  const segs: string[] = [`M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const h = xs[i + 1] - xs[i];
    const c1x = xs[i] + h / 3;
    const c1y = ys[i] + (m[i] * h) / 3;
    const c2x = xs[i + 1] - h / 3;
    const c2y = ys[i + 1] - (m[i + 1] * h) / 3;
    segs.push(
      `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`,
    );
  }
  return segs.join(' ');
}
