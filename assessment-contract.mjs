function evidenceIsMissing(field, comparison) {
  const name = String(field || '').toLowerCase();
  if (name.includes('gpa')) return !comparison?.evidence?.gpa?.available;
  if (name.includes('language')) return !comparison?.evidence?.language?.available;
  return false;
}

export function normalizeAssessment(value, allowedDocumentIds = new Set(), comparison = null, evidenceOrder = []) {
  const center = Number(value?.center);
  const low = Number(value?.low);
  const high = Number(value?.high);
  if (![center, low, high].every(Number.isFinite) || low < 0 || low > center || center > high || high > 100) return null;

  const order = new Map(evidenceOrder.map((documentId, index) => [String(documentId), index]));
  const seenEvidence = new Set();
  const evidenceUsed = Array.isArray(value?.evidenceUsed) ? value.evidenceUsed.map(item => ({
    documentId: String(item?.documentId || ''),
    field: String(item?.field || ''),
    comparison: String(item?.comparison || ''),
    missing: Boolean(item?.missing) || evidenceIsMissing(item?.field, comparison)
  })).filter(item => allowedDocumentIds.has(item.documentId) && !seenEvidence.has(item.documentId) && seenEvidence.add(item.documentId))
    .sort((a, b) => (order.get(a.documentId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.documentId) ?? Number.MAX_SAFE_INTEGER)
      || a.documentId.localeCompare(b.documentId)) : [];
  const uncertainties = Array.isArray(value?.uncertainties) ? value.uncertainties.map(String) : [];
  if (!evidenceUsed.length || evidenceUsed.some(item => item.missing) && !uncertainties.length) return null;

  const reasoning = Array.isArray(value?.reasoning) ? value.reasoning.map(String).map(reason => {
    const evidence = evidenceUsed.find(item => reason.includes(`[${item.documentId}]`)
      || reason.startsWith(`[${item.documentId}:`) && reason.includes("]")
      || reason.startsWith(`${item.documentId} `));
    if (!evidence) return null;
    if (reason.includes(`[${evidence.documentId}]`)) return reason;
    const explanation = reason.startsWith("[") ? reason.slice(reason.indexOf("]") + 1) : reason.slice(evidence.documentId.length);
    return `[${evidence.documentId}] ${explanation.trimStart()}`;
  }).filter(Boolean) : [];
  if (!reasoning.length) return null;

  return {
    assessmentAvailable: true,
    center: Math.round(center),
    low: Math.round(low),
    high: Math.round(high),
    fit: Array.isArray(value?.fit) ? value.fit.map(String) : [],
    psCv: Array.isArray(value?.psCv) ? value.psCv.map(String) : [],
    reasoning,
    evidenceUsed,
    uncertainties
  };
}
