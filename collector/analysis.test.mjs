import assert from "node:assert/strict";
import { summarizeCases } from "./analysis.mjs";

const summary = summarizeCases([
  { reviewStatus: "ready", sourceUrl: "a", gpaScale: "PERCENT_100", gpa100: 84, languageTest: "IELTS", languageScale: "IELTS_9", internships: ["x"], research: [], awards: [], projects: ["p"] },
  { reviewStatus: "needs-review", sourceUrl: "a", gpaScale: "PERCENT_100", gpa100: 86, languageTest: null, languageScale: null, internships: [], research: ["r"], awards: [], projects: [] }
]);
assert.equal(summary.total, 2);
assert.equal(summary.comparablePercentGpa.median, 85);
assert.equal(summary.background.projects.disclosedCases, 1);
console.log("collector analysis checks passed");
