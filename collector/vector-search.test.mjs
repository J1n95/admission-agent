import assert from "node:assert/strict";
import { retrieveProgrammeKnowledge } from "../knowledge-base.mjs";
import { cosineSimilarity, hybridEvidenceScore } from "./vector-search.mjs";

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(cosineSimilarity([1], [1, 0]), null);
assert.ok(hybridEvidenceScore(0.9, 0.5) > hybridEvidenceScore(0.2, 1));

const approvedCases = [
  {
    fingerprint: "vector-case-cuhk", targetProgrammeId: "cuhk-ee", offerYear: 2026,
    undergraduateUniversity: "南京大学", undergraduateMajor: "电子信息科学与技术", gpaRaw: "4.02", gpaScale: "GPA_4", gpa100: null,
    languageTest: "IELTS", languageScale: "IELTS_9", languageScore: 7, internships: [], workExperience: [], research: [], competitions: [], awards: [], patents: [], projects: [], reviewStatus: "approved",
    sourceUrl: "https://example.com/vector-cuhk"
  },
  {
    fingerprint: "vector-case-hkust", targetProgrammeId: "hkust-ee", offerYear: 2026,
    undergraduateUniversity: "香港科技大学", undergraduateMajor: "电子工程", gpaRaw: "3.9", gpaScale: "GPA_4", gpa100: null,
    languageTest: "IELTS", languageScale: "IELTS_9", languageScore: 7, internships: [], workExperience: [], research: [], competitions: [], awards: [], patents: [], projects: [], reviewStatus: "approved",
    sourceUrl: "https://example.com/vector-hkust"
  }
];

const retrieved = retrieveProgrammeKnowledge({ regions: ["香港"], fields: ["electronic"], profile: { major: "electronics" } }, {
  approvedCases,
  queryEmbedding: [1, 0],
  caseEmbeddings: [{ fingerprint: "vector-case-cuhk", model: "test", vector: [1, 0] }, { fingerprint: "vector-case-hkust", model: "test", vector: [0, 1] }]
});
const cuhk = retrieved.find(entry => entry.programme.id === "cuhk-ee");
assert.equal(cuhk.retrieval.vectorSearch, true);
assert.equal(cuhk.retrieval.indexedCaseCount, 1);
assert.equal(cuhk.documents.find(document => document.metadata?.fingerprint === "vector-case-cuhk").metadata.vectorScore, 1);

console.log("vector-search checks passed");
