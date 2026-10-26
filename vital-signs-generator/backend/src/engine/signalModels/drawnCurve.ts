export interface CurvePoint {
  t: number;
  value: number;
}

/** Piecewise-linear interpolation between user-placed control points,
 * `t` normalized 0..1 across the scenario's own duration. Evaluating
 * exactly at a control point's own `t` must return exactly that point's
 * value (verified by a unit test) - the whole reason a clinician can
 * "draw" a curve and trust it lands where they put it. Before the first
 * point or after the last, the curve holds flat at that point's value
 * (never extrapolates). Spline interpolation would swap in here without
 * touching any caller - deliberately kept isolated in this one function. */
export function interpolateDrawnCurve(points: CurvePoint[], t: number): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  if (t <= first.t) return first.value;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.t) return last.value;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i]!;
    const right = sorted[i + 1]!;
    if (t >= left.t && t <= right.t) {
      if (right.t === left.t) return left.value;
      const fraction = (t - left.t) / (right.t - left.t);
      return left.value + fraction * (right.value - left.value);
    }
  }
  return last.value;
}

export function evaluateDrawnCurveSeries(points: CurvePoint[], timestampsMs: number[], startTimeMs: number, durationMs: number): number[] {
  return timestampsMs.map((timestamp) => {
    const tNormalized = durationMs > 0 ? Math.min(Math.max((timestamp - startTimeMs) / durationMs, 0), 1) : 0;
    return interpolateDrawnCurve(points, tNormalized);
  });
}
