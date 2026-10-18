import assert from "node:assert/strict";
import { normalizeAssessment } from "./assessment-contract.mjs";

const allowed = new Set(["cuhk-ee:case:approved"]);
const comparison = { evidence: { gpa: { available: false }, language: { available: true } } };
const base = {
  center: 70, low: 45, high: 90,
  fit: ["电子工程方向匹配"], psCv: ["突出控制课程"],
  reasoning: ["[cuhk-ee:case:approved] IELTS 可直接比较。", "[not-allowed] 不应保留。"],
  evidenceUsed: [
    { documentId: "cuhk-ee:case:approved", field: "language", comparison: "IELTS 7.0 与案例可比", missing: false },
    { documentId: "not-allowed", field: "gpa", comparison: "不应进入", missing: false }
  ],
  uncertainties: []
};

const filtered = normalizeAssessment(base, allowed, comparison);
assert.ok(filtered, "A supported evidence item should keep the assessment");
assert.deepEqual(filtered.evidenceUsed.map(item => item.documentId), ["cuhk-ee:case:approved"]);
assert.deepEqual(filtered.reasoning, ["[cuhk-ee:case:approved] IELTS 可直接比较。"]);

const tolerated = normalizeAssessment({ ...base, reasoning: [
  "cuhk-ee:case:approved IELTS 可直接比较。",
  "[cuhk-ee:case:approved:language] IELTS 可直接比较。",
  "not-allowed IELTS 不可引用。"
] }, allowed, comparison);
assert.deepEqual(tolerated.reasoning, [
  "[cuhk-ee:case:approved] IELTS 可直接比较。",
  "[cuhk-ee:case:approved] IELTS 可直接比较。"
]);

const missingGpa = normalizeAssessment({
  ...base,
  reasoning: ["[cuhk-ee:case:approved] GPA 分制未知，无法比较。"],
  evidenceUsed: [{ documentId: "cuhk-ee:case:approved", field: "gpa", comparison: "分制未知", missing: false }],
  uncertainties: ["GPA 分制未知"]
}, allowed, comparison);
assert.ok(missingGpa, "Missing GPA evidence may remain only with an uncertainty");
assert.equal(missingGpa.evidenceUsed[0].missing, true);

const missingWithoutUncertainty = normalizeAssessment({
  ...base,
  reasoning: ["[cuhk-ee:case:approved] GPA 看起来较高。"],
  evidenceUsed: [{ documentId: "cuhk-ee:case:approved", field: "gpa", comparison: "分制未知", missing: false }],
  uncertainties: []
}, allowed, comparison);
assert.equal(missingWithoutUncertainty, null, "Missing evidence without an uncertainty must be rejected");

assert.equal(normalizeAssessment({ ...base, center: 101 }, allowed, comparison), null, "Out-of-range probabilities must be rejected");
console.log("assessment contract checks passed");
