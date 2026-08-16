import { undergraduateInstitutionEvidence } from "../master-data.mjs";

const hardFields = [
  "targetUniversity",
  "targetProgramme",
  "undergraduateUniversity",
  "undergraduateMajor",
  "gpaRaw"
];

const isLanguageIssue = issue => /language|\u8bed\u8a00|\u82f1\u8bed/i.test(String(issue || ""));
const isGpaIssue = issue => /gpaRaw|GPA|均分|绩点|平均分/i.test(String(issue || ""));
const isResolvedProgrammeFieldIssue = issue => /(?:targetProgramme|目标项目|录取项目|申请项目|项目别名映射置信度低)/i.test(String(issue || ""));
const isStaleProgrammeIssue = issue => /(?:\u9879\u76ee\u672a\u5339\u914d(?:\u4e3b\u8868|\u5f53\u524d\u4e3b\u8868)|\u6848\u4f8b\u4fdd\u7559\u5728\u9694\u79bb\u533a)/u.test(String(issue || ""));
const isStaleInstitutionIssue = issue => /(?:\u9662\u6821.*\u4e3b\u8868|\u672a\u8bc6\u522b\u4e3a\u5177\u4f53\u9ad8\u6821)/u.test(String(issue || ""));
const isMissingInstitutionFieldIssue = issue => /(?:undergraduateUniversity|\u672c\u79d1\u9662\u6821|\u6bd5\u4e1a\u5b66\u6821)/iu.test(String(issue || ""));
const isStaleYearWindowIssue = issue => /\u4e0d\u5728\u6700\u8fd1\u4e94\u5e74\u8303\u56f4/u.test(String(issue || ""));
const isStaleYearIssue = issue => /(?:\u7f3a\u5c11\u5f55\u53d6\u5e74\u4efd|\u5173\u952e\u5b57\u6bb5\u4e8c\u6b21OCR\u672a\u901a\u8fc7\uff1aofferYear(?:-missing)?$|\u5173\u952e\u5b57\u6bb5OCR\u590d\u6838\u5b58\u5728\u51b2\u7a81\uff0c\u4e0d\u80fd\u81ea\u52a8\u5165\u5e93)/u.test(String(issue || ""));

const atomicIssues = issues => (Array.isArray(issues) ? issues : [])
  .flatMap(issue => String(issue || "").split(/；+/u))
  .map(issue => issue.trim())
  .filter(issue => issue && !/^\?+$/.test(issue));

const hasManualApproval = row => (row.sourceEvidence?.reviewAudit || [])
  .some(audit => audit?.reviewer === "manual" && audit?.status === "approved");

// Some sources write the score as “均分85”, “85/100” or “3.23/4.0”
// instead of using the literal GPA label. Treat a non-empty numeric score as
// a verified GPA field during re-review, while still requiring the original
// undergraduate major and institution fields.
const hasUsableGpa = value => {
  const text = String(value ?? "").trim();
  return /\d+(?:\.\d+)?/.test(text) && !/未提供|未知|不详|待定|暂无|无/i.test(text);
};

export function triageCase(row) {
  const matched = row.sourceEvidence?.matched || {};
  const gpaRecoveredFromRaw = hasUsableGpa(row.gpaRaw);
  const institutionEvidence = undergraduateInstitutionEvidence(row.undergraduateUniversity, row.undergraduateInstitutionId);
  const effectiveMatched = {
    ...matched,
    targetProgramme: matched.targetProgramme === true || Boolean(row.targetProgrammeId),
    undergraduateUniversity: matched.undergraduateUniversity === true || institutionEvidence.accepted,
    gpaRaw: matched.gpaRaw === true || gpaRecoveredFromRaw
  };
  const hardFieldsMatch = hardFields.every(field => effectiveMatched[field] === true);
  const issues = atomicIssues(row.issues)
    .filter(issue => !isLanguageIssue(issue))
    .filter(issue => !(gpaRecoveredFromRaw && isGpaIssue(issue)))
    .filter(issue => !(row.targetProgrammeId && isResolvedProgrammeFieldIssue(issue)))
    .filter(issue => !isStaleYearWindowIssue(issue))
    .filter(issue => !isStaleYearIssue(issue))
    .filter(issue => !(institutionEvidence.accepted && isStaleInstitutionIssue(issue)))
    .filter(issue => !(institutionEvidence.accepted && isMissingInstitutionFieldIssue(issue)))
    .filter(issue => !(row.targetProgrammeId && isStaleProgrammeIssue(issue)));

  if (row.offerYear != null && row.offerYear <= 2020) {
    return { status: "rejected", confidence: "high", reason: "录取年份早于2021年，按案例保留规则排除" };
  }

  if (!row.undergraduateMajor || !matched.undergraduateMajor) {
    return { status: "rejected", confidence: "high", reason: "缺少本科专业原文，按入库规则排除" };
  }
  if (institutionEvidence.junior) {
    return { status: "rejected", confidence: "high", reason: "本科院校属于专科、高职或高中等非本科类型，按入库规则排除" };
  }
  if (!institutionEvidence.accepted) {
    return { status: "needs-review", confidence: "low", reason: "本科院校既未识别为具体高校，也未披露985/211/双一流/双非或海外本科层级" };
  }
  if (!row.targetProgrammeId) {
    return { status: "needs-review", confidence: "low", reason: "项目未匹配当前主表；案例保留在隔离区，不进入当前工科分析" };
  }
  const unresolvedCritical = row.sourceEvidence?.criticalVerification?.unresolved || [];
  const criticalConflict = ["conflict", "unavailable"].includes(row.sourceEvidence?.criticalVerification?.status);
  const publicationYearOnly = unresolvedCritical.length > 0 && unresolvedCritical.every(field => /^(?:offerYear|language)/.test(field))
    && row.offerYear && row.sourcePublishedAt;
  // A secondary OCR pass can miss a score that the page-text extractor already
  // captured and that matches the numeric GPA field. Do not quarantine a case
  // solely for that disagreement; keep the conflict gate for genuinely
  // unresolved critical fields.
  const gpaConflictResolved = gpaRecoveredFromRaw && effectiveMatched.gpaRaw === true
    && unresolvedCritical.includes("gpaRaw");
  const criticalBlocked = criticalConflict && !publicationYearOnly && !gpaConflictResolved;
  if (criticalBlocked && !hasManualApproval(row)) {
    return { status: "needs-review", confidence: "low", reason: "关键字段OCR复核存在冲突，不能自动入库" };
  }
  if (issues.length) {
    return { status: "needs-review", confidence: "low", reason: issues.join("；") };
  }
  if (!hardFieldsMatch) {
    return { status: "needs-review", confidence: "low", reason: "网页原文没有完整定位本科院校、专业或GPA" };
  }
  if (!row.offerYear || !gpaRecoveredFromRaw) {
    return { status: "pending", confidence: "medium", reason: "录取年份和GPA仍是入库必需字段；语言成绩可以缺失" };
  }
  return {
    status: "approved",
    confidence: row.languageTest && row.languageScore != null ? "high" : "medium",
    reason: "项目、本科院校层次、本科专业、GPA和年份满足入库条件；语言成绩仅作为门槛，不阻止案例入库"
  };
}

export function applyReviewPolicy(row) {
  const decision = triageCase(row);
  if (decision.status === "approved") return { ...decision, issues: [] };
  const institutionEvidence = undergraduateInstitutionEvidence(row.undergraduateUniversity, row.undergraduateInstitutionId);
  const issues = atomicIssues([...(row.issues || []), decision.reason])
    .filter(issue => !isLanguageIssue(issue))
    .filter(issue => !isStaleYearWindowIssue(issue))
    .filter(issue => !isStaleYearIssue(issue))
    .filter(issue => !(institutionEvidence.accepted && isStaleInstitutionIssue(issue)))
    .filter(issue => !(institutionEvidence.accepted && isMissingInstitutionFieldIssue(issue)))
    .filter(issue => !(row.targetProgrammeId && isStaleProgrammeIssue(issue)));
  return { ...decision, issues: [...new Set(issues)] };
}

export function triageRows(rows) {
  return rows.map(row => ({ row, decision: triageCase(row) }));
}
