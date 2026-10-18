// These are relative model references, not calibrated admission probabilities.
export function buildComparison(results) {
  const assessed = results.filter(({ result }) => result?.assessmentAvailable
    && Number.isFinite(result.center) && result.center >= 0 && result.center <= 100
    && Number.isFinite(result.low) && Number.isFinite(result.high)
    && result.low <= result.center && result.center <= result.high);
  const ordered = [...assessed].sort((a, b) => b.result.center - a.result.center);
  const total = ordered.length;
  const byId = new Map();
  for (const item of ordered) {
    const rank = 1 + ordered.filter(other => other.result.center > item.result.center).length;
    byId.set(item.programme.id, { rank, total });
  }
  return { byId, ordered, total };
}
