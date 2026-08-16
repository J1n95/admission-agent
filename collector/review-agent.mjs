const allowedDecisions = new Set(["approved", "pending", "rejected"]);
const allowedConfidence = new Set(["high", "medium", "low"]);

export function normalizeReviewDecision(value) {
  const decision = String(value?.decision || "pending").toLowerCase();
  const confidence = String(value?.confidence || "low").toLowerCase();
  const evidence = Array.isArray(value?.evidence)
    ? value.evidence.map(item => ({ field: String(item?.field || ""), quote: String(item?.quote || "") }))
      .filter(item => item.field && item.quote).slice(0, 12)
    : [];
  const issues = Array.isArray(value?.issues) ? value.issues.map(String).filter(Boolean).slice(0, 12) : [];
  return {
    decision: allowedDecisions.has(decision) ? decision : "pending",
    confidence: allowedConfidence.has(confidence) ? confidence : "low",
    reason: String(value?.reason || "模型未提供明确原因").slice(0, 500),
    evidence,
    issues
  };
}

export function isCorroboratedReview(history, decision) {
  if (!["approved", "rejected"].includes(decision?.decision) || decision?.confidence !== "high" || decision.evidence?.length < 2) return false;
  return (Array.isArray(history) ? history : []).some(item =>
    item?.reviewer === "llm"
    && item?.decision?.decision === decision.decision
    && item?.decision?.confidence === "high"
    && item?.decision?.evidence?.length >= 2
  );
}

export function reviewInput(row, sourceText) {
  return {
    candidate: {
      targetUniversity: row.targetUniversity,
      targetProgramme: row.targetProgramme,
      targetProgrammeEnglish: row.targetProgrammeEnRaw || null,
      offerYear: row.offerYear,
      undergraduateUniversity: row.undergraduateUniversity,
      undergraduateMajor: row.undergraduateMajor,
      gpaRaw: row.gpaRaw,
      gpaScale: row.gpaScale,
      languageTest: row.languageTest,
      languageScale: row.languageScale,
      languageScore: row.languageScore,
      sourceEvidence: row.sourceEvidence,
      issues: row.issues
    },
    sourceUrl: row.sourceUrl,
    sourceText: String(sourceText || "").slice(0, 60000)
  };
}
