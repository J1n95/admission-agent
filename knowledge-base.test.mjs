import assert from "node:assert/strict";
import { knowledgeStatus, retrieveProgrammeKnowledge } from "./knowledge-base.mjs";
import { programmes } from "./data.mjs";
import { programmeMaster } from "./master-data.mjs";
import { listProgrammeDocuments, openCaseStore } from "./collector/store.mjs";

const approvedCases = [
  {
    fingerprint: "approved-1", targetProgrammeId: "cuhk-ee", offerYear: 2026,
    undergraduateInstitutionId: "nju", undergraduateUniversity: "南京大学", undergraduateMajor: "电子信息科学与技术",
    gpaRaw: "4.02", gpaScale: "UNKNOWN", gpa100: null,
    languageTest: "IELTS", languageScale: "IELTS_9", languageScore: 7,
    internships: [], workExperience: [], research: [], competitions: ["电子设计竞赛"], awards: [], patents: [], projects: [],
    sourceUrl: "https://example.com/case-1", reviewStatus: "approved"
  },
  {
    fingerprint: "approved-2", targetProgrammeId: "hkust-ee", offerYear: 2025,
    undergraduateInstitutionId: "cumt", undergraduateUniversity: "中国矿业大学", undergraduateMajor: "自动化",
    gpaRaw: "85 / 100", gpaScale: "PERCENT_100", gpa100: 85,
    languageTest: "TOEFL", languageScale: "TOEFL_IBT_120", languageScore: 95,
    internships: ["控制实习"], workExperience: [], research: [], competitions: [], awards: [], patents: [], projects: [],
    sourceUrl: "https://example.com/case-2", reviewStatus: "approved"
  }
];

const documentDb = openCaseStore(":memory:");
try {
  const programmeDocuments = listProgrammeDocuments(documentDb);
  assert.equal(programmeDocuments.length, programmes.length * 8, "Official programme documents must be stored in SQLite");
  assert.ok(programmeDocuments.every(document => document.text && document.sources.length > 0), "Stored official documents must keep text and source links");
} finally {
  documentDb.close();
}
const hongKong = retrieveProgrammeKnowledge({
  regions: ["香港"],
  fields: ["electronic"],
  profile: { major: "automation", courseTags: ["control", "electronics", "signal"] }
}, { approvedCases });

const electronicCoreTags = new Set(["electronic", "integrated-circuit", "semiconductor", "embedded"]);
assert.equal(hongKong.length, programmeMaster.filter(programme => programme.active !== false && programme.region === "香港" && (programme.focusTags || []).some(tag => electronicCoreTags.has(tag))).length, "Hong Kong electronic retrieval should keep every programme whose core direction is electronic");
assert.ok(hongKong.every(entry => entry.programme.region === "香港"), "Region filtering must be exact");
const seededProgrammeIds = new Set(programmes.map(programme => programme.id));
assert.ok(hongKong.filter(entry => seededProgrammeIds.has(entry.programme.id)).every(entry => entry.documents.length >= 8), "Seeded programmes need complete official sections");
assert.ok(hongKong.flatMap(entry => entry.documents).every(document => document.sources.length > 0), "Every document must remain linked to a source");
assert.ok(hongKong.flatMap(entry => entry.documents).some(document => document.provenance === "public-case"), "Admission cases must be retrievable evidence documents");
const cuhkCase = hongKong.find(entry => entry.programme.id === "cuhk-ee").documents.find(document => document.provenance === "public-case");
const hkustCase = hongKong.find(entry => entry.programme.id === "hkust-ee").documents.find(document => document.provenance === "public-case");
assert.equal(cuhkCase.metadata.yearWeight, 1, "The newest approved case must have full year weight");
assert.equal(hkustCase.metadata.yearWeight, 0.833, "A case one year older must have lower year weight");
const cuhkAnalysisCase = hongKong.find(entry => entry.programme.id === "cuhk-ee").programme.cases[0];
assert.deepEqual(cuhkAnalysisCase.experienceSummary.internships, { count: 0, level: "页面未提及" }, "Undisclosed internships must render as an approximate zero count instead of an empty disclosure label");
assert.equal(cuhkAnalysisCase.experienceSummary.competitions.count, 1, "Disclosed competitions must render as an approximate item count");
assert.ok(hongKong[0].retrieval.score >= hongKong.at(-1).retrieval.score, "Results must be ordered by relevance without hiding eligible programmes");

const marketing = retrieveProgrammeKnowledge({
  regions: ["香港"], fields: ["marketing"], profile: { major: "marketing", courseTags: [] }
}, { approvedCases: [] });
assert.equal(marketing.length, 12, "Marketing retrieval should include the twelve explicit Hong Kong marketing programmes only");
assert.ok(marketing.every(entry => (entry.programme.focusTags || []).includes("marketing")), "Marketing retrieval must not expand to unrelated general business programmes");

const biology = retrieveProgrammeKnowledge({
  regions: ["香港", "新加坡"], fields: ["biology"], profile: { major: "biology", courseTags: [] }
}, { approvedCases: [] });
assert.ok(biology.length >= 7, "Biology retrieval should expose the life-science programmes in the catalogue");
assert.ok(biology.some(entry => entry.programme.nameEn.includes("Biodiversity")), "Biology retrieval should include biodiversity programmes");
assert.ok(biology.every(entry => (entry.programme.focusTags || []).some(tag => ["biology", "life-science", "bioscience", "biotechnology"].includes(tag))), "Biology retrieval must not expand to unrelated programmes");

const hkustOnly = retrieveProgrammeKnowledge({
  regions: ["香港"],
  targetSchools: ["香港科技大学"],
  fields: ["electronic"],
  profile: { major: "electronic", courseTags: ["electronics"] }
}, { approvedCases });
assert.ok(hkustOnly.length > 0, "School scope should retain matching programmes");
assert.ok(hkustOnly.every(entry => entry.programme.university === "香港科技大学"), "School scope must exclude other universities");

const status = knowledgeStatus({ approvedCases });
assert.equal(status.programmes, programmeMaster.filter(programme => programme.active !== false).length, "The status endpoint must count all catalogue programmes");
assert.ok(status.documents >= programmes.length * 8, "The knowledge base should expose programme sections and approved case documents");
assert.equal(status.caseDocuments, 2, "Only explicitly approved SQLite cases may become retrievable documents");
assert.equal(status.approvedCases, 2);
assert.ok(status.officialSources >= 18, "Official source records must be versioned separately from prose");

console.log("knowledge-base checks passed");
