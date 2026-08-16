import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnalysisContext, buildProgrammeScreeningContext, buildProgrammeScreeningProjects, ensureProgrammeScreeningRecall, limitProgrammeScreening, mergeProgrammeScreening, normalizeProgrammeScreening, selectAssessmentEvidence, validateScreeningRecall } from "./analysis-service.mjs";
import { insertCases, openCaseStore } from "./collector/store.mjs";
import { programmeMaster } from "./master-data.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "admission-analysis-"));
const dbPath = join(tempDir, "cases.sqlite");
const db = openCaseStore(dbPath);
try {
  const base = {
    targetInstitutionId: "cuhk",
    targetProgrammeId: "cuhk-ee",
    targetUniversity: "香港中文大学",
    targetProgramme: "MSc in Electronic Engineering",
    targetProgrammeEnglishRaw: "MSc in Electronic Engineering",
    offerYear: 2026,
    undergraduateInstitutionId: "cumt",
    undergraduateUniversity: "中国矿业大学",
    undergraduateMajor: "自动化",
    gpaRaw: "85 / 100",
    gpaScale: "PERCENT_100",
    gpa100: 85,
    languageTest: "IELTS",
    languageScale: "IELTS_9",
    languageScore: 7,
    internships: [], workExperience: [], research: [], competitions: [], awards: [],
    patents: [], projects: [], experiences: [], auxiliaryScores: [], sourceEvidence: {},
    sourcePublishedAt: null, sourceUrl: "https://example.com/sqlite-case",
    collectedAt: "2026-08-11T00:00:00.000Z",
    completenessScore: 100, issues: []
  };
  insertCases(db, [
    { ...base, fingerprint: "sqlite-approved", reviewStatus: "approved" },
    { ...base, fingerprint: "sqlite-pending", undergraduateUniversity: "清华大学", sourceUrl: "https://example.com/sqlite-pending", reviewStatus: "pending" }
  ]);
} finally {
  db.close();
}

try {
  const context = buildAnalysisContext({
    profile: { schoolTier: 2, major: "automation", gpaScale: "100", gpaValue: 85, languageTest: "IELTS", language: 7, courseTags: ["math", "control"] },
    regions: ["香港"],
    fields: ["electronic"]
  }, { dbPath });
  const screeningContext = buildProgrammeScreeningContext({
    profile: { major: "automation", courseTags: ["math", "control"] },
    regions: ["香港"],
    fields: ["electronic"]
  }, { dbPath });
  assert.ok(screeningContext.retrieved.length < programmeMaster.filter(programme => programme.active !== false).length, "The first stage should exclude programmes outside the requested regions and fields before calling the model");
  assert.ok(screeningContext.retrieved.length <= 16, "The first-stage model should only receive the highest-relevance local candidates");
  assert.ok(screeningContext.retrieved.every(entry => entry.retrieval.eligible), "Every project sent to first-stage screening must satisfy the user's regions and requested directions");
  assert.ok(screeningContext.retrieved.every(entry => entry.programme.institutionId), "Every first-stage candidate must retain its institution identity for school coverage");
  assert.ok(screeningContext.retrieved.every(entry => entry.programme.cases.length === 0), "The first stage must not load cases");
  assert.ok(screeningContext.retrieved.flatMap(entry => entry.documents).every(document => document.provenance !== "public-case"), "Project screening must use official documents only");
  const cards = buildProgrammeScreeningProjects(screeningContext.retrieved);
  assert.equal(cards.length, screeningContext.retrieved.length, "Card screening should include every programme");
  assert.ok(cards.every(project => project.officialCard && !project.officialEvidence), "Card screening must not include full official documents");
  const recall = ensureProgrammeScreeningRecall({ selectedProgrammeIds: [], decisions: {} }, screeningContext.retrieved, {
    profileMajor: "automation", requestedFields: ["electronic", "communication"], maximum: 8
  });
  assert.ok(recall.selectedProgrammeIds.length >= 1, "Screening must retain an obvious requested-direction anchor");
  assert.ok(recall.selectedProgrammeIds.length <= 8, "Recall protection must respect the screening cap");

  const directionChecks = [
    { id: "communication", major: "communication", fields: ["communication"], courseTags: ["communication", "signal"] },
    { id: "integrated-circuit", major: "electronic", fields: ["integrated-circuit"], courseTags: ["electronics", "embedded"] },
    { id: "computer", major: "computer", fields: ["computer"], courseTags: ["programming", "software"] },
    { id: "biology", major: "biology", fields: ["biology"], courseTags: [] }
  ];
  for (const check of directionChecks) {
    const directionContext = buildProgrammeScreeningContext({
      profile: { major: check.major, courseTags: check.courseTags },
      regions: ["香港", "新加坡"],
      fields: check.fields
    }, { dbPath, maximumCandidates: 16 });
    assert.ok(directionContext.retrieved.some(entry => entry.programme.focusTags?.includes(check.fields[0])
      || (check.fields[0] === "integrated-circuit" && entry.programme.focusTags?.some(tag => ["integrated-circuit", "semiconductor"].includes(tag)))), `${check.id} direction must enter the first-stage candidate pool`);
    const protectedSelection = ensureProgrammeScreeningRecall({ selectedProgrammeIds: [], decisions: {} }, directionContext.retrieved, {
      profileMajor: check.major, requestedFields: check.fields, maximum: 8
    });
    assert.ok(protectedSelection.selectedProgrammeIds.some(id => {
      const entry = directionContext.retrievalById[id];
      return entry?.programme.focusTags?.includes(check.fields[0])
        || (check.fields[0] === "integrated-circuit" && entry?.programme.focusTags?.some(tag => ["integrated-circuit", "semiconductor"].includes(tag)));
    }), `${check.id} direction must survive local recall protection`);
  }
  const regionalCoverageChecks = [
    { field: "law", major: "law", expectedInstitution: "nus" },
    { field: "media", major: "media", expectedInstitution: "ntu" },
    { field: "architecture", major: "architecture", expectedInstitution: "nus" }
  ];
  for (const check of regionalCoverageChecks) {
    const directionContext = buildProgrammeScreeningContext({
      profile: { major: check.major, courseTags: [] },
      regions: ["香港", "新加坡"],
      fields: [check.field]
    }, { dbPath, maximumCandidates: 16 });
    assert.ok(directionContext.retrieved.some(entry => entry.programme.institutionId === check.expectedInstitution), `${check.field} candidate pool must retain a relevant Singapore programme`);
  }
  const freshLawContext = buildProgrammeScreeningContext({
    profile: { major: "law", courseTags: [] }, regions: ["香港"], fields: ["law"]
  }, { dbPath, maximumCandidates: 16 });
  assert.ok(freshLawContext.retrieved.every(entry => !/executive master|\bemba\b|\bmba\b/i.test(`${entry.programme.nameEn || ""} ${entry.programme.nameZh || ""}`)), "Fresh applicants must not receive executive or MBA projects that normally require professional experience");
  const architectureAudienceContext = buildProgrammeScreeningContext({
    profile: { major: "architecture", courseTags: [] }, regions: ["香港", "新加坡"], fields: ["architecture", "design"]
  }, { dbPath, maximumCandidates: 16 });
  assert.ok(architectureAudienceContext.retrieved.every(entry => !/adb\W*japan scholarship|for hk applicants/i.test(`${entry.programme.nameEn || ""} ${entry.programme.nameZh || ""}`)), "General applicants must not receive restricted scholarship or Hong Kong-resident tracks");
  const statisticsContext = buildProgrammeScreeningContext({
    profile: { major: "statistics", courseTags: ["statistics", "probability", "linear-algebra", "python"] },
    regions: ["香港", "新加坡"],
    fields: ["data", "business"]
  }, { dbPath, maximumCandidates: 16 });
  assert.ok(statisticsContext.retrieved.some(entry => /statistics/i.test(entry.programme.nameEn || "")), "A statistics applicant must receive a statistics-labelled project in the first-stage candidate pool");
  const full = buildProgrammeScreeningProjects(screeningContext.retrieved, { fullEvidence: true, programmeIds: ["cuhk-ee"] });
  assert.equal(full.length, 1, "Full review should only include uncertain programme IDs");
  assert.ok(full[0].officialEvidence?.length > 0, "Full review must include official documents");
  const merged = mergeProgrammeScreening(
    { selectedProgrammeIds: ["cuhk-ee", "hkust-ee"], programmeDecisions: { "cuhk-ee": { decision: "include" }, "hkust-ee": { decision: "uncertain" } }, configured: true },
    { selectedProgrammeIds: ["hkust-ee"], programmeDecisions: { "hkust-ee": { decision: "include" } }, configured: true },
    screeningContext.retrieved
  );
  assert.equal(merged.selectedProgrammeIds.includes("cuhk-ee"), true, "Merged screening must keep card includes");
  assert.equal(merged.selectedProgrammeIds.includes("hkust-ee"), true, "Merged screening must resolve uncertain projects");
  const screening = normalizeProgrammeScreening({ selectedProgrammeIds: ["cuhk-ee", "not-real"] }, screeningContext.retrieved);
  assert.equal(screening.selectedProgrammeIds.includes("cuhk-ee"), true, "Screening must keep known selected programme IDs");
  assert.equal(screening.selectedProgrammeIds.includes("not-real"), false, "Screening must reject unknown programme IDs");
  const broadScreening = normalizeProgrammeScreening({ selectedProgrammeIds: ["cuhk-ee"], programmeDecisions: { "hkust-ee": { decision: "uncertain" }, "cuhk-mae": { decision: "exclude" } } }, screeningContext.retrieved);
  assert.equal(broadScreening.selectedProgrammeIds.includes("hkust-ee"), true, "Broad screening must keep eligible non-excluded uncertain programmes");
  assert.equal(broadScreening.selectedProgrammeIds.includes("cuhk-mae"), false, "Broad screening may exclude an explicitly incompatible programme");
  const conflictScreening = normalizeProgrammeScreening({ selectedProgrammeIds: ["cuhk-ee"], programmeDecisions: { "cuhk-ee": { decision: "exclude" } } }, screeningContext.retrieved);
  assert.equal(conflictScreening.selectedProgrammeIds.includes("cuhk-ee"), false, "Explicit exclusion must override a selected ID");
  assert.equal(broadScreening.selectedProgrammeIds.includes("hku-eee"), false, "A valid screening response must not silently restore omitted programmes");
  assert.equal(broadScreening.applied, true, "A valid screening response must activate the candidate restriction");
  const fallbackScreening = normalizeProgrammeScreening({ configured: false }, screeningContext.retrieved);
  assert.equal(fallbackScreening.applied, false, "An unconfigured screening response may fail open for local fallback");
  assert.equal(fallbackScreening.selectedProgrammeIds.length, screeningContext.retrieved.length, "An unconfigured screening response may keep the full catalogue");
  const emptyModelScreening = normalizeProgrammeScreening({ configured: true, programmeDecisions: Object.fromEntries(screeningContext.retrieved.map(entry => [entry.programme.id, { decision: "exclude" }])) }, screeningContext.retrieved);
  assert.equal(emptyModelScreening.applied, true, "A configured model response must activate the candidate restriction even when it selects zero projects");
  assert.equal(emptyModelScreening.selectedProgrammeIds.length, 0, "A configured model response selecting zero projects must remain empty");
  assert.equal(ensureProgrammeScreeningRecall(emptyModelScreening, screeningContext.retrieved, { requestedFields: ["electronic"] }).selectedProgrammeIds.length, 0, "Recall protection must not override an explicit all-exclude model decision");
  const computerContext = buildProgrammeScreeningContext({
    profile: { major: "computer", courseTags: ["programming", "data", "ai"] },
    regions: ["香港", "新加坡"], fields: ["computer", "ai"]
  }, { dbPath });
  assert.ok(computerContext.retrievalById["cuhk-cs"], "The first stage catalogue must include master-data-only programmes such as CUHK CS");
  const recallCheck = validateScreeningRecall(computerContext.retrieved, {
    fields: ["computer", "ai", "data"],
    profileMajor: "computer"
  });
  assert.equal(recallCheck.pass, true, "The screening candidate pool must retain every requested computer direction and the undergraduate-major anchor");
  const modelSelection = ["cuhk-cs", "nus-mcomp-ai", "hkust-bdt", "cityu-business-data-analytics", "cityu-cie", "ntu-financial-technology", "nus-biomedical-informatics", "ntu-cca", "cityu-eie"];
  const modelDecisions = Object.fromEntries(modelSelection.map(id => [id, { decision: "include", directionFit: id === "ntu-cca" ? "adjacent" : "direct" }]));
  const limited = limitProgrammeScreening({ ...normalizeProgrammeScreening({
    selectedProgrammeIds: modelSelection, programmeDecisions: modelDecisions
  }, computerContext.retrieved), profileMajor: "computer" }, computerContext.retrieved);
  assert.ok(limited.selectedProgrammeIds.length <= 8, "The first stage must enforce the 8-project ceiling locally without padding ineligible projects");
  assert.ok(limited.selectedProgrammeIds.includes("cuhk-cs"), "A direct computer-major match must survive the candidate ceiling");
  assert.ok(limited.selectedProgrammeIds.every(id => computerContext.retrievalById[id].retrieval.eligible), "The local recall guard must not restore programmes outside the requested regions or fields");
  assert.equal(limited.selectedProgrammeIds.includes("ntu-electronics"), false, "A computer applicant must not regain a specialised IC programme through a broad major tag");
  assert.equal(limited.selectedProgrammeIds.length, 8, "The local cap should pad available eligible candidates to eight projects");
  assert.ok(modelSelection.filter(id => id !== "ntu-cca" && computerContext.retrievalById[id]?.retrieval.eligible)
    .every(id => limited.selectedProgrammeIds.includes(id)), "Padding must preserve eligible direct matches");
  const shortSelection = limitProgrammeScreening(normalizeProgrammeScreening({ selectedProgrammeIds: ["cuhk-cs", "nus-mcomp-ai"], programmeDecisions: { "cuhk-cs": { decision: "include", directionFit: "direct" }, "nus-mcomp-ai": { decision: "include", directionFit: "direct" } } }, computerContext.retrieved), computerContext.retrieved);
  assert.equal(shortSelection.selectedProgrammeIds.length, 8, "The first stage should pad an available shortlist to eight projects");
  assert.ok(shortSelection.selectedProgrammeIds.includes("cuhk-cs") && shortSelection.selectedProgrammeIds.includes("nus-mcomp-ai"), "Padding must preserve model-selected direct matches");
  const coverageEntries = ["香港大学", "香港中文大学", "香港科技大学", "香港理工大学", "香港城市大学", "香港浸会大学"].map((school, index) => ({
    programme: { id: `coverage-${index}`, school, university: school, majorTags: ["finance"], focusTags: ["finance"] },
    retrieval: { eligible: true, majorMatch: true, score: 10 - index }
  }));
  const covered = limitProgrammeScreening({ applied: true, selectedProgrammeIds: ["coverage-0"], decisions: { "coverage-0": { decision: "include", directionFit: "direct" } } }, coverageEntries, 8, {
    targetSchools: coverageEntries.slice(0, 5).map(entry => entry.programme.university)
  });
  assert.equal(covered.selectedProgrammeIds.length, 6, "Coverage selection should keep all available projects when fewer than eight exist");
  assert.ok(coverageEntries.slice(0, 5).every(entry => covered.selectedProgrammeIds.includes(entry.programme.id)), "Coverage selection should retain one project per selected school");
  const excludedCoverage = limitProgrammeScreening({
    applied: true,
    selectedProgrammeIds: coverageEntries.slice(0, 4).map(entry => entry.programme.id),
    decisions: Object.fromEntries(coverageEntries.map((entry, index) => [entry.programme.id, {
      decision: index < 4 ? "include" : "exclude",
      directionFit: "direct"
    }]))
  }, coverageEntries, 8);
  assert.equal(excludedCoverage.selectedProgrammeIds.length, 6, "A forced shortlist must use all eligible projects when the model returns fewer than eight");
  assert.ok(coverageEntries.every(entry => excludedCoverage.selectedProgrammeIds.includes(entry.programme.id)), "Default all-school scope should preserve one eligible project per school");
  const emptyCandidateContext = buildAnalysisContext({
    profile: { schoolTier: 2, major: "automation", gpaScale: "100", gpaValue: 85, languageTest: "IELTS", language: 7, courseTags: ["math", "control"] },
    regions: ["香港"],
    fields: ["electronic"]
  }, { dbPath, programmeIds: [], restrictToProgrammeIds: true, includeIneligible: true });
  assert.equal(emptyCandidateContext.retrieved.length, 0, "An applied empty selection must not be mistaken for no filter");
  const candidateContext = buildAnalysisContext({
    profile: { schoolTier: 2, major: "automation", gpaScale: "100", gpaValue: 85, languageTest: "IELTS", language: 7, courseTags: ["math", "control"] },
    regions: ["香港"],
    fields: ["electronic"]
  }, { dbPath, programmeIds: ["cuhk-ee"], includeIneligible: true });
  assert.equal(candidateContext.retrieved.length, 1, "The second stage should load only selected programmes");
  assert.equal(candidateContext.retrieved[0].programme.cases.length, 1, "The second stage should load all approved cases for the selected programme");  const comparison = context.comparisons.find(item => item.programme.id === "cuhk-ee");
  assert.ok(comparison, "The analysis context should include CUHK EE");
  assert.equal(comparison.programme.cases.length, 1, "Only SQLite approved cases may enter analysis");
  assert.equal(comparison.programme.cases[0].fingerprint, "sqlite-approved");
  assert.equal(comparison.result.evidence.caseCount, 1);
  const selectedEvidence = selectAssessmentEvidence(context.retrievalById["cuhk-ee"], comparison.result);
  assert.equal(selectedEvidence.length, 4, "Fixed assessment evidence should include 3 essential programme documents and 1 case document");
  assert.equal(selectedEvidence.filter(document => document.provenance === "public-case").length, 1);
  assert.ok(context.retrievalById["cuhk-ee"].documents.some(document => document.id.endsWith(":case:sqlite-approved")), "Approved SQLite cases must become RAG evidence");
  const stableEvidenceEntry = {
    documents: [
      { id: "case:old", provenance: "public-case", metadata: { fingerprint: "old", offerYear: 2023, yearWeight: 0.25 } },
      { id: "case:new", provenance: "public-case", metadata: { fingerprint: "new", offerYear: 2026, yearWeight: 1 } },
      { id: "case:middle", provenance: "public-case", metadata: { fingerprint: "middle", offerYear: 2025, yearWeight: 0.5 } }
    ]
  };
  assert.deepEqual(
    selectAssessmentEvidence(stableEvidenceEntry, { nearest: { fingerprint: "old" } }).map(document => document.id),
    ["case:new", "case:middle", "case:old"],
    "Evidence selection must prioritize newer case years before nearest-case ties"
  );
  assert.deepEqual(
    selectAssessmentEvidence(stableEvidenceEntry, { nearest: { fingerprint: "old" } }).map(document => document.id),
    ["case:new", "case:middle", "case:old"],
    "Repeated evidence selection must return the same document IDs"
  );
  assert.ok(programmeMaster.every(programme => !Object.hasOwn(programme, "cases")), "Static programme metadata must not contain analysis cases");
  const repeated = buildAnalysisContext({
    profile: { schoolTier: 2, major: "automation", gpaScale: "100", gpaValue: 85, languageTest: "IELTS", language: 7, courseTags: ["math", "control"] },
    regions: ["香港"],
    fields: ["electronic"]
  }, { dbPath });
  assert.deepEqual(
    repeated.comparisons.map(item => item.result.evidence),
    context.comparisons.map(item => item.result.evidence),
    "Repeated fixed-evidence analysis must be stable"
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("analysis service checks passed");
