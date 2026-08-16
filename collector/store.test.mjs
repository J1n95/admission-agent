import assert from "node:assert/strict";
import { caseCoverage, caseIdentityKey, compareCaseFields, completeAnalysisRecord, createAnalysisRecord, getCase, getCrawlSource, getCrawlSourceScope, getExtractionCache, getOcrCache, getProgrammeScope, getProgrammeStatus, insertCases, listAnalysisRecords, listApprovedCases, listCases, listMasterData, listProgrammeScopes, listProgrammeStatuses, openCaseStore, recordCrawlSource, reassignCaseProgramme, replaceCasesForSource, reviewCase, saveAnalysisFeedback, saveExtractionCache, saveOcrCache, saveProgrammeScope, saveProgrammeStatus, startAgentRun, storeStatus, updateCaseFields } from "./store.mjs";

const db = openCaseStore(":memory:");
const programmeColumns = db.prepare("PRAGMA table_info(programmes)").all().map(column => column.name);
for (const column of ["discovery_terms_json", "source_search_terms_json", "strict_match_terms_json", "search_entrypoints_json"]) {
  assert.ok(programmeColumns.includes(column), `Programme search profile column missing: ${column}`);
}
assert.ok(db.prepare("PRAGMA table_info(programme_status)").all().some(column => column.name === "status"));
createAnalysisRecord(db, { id: "analysis-1", applicant: { profile: { university: "测试大学" } }, createdAt: "2026-08-16T00:00:00.000Z" });
completeAnalysisRecord(db, "analysis-1", { result: { results: [{ probability: 65 }] }, completedAt: "2026-08-16T00:01:00.000Z" });
assert.equal(saveAnalysisFeedback(db, "analysis-1", { usefulness: "very", valuable: "probability", clarity: "clear" }), true);
assert.equal(saveAnalysisFeedback(db, "missing-analysis", { usefulness: "none" }), false);
assert.equal(listAnalysisRecords(db, 10)[0].feedback.usefulness, "very");
assert.equal(listAnalysisRecords(db, 10)[0].result.results[0].probability, 65);
saveProgrammeStatus(db, { programmeId: "cuhk-ee", status: "current-history-unknown", confidence: 0.72, officialUrl: "https://example.com/cuhk-ee", historyYears: ["2026-27"], reason: "test" });
assert.equal(getProgrammeStatus(db, "cuhk-ee").status, "current-history-unknown");
assert.equal(listProgrammeStatuses(db, ["current-history-unknown"]).length, 1);
saveProgrammeScope(db, { programmeId: "cuhk-ee", scope: "target", confidence: 0.9, reason: "test" });
assert.equal(getProgrammeScope(db, "cuhk-ee").scope, "target");
assert.equal(listProgrammeScopes(db, ["target"]).length, 1);
const candidate = {
  fingerprint: "case-1",
  targetInstitutionId: "cuhk",
  targetProgrammeId: "cuhk-ee",
  undergraduateInstitutionId: null,
  targetUniversity: "香港大学",
  targetProgramme: "人工智能",
  targetProgrammeEnglishRaw: "Master of Science in Artificial Intelligence",
  offerYear: 2026,
  undergraduateUniversity: "某大学",
  undergraduateMajor: "自动化",
  gpaRaw: "85 / 100",
  gpaScale: "PERCENT_100",
  gpa100: 85,
  languageTest: "TOEFL",
  languageScale: "TOEFL_IBT_120",
  languageScore: 95,
  internships: [], workExperience: [], research: [], competitions: ["电子设计竞赛"], awards: [], patents: ["机器人专利"], projects: ["机器人课程项目"],
  experiences: [{ raw: "机器人专利", category: "patent", result: null }], auxiliaryScores: [{ test: "GRE", scoreRaw: "319" }],
  sourcePublishedAt: null,
  sourceUrl: "https://example.com/case-1",
  collectedAt: "2026-08-09T00:00:00.000Z",
  completenessScore: 83,
  reviewStatus: "pending",
  issues: []
};

assert.equal(insertCases(db, [candidate]).length, 1);
const oldCase = { ...candidate, fingerprint: "old-case", offerYear: 2020, sourceUrl: "https://example.com/old-case", reviewStatus: "approved" };
assert.equal(insertCases(db, [oldCase]).length, 1);
assert.equal(getCase(db, "old-case").reviewStatus, "rejected");
assert.throws(() => reviewCase(db, "old-case", "approved"), /2021/);
assert.equal(insertCases(db, [candidate]).length, 0, "Fingerprint must deduplicate records");
assert.deepEqual(getCase(db, "case-1").sourceUrls, ["https://example.com/case-1"]);
assert.equal(getCase(db, "case-1").sourceRefs[0].comparison.status, "primary");
assert.equal(caseIdentityKey(candidate), caseIdentityKey({ ...candidate, fingerprint: "format-variant", gpaRaw: "GPA85.0" }));
assert.equal(insertCases(db, [{ ...candidate, fingerprint: "format-variant", gpaRaw: "GPA85.0", sourceUrl: "https://other.example/case-1" }]).length, 0, "Identity key must deduplicate formatting variants");
assert.equal(insertCases(db, [{ ...candidate, fingerprint: "scale-variant", gpa100: 86, sourceUrl: "https://third.example/case-1" }]).length, 0, "Raw GPA must prevent a normalization-only duplicate");
assert.deepEqual(getCase(db, "case-1").sourceUrls, ["https://example.com/case-1", "https://other.example/case-1", "https://third.example/case-1"], "Duplicate identity must retain cross-source references");
assert.equal(getCase(db, "case-1").sourceRefs[1].comparison.status, "match");

const upgradeDb = openCaseStore(":memory:");
const unmatched = { ...candidate, fingerprint: "case-upgrade", targetProgrammeId: null, reviewStatus: "needs-review", issues: ["项目未匹配主表"] };
assert.equal(insertCases(upgradeDb, [unmatched]).length, 1);
const upgraded = { ...unmatched, targetProgrammeId: "cuhk-ee", reviewStatus: "approved", issues: [] };
assert.equal(insertCases(upgradeDb, [upgraded]).length, 1, "A better refresh must promote the same fingerprint instead of reporting a duplicate");
assert.equal(getCase(upgradeDb, "case-upgrade").reviewStatus, "approved");
assert.equal(getCase(upgradeDb, "case-upgrade").targetProgrammeId, "cuhk-ee");
const aliasPending = { ...candidate, fingerprint: "alias-pending", targetProgramme: "Alias Programme", targetProgrammeId: null, reviewStatus: "needs-review", issues: ["项目未匹配主表"] };
assert.equal(insertCases(upgradeDb, [aliasPending]).length, 1);
assert.equal(insertCases(upgradeDb, [{ ...aliasPending, fingerprint: "alias-resolved", targetProgrammeId: "cuhk-ee", reviewStatus: "approved", issues: [] }]).length, 1, "A programme alias repair must promote a different fingerprint in place");
assert.equal(getCase(upgradeDb, "alias-pending").reviewStatus, "approved");
assert.equal(getCase(upgradeDb, "alias-pending").targetProgrammeId, "cuhk-ee");
assert.equal(insertCases(upgradeDb, [{ ...upgraded, targetProgrammeId: null, reviewStatus: "needs-review" }]).length, 0, "Automation must not downgrade an approved record");
assert.equal(getCase(upgradeDb, "case-upgrade").reviewStatus, "approved");
const sameIdentityPending = { ...candidate, fingerprint: "same-identity-upgrade", offerYear: 2025, sourceUrl: "https://example.com/same-identity", reviewStatus: "needs-review", issues: ["待复核"] };
assert.equal(insertCases(upgradeDb, [sameIdentityPending]).length, 1);
assert.equal(insertCases(upgradeDb, [{ ...sameIdentityPending, reviewStatus: "approved", issues: [] }]).length, 1);
assert.equal(getCase(upgradeDb, "same-identity-upgrade").reviewStatus, "approved");
upgradeDb.close();
assert.deepEqual(compareCaseFields(candidate, { ...candidate, gpa100: 86, sourceUrl: "https://third.example/case-1" }).conflicts, ["gpa"]);
assert.equal(storeStatus(db).total, 2);
recordCrawlSource(db, { sourceUrl: candidate.sourceUrl, programmeId: candidate.targetProgrammeId });
assert.equal(getCrawlSource(db, candidate.sourceUrl).status, "completed", "Crawl history must be readable for a processed source");
assert.equal(getCrawlSourceScope(db, candidate.sourceUrl, candidate.targetProgrammeId).scoped_count, 0, "Programme-scoped crawl history must be recorded");
recordCrawlSource(db, { sourceUrl: "https://new.example/page", programmeId: "cuhk-ee", extractedCount: 2, scopedCount: 1, queuedCount: 1 });
assert.equal(getCrawlSource(db, "https://new.example/page").queued_count, 1, "New crawl history must be recorded");
assert.equal(getCrawlSourceScope(db, "https://new.example/page", "cuhk-ee").queued_count, 1);
saveExtractionCache(db, {
  sourceUrl: "https://new.example/page",
  pageHash: "hash-1",
  model: "test-model",
  extractionMethod: "llm",
  cases: [{ targetProgrammeId: "cuhk-ee", gpaRaw: "85" }]
});
assert.deepEqual(getExtractionCache(db, "https://new.example/page").cases, [{ targetProgrammeId: "cuhk-ee", gpaRaw: "85" }]);
saveOcrCache(db, {
  sourceUrl: "https://new.example/page",
  pageHash: "html-hash-1",
  model: "test-ocr",
  text: "MSc in Artificial Intelligence"
});
assert.deepEqual(getOcrCache(db, "https://new.example/page").text, "MSc in Artificial Intelligence");
const staleDb = openCaseStore(":memory:");
staleDb.prepare("INSERT INTO agent_runs (id, goal_json, state, started_at) VALUES (?, ?, 'running', ?)")
  .run("stale-run", "{}", "2020-01-01T00:00:00.000Z");
const freshRun = { id: "fresh-run", goal: {}, state: "running", startedAt: new Date().toISOString(), staleAfterMs: 1 };
startAgentRun(staleDb, freshRun);
assert.equal(staleDb.prepare("SELECT state FROM agent_runs WHERE id='stale-run'").get().state, "aborted");
staleDb.close();
assert.equal(listCases(db, 10)[0].languageScale, "TOEFL_IBT_120");
assert.equal(getCase(db, "case-1").gpaScale, "PERCENT_100");
assert.equal(getCase(db, "case-1").languageScore, 95);
assert.equal(getCase(db, "case-1").targetProgrammeEnglishRaw, "Master of Science in Artificial Intelligence");
assert.deepEqual(getCase(db, "case-1").projects, ["机器人课程项目"]);
assert.deepEqual(getCase(db, "case-1").competitions, ["电子设计竞赛"]);
assert.deepEqual(getCase(db, "case-1").patents, ["机器人专利"]);
assert.deepEqual(getCase(db, "case-1").auxiliaryScores, [{ test: "GRE", scoreRaw: "319" }]);
assert.equal(listApprovedCases(db).length, 0);
reviewCase(db, "case-1", "approved", { reviewer: "test", reason: "evidence verified" });
assert.equal(listApprovedCases(db).length, 1);
assert.equal(getCase(db, "case-1").sourceEvidence.reviewAudit[0].reviewer, "test");
assert.throws(() => replaceCasesForSource(db, candidate.sourceUrl, [{ ...candidate, reviewStatus: "pending" }]), /已有审核通过案例/, "Approved evidence must never be overwritten by an automated refresh");
const edited = updateCaseFields(db, "case-1", { undergraduateMajor: "电子信息工程", offerYear: 2025, targetProgrammeId: "cuhk-ee" });
assert.equal(edited.undergraduateMajor, "电子信息工程");
assert.equal(edited.offerYear, 2025);
assert.equal(edited.reviewStatus, "needs-review");
assert.equal(edited.sourceEvidence.reviewAudit.at(-1).action, "edit");
reviewCase(db, "case-1", "approved", { reviewer: "test", reason: "edited fields verified" });
assert.equal(caseCoverage(db, "cuhk-ee").approved, 1);
const reassigned = reassignCaseProgramme(db, "case-1", "cuhk-ee", { reviewer: "test", reason: "programme evidence verified" });
assert.equal(reassigned.targetProgrammeId, "cuhk-ee");
assert.equal(reassigned.sourceEvidence.reviewAudit.at(-1).action, "reassign-programme");
assert.ok(listMasterData(db).institutions.length >= 30);
assert.ok(listMasterData(db).programmes.some(programme => programme.id === "cuhk-ee"));
db.close();

console.log("collector store checks passed");
