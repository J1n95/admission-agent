export function readableEvidenceIds(value) {
  const internalId = String.raw`(?:(?:e|c)_[A-Za-z0-9_-]+|[a-f0-9]{16,64}|[a-z0-9-]+:(?:card|programme-card|requirements|case))(?:\:[A-Za-z0-9_-]+)?`;
  return String(value ?? "")
    .replace(new RegExp(String.raw`\s*[\[【]${internalId}[\]】]\s*`, "gi"), "")
    .replace(new RegExp(String.raw`^\s*${internalId}\s*(?:[:：·-]\s*)?`, "i"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function modelReferencePresentation(result = {}, caseCount = 0) {
  const available = Boolean(result.assessmentAvailable)
    && [result.center, result.low, result.high].every(value => Number.isFinite(Number(value)));
  if (!available) return { available: false, intervalOnly: false, label: "模型机会参考", value: "暂无数值" };
  const intervalOnly = Number(caseCount) < 5;
  return {
    available: true,
    intervalOnly,
    label: intervalOnly ? "模型区间参考 · 证据有限" : "模型机会参考 · 未经统计校准",
    value: intervalOnly ? `${result.low}%–${result.high}%` : `${result.center}%`
  };
}
