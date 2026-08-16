import { extractMastermateBackground } from "./mastermate-parser.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";
import { normalizeCandidate } from "./agent.mjs";
import { resolveInstitution } from "../master-data.mjs";
import { resolveReferenceInstitution } from "./reference-store.mjs";
import { openCaseStore } from "./store.mjs";

const isSuspiciousGpa = value => {
  const text = String(value || "").normalize("NFKC").trim();
  return !text || /^(?:985|211|985&211|211&985|双一流|双非|海本|19\d{2}|20\d{2})$/i.test(text) || /^\d$/.test(text);
};

const isSuspiciousMajor = value => /GPA|均分|平均分|绩点|雅思|IELTS|托福|TOEFL|GRE|GMAT|申请优势|优势总结|实习|研究经历|科研|论文|奖学金|工作经验/i.test(String(value || ""));

function sourceText(raw) {
  const experiences = Array.isArray(raw?.experiences) ? raw.experiences : [];
  const original = experiences.find(item => item?.raw)?.raw;
  return String(original || experiences.map(item => item?.raw).filter(Boolean).join(" ") || "").normalize("NFKC");
}

function buildRepairCandidate(row) {
  const raw = JSON.parse(row.raw_json || "{}");
  const parsed = extractMastermateBackground(sourceText(raw));
  const oldGpa = row.gpa_raw;
  const oldMajor = row.undergraduate_major;
  const undergraduateUniversity = parsed.institution || (isSuspiciousMajor(row.undergraduate_university) ? null : row.undergraduate_university);
  const undergraduateMajor = parsed.major || (isSuspiciousMajor(oldMajor) ? null : oldMajor);
  const gpaRaw = parsed.gpaRaw || (isSuspiciousGpa(oldGpa) ? null : oldGpa);
  const gpaScale = parsed.gpaRaw ? parsed.gpaScale : (gpaRaw ? row.gpa_scale || "UNKNOWN" : "UNKNOWN");
  const gpa100 = parsed.gpaRaw ? parsed.gpa100 : (gpaRaw && !isSuspiciousGpa(oldGpa) ? row.gpa100 : null);
  const undergraduateInstitution = resolveInstitution(undergraduateUniversity) || resolveReferenceInstitution(undergraduateUniversity);
  const sourceEvidence = { ...(raw.sourceEvidence || {}) };
  sourceEvidence.matched = {
    ...(sourceEvidence.matched || {}),
    targetUniversity: Boolean(row.target_university),
    targetProgramme: Boolean(row.target_programme_id || row.target_programme),
    undergraduateUniversity: Boolean(undergraduateUniversity),
    undergraduateMajor: Boolean(undergraduateMajor),
    gpaRaw: Boolean(gpaRaw),
    offerYear: Boolean(row.offer_year)
  };
  sourceEvidence.missing = Object.entries(sourceEvidence.matched)
    .filter(([, matched]) => !matched)
    .map(([field]) => field);
  sourceEvidence.repair = {
    ...(sourceEvidence.repair || {}),
    parser: "mastermate-background-v2",
    checkedAt: new Date().toISOString(),
    sourceText: sourceText(raw).slice(0, 1200),
    changed: {
      undergraduateUniversity: undergraduateUniversity !== row.undergraduate_university,
      undergraduateMajor: undergraduateMajor !== row.undergraduate_major,
      gpaRaw: gpaRaw !== row.gpa_raw,
      gpaScale: gpaScale !== row.gpa_scale,
      gpa100: gpa100 !== row.gpa100
    }
  };
  const candidate = {
    ...raw,
    targetInstitutionId: row.target_institution_id,
    targetProgrammeId: row.target_programme_id,
    targetUniversity: row.target_university,
    targetProgramme: row.target_programme,
    targetProgrammeEnglishRaw: row.target_programme_en_raw,
    offerYear: row.offer_year,
    undergraduateUniversity,
    undergraduateMajor,
    undergraduateInstitutionId: undergraduateInstitution?.id || null,
    gpaRaw,
    gpaScale,
    gpa100,
    languageTest: row.language_test,
    languageScore: row.language_score,
    sourcePublishedAt: row.source_published_at,
    sourceEvidence,
    issues: [],
    fingerprint: row.fingerprint
  };
  const review = applyReviewPolicy(candidate);
  const completenessScore = [candidate.targetUniversity || candidate.targetProgramme, undergraduateUniversity, undergraduateMajor, gpaRaw, candidate.offerYear].filter(Boolean).length * 20;
  const repairedRaw = {
    ...raw,
    ...candidate,
    fingerprint: row.fingerprint,
    reviewStatus: review.status,
    completenessScore,
    qualityScore: completenessScore,
    issues: review.issues || [],
    repairAudit: {
      ...(raw.repairAudit || {}),
      previous: {
        undergraduateInstitutionId: row.undergraduate_institution_id,
        undergraduateUniversity: row.undergraduate_university,
        undergraduateMajor: row.undergraduate_major,
        gpaRaw: row.gpa_raw,
        gpaScale: row.gpa_scale,
        gpa100: row.gpa100,
        reviewStatus: row.review_status,
        issues: JSON.parse(row.issues_json || "[]")
      },
      parser: "mastermate-background-v2",
      checkedAt: new Date().toISOString()
    },
    reviewPolicy: review
  };
  return { row, candidate, review, completenessScore, repairedRaw };
}

const db = openCaseStore();
const rows = db.prepare(`
  SELECT * FROM cases
  WHERE source_url LIKE '%mastermate.cn%'
    AND offer_year >= 2021
`).all();

const update = db.prepare(`
  UPDATE cases SET
    undergraduate_institution_id=?, undergraduate_university=?, undergraduate_major=?,
    gpa_raw=?, gpa_scale=?, gpa100=?, quality_score=?, review_status=?,
    issues_json=?, evidence_json=?, raw_json=?
  WHERE fingerprint=?
`);

const counts = {
  examined: rows.length,
  changed: 0,
  gpaFixed: 0,
  majorFixed: 0,
  institutionFixed: 0,
  scaleFixed: 0,
  approvedAfter: 0,
  needsReviewAfter: 0,
  rejectedAfter: 0,
  pendingAfter: 0,
  approvedLost: 0,
  suspiciousRemaining: 0
};

db.exec("BEGIN");
try {
  for (const row of rows) {
    const result = buildRepairCandidate(row);
    const { candidate, review, completenessScore, repairedRaw } = result;
    const changed = candidate.gpaRaw !== row.gpa_raw
      || candidate.gpaScale !== row.gpa_scale
      || candidate.gpa100 !== row.gpa100
      || candidate.undergraduateMajor !== row.undergraduate_major
      || candidate.undergraduateUniversity !== row.undergraduate_university
      || candidate.undergraduateInstitutionId !== row.undergraduate_institution_id
      || review.status !== row.review_status;
    if (changed) counts.changed += 1;
    if (candidate.gpaRaw !== row.gpa_raw || candidate.gpaScale !== row.gpa_scale || candidate.gpa100 !== row.gpa100) counts.gpaFixed += 1;
    if (candidate.undergraduateMajor !== row.undergraduate_major) counts.majorFixed += 1;
    if (candidate.undergraduateUniversity !== row.undergraduate_university) counts.institutionFixed += 1;
    if (candidate.gpaScale !== row.gpa_scale) counts.scaleFixed += 1;
    if (row.review_status === "approved" && review.status !== "approved") counts.approvedLost += 1;
    if (review.status === "approved") counts.approvedAfter += 1;
    if (review.status === "needs-review") counts.needsReviewAfter += 1;
    if (review.status === "rejected") counts.rejectedAfter += 1;
    if (review.status === "pending") counts.pendingAfter += 1;
    if (isSuspiciousGpa(candidate.gpaRaw) || isSuspiciousMajor(candidate.undergraduateMajor)) counts.suspiciousRemaining += 1;
    update.run(
      candidate.undergraduateInstitutionId,
      candidate.undergraduateUniversity,
      candidate.undergraduateMajor,
      candidate.gpaRaw,
      candidate.gpaScale,
      candidate.gpa100,
      completenessScore,
      review.status,
      JSON.stringify(review.issues || []),
      JSON.stringify(candidate.sourceEvidence || {}),
      JSON.stringify(repairedRaw),
      row.fingerprint
    );
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

console.log(JSON.stringify(counts, null, 2));
