import { openCaseStore } from "./store.mjs";
import { resolveInstitution, resolveProgramme } from "../master-data.mjs";
import { resolveReferenceInstitution } from "./reference-store.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";

const db = openCaseStore();
const rows = db.prepare("SELECT * FROM cases ORDER BY collected_at ASC, fingerprint ASC").all();
const update = db.prepare(`UPDATE cases SET target_institution_id=?, target_programme_id=?, undergraduate_institution_id=?, offer_year=?, review_status=?, issues_json=?, evidence_json=?, raw_json=? WHERE fingerprint=?`);
const counts = { approved: 0, pending: 0, "needs-review": 0, rejected: 0 };
const changes = [];
const parse = value => { try { return JSON.parse(value || "[]"); } catch { return []; } };

try {
  db.exec("BEGIN");
  for (const row of rows) {
    const targetInstitution = resolveInstitution(row.target_university);
    const targetProgramme = resolveProgramme({
      universityName: row.target_university,
      programmeName: row.target_programme,
      programmeEnglishName: row.target_programme_en_raw
    });
    const undergraduateInstitution = resolveInstitution(row.undergraduate_university)
      || resolveReferenceInstitution(row.undergraduate_university);
    const evidence = parse(row.evidence_json || "{}");
    const publicationYear = Number(String(row.source_published_at || "").match(/20\d{2}/)?.[0]) || null;
    const offerYear = row.offer_year || publicationYear;
    if (!row.offer_year && publicationYear) {
      evidence.inferred = { ...evidence.inferred, offerYear: { value: publicationYear, confidence: "medium", basis: "source-publication-year-proxy", sourcePublishedAt: row.source_published_at } };
    }
    const issues = parse(row.issues_json || "{}");
    const reviewRow = {
      ...row,
      targetProgrammeId: targetProgramme?.id || row.target_programme_id || null,
      undergraduateInstitutionId: undergraduateInstitution?.id || row.undergraduate_institution_id || null,
      undergraduateUniversity: row.undergraduate_university,
      undergraduateMajor: row.undergraduate_major,
      offerYear,
      gpaRaw: row.gpa_raw,
      languageTest: row.language_test,
      languageScore: row.language_score,
      issues,
      sourceEvidence: evidence
      ,sourcePublishedAt: row.source_published_at
    };
    const decision = applyReviewPolicy(reviewRow);
    const nextIssues = decision.issues;
    const raw = parse(row.raw_json || "{}");
    const nextRaw = {
      ...raw,
      targetInstitutionId: targetInstitution?.id || raw.targetInstitutionId || row.target_institution_id || null,
      targetProgrammeId: targetProgramme?.id || raw.targetProgrammeId || row.target_programme_id || null,
      undergraduateInstitutionId: undergraduateInstitution?.id || raw.undergraduateInstitutionId || row.undergraduate_institution_id || null,
      offerYear,
      sourcePublishedAt: row.source_published_at || raw.sourcePublishedAt || null,
      sourceEvidence: evidence,
      undergraduateInstitutionSource: undergraduateInstitution?.source || raw.undergraduateInstitutionSource || null,
      reviewStatus: decision.status,
      issues: nextIssues,
      reviewPolicy: { status: decision.status, confidence: decision.confidence, reason: decision.reason, checkedAt: new Date().toISOString() }
    };
    update.run(
      targetInstitution?.id || row.target_institution_id || null,
      targetProgramme?.id || row.target_programme_id || null,
      undergraduateInstitution?.id || row.undergraduate_institution_id || null,
      offerYear,
      decision.status,
      JSON.stringify(nextIssues),
      JSON.stringify(evidence),
      JSON.stringify(nextRaw),
      row.fingerprint
    );
    counts[decision.status] += 1;
    if (decision.status !== row.review_status || targetProgramme?.id !== row.target_programme_id || undergraduateInstitution?.id !== row.undergraduate_institution_id) {
      changes.push({ fingerprint: row.fingerprint, from: row.review_status, to: decision.status, targetProgrammeId: targetProgramme?.id || row.target_programme_id || null, undergraduateInstitutionId: undergraduateInstitution?.id || row.undergraduate_institution_id || null, reason: decision.reason });
    }
  }
  db.exec("COMMIT");
  console.log(JSON.stringify({ scanned: rows.length, counts, changed: changes.length, changes: changes.slice(0, 40) }, null, 2));
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  throw error;
} finally {
  db.close();
}
