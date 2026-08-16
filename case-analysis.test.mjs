import assert from "node:assert/strict";
import { programmes, schools } from "./data.mjs";
import { analyzeCaseEvidence, caseGpaInput, caseYearWeight, estimateFourPointGpa, gpaToComparablePercent, normalizeGpa, standardizeGpa } from "./case-analysis.mjs";

const profile = {
  schoolTier: 2,
  major: "automation",
  gpa: 85,
  gpaScale: "100",
  gpaValue: 85,
  languageTest: "IELTS",
  language: 7,
  courseTags: ["math", "programming", "control"],
  internships: [],
  researches: [],
  awards: []
};
const programme = {
  ...programmes.find(item => item.id === "ntu-communications"),
  cases: [
    { school: "中国矿业大学", schoolTier: 2, majorTag: "automation", gpaRaw: "84 / 100", gpaScale: "PERCENT_100", gpa100: 84, languageTest: "IELTS", language: 6.5 },
    { school: "南京大学", schoolTier: 3, majorTag: "electronic", gpaRaw: "3.8", gpaScale: "UNKNOWN", gpa100: null, languageTest: "TOEFL", language: 100 }
  ]
};
const analysis = analyzeCaseEvidence(profile, programme);

assert.ok(schools.some(item => item.classification === "海外本科"), "The school registry must support overseas undergraduate institutions");
assert.equal(normalizeGpa(3.4, "4"), 85, "Four-point GPA conversion must work");
assert.equal(normalizeGpa(4.25, "5"), 85, "Five-point GPA conversion must work");
assert.deepEqual(estimateFourPointGpa(85), { min: 3.3, max: 3.7, label: "3.3–3.7" }, "Percent scores must use a rough GPA interval");
const standardized211 = standardizeGpa({ gpaScale: "100", gpaValue: 86, schoolTier: 2, schoolClassification: "211 / 双一流" });
assert.deepEqual(standardized211.equivalentScore, { min: 84, max: 85, default: 84.5 }, "211 background correction must preserve an equivalent-score range");
assert.equal(standardized211.officialGpa, null, "A percent average must not be mislabeled as official GPA");
const standardizedGpa = standardizeGpa({ gpaScale: "4", gpaValue: 3.23, schoolTier: 3, schoolClassification: "海外本科" });
assert.equal(standardizedGpa.officialGpa, 3.23, "An entered four-point GPA must remain an original GPA");
assert.equal(standardizedGpa.estimatedGpa4, null, "An official four-point GPA must not be re-estimated");
assert.equal(gpaToComparablePercent(3.7, "4"), 90, "A four-point GPA must map to the shared internal percent scale");
assert.equal(standardizeGpa({ gpaScale: "4", gpaValue: 3.7, schoolClassification: "985" }).equivalentScore.default, 90, "A four-point GPA must receive the same school-tier correction pipeline");
assert.equal(caseYearWeight(2026, 2026), 1, "The reference year must have full weight");
assert.ok(caseYearWeight(2025, 2026) > caseYearWeight(2023, 2026), "Recent cases must carry more weight");
assert.ok(caseYearWeight(2023, 2026) >= 0.6, "Older cases must retain meaningful weight when recent samples are sparse");
assert.equal(analysis.evidence.caseCount, programme.cases.length, "Every approved case must appear in the evidence count");
assert.equal(analysis.evidence.gpa.total, 2, "Recognizable GPA scales must enter the shared equivalent-score distribution");
assert.ok(analysis.evidence.gpa.min <= analysis.evidence.gpa.median && analysis.evidence.gpa.median <= analysis.evidence.gpa.max, "GPA evidence must be ordered");
assert.ok(analysis.nearest, "A nearest disclosed case must be available for comparison");
assert.equal(analysis.center, null, "Case analysis must not invent an admission probability");

const weightedAnalysis = analyzeCaseEvidence({ ...profile, applicationYear: 2026, gpaValue: 80 }, {
  ...programmes[0],
  cases: [
    { cycle: 2026, schoolTier: 2, majorTag: "automation", gpaRaw: "90", gpaScale: "PERCENT_100", gpa100: 90, languageTest: "IELTS", language: 7 },
    { cycle: 2023, schoolTier: 2, majorTag: "automation", gpaRaw: "70", gpaScale: "PERCENT_100", gpa100: 70, languageTest: "IELTS", language: 7 }
  ]
});
assert.equal(weightedAnalysis.evidence.gpa.referenceYear, 2026, "The latest requested year must anchor case weights");
assert.equal(weightedAnalysis.evidence.gpa.weightedMedian, 88.5, "Recent cases must dominate the weighted GPA median after baseline correction");
assert.ok(weightedAnalysis.evidence.gpa.weightedMean > weightedAnalysis.evidence.gpa.mean, "Recent higher-GPA cases must carry more weight");
const fourPointProfile = analyzeCaseEvidence({ ...profile, gpaScale: "4", gpaValue: 3.6 }, programme);
assert.equal(fourPointProfile.evidence.gpa.available, true, "Four-point and percent cases must share the internal equivalent-score distribution");
assert.equal(fourPointProfile.evidence.gpa.scale, "985_EQUIVALENT_PERCENT");

const crossScale = analyzeCaseEvidence({ ...profile, schoolClassification: "211", gpaScale: "100", gpaValue: 86 }, {
  cases: [
    { school: "某211院校", schoolTier: 2, gpaRaw: "86/100", gpaScale: "PERCENT_100", gpa100: 86 },
    { school: "南京大学", schoolTier: 3, gpaRaw: "3.7/4", gpaScale: "GPA_4" },
    { school: "海外院校", schoolClassification: "海外本科", gpaRaw: "4.5/5", gpaScale: "GPA_5" }
  ]
});
assert.equal(crossScale.evidence.gpa.total, 3, "Percent, four-point and five-point cases must enter one distribution");
assert.deepEqual([crossScale.evidence.gpa.min, crossScale.evidence.gpa.max], [84.5, 90]);
assert.deepEqual(caseGpaInput({ gpaRaw: "均分86.12，GPA 3.56/4.0", gpaScale: "GPA_4" }), { scale: "PERCENT_100", value: 86.12 }, "A published average must take precedence over a second official GPA value");
assert.deepEqual(caseGpaInput({ gpaRaw: "85.2（4.26/5）", gpaScale: "GPA_5" }), { scale: "PERCENT_100", value: 85.2 }, "A standalone percentage must not be treated as a five-point GPA");
assert.deepEqual(caseGpaInput({ gpaRaw: "2.1/4.3，70.25", gpaScale: "GPA_4" }), { scale: "PERCENT_100", value: 70.25 }, "A disclosed percentage must take precedence over a 4.3 GPA");
assert.deepEqual(caseGpaInput({ gpaRaw: "0/其他", gpaScale: "UNKNOWN" }), { scale: "UNKNOWN", value: null }, "Placeholder zero values must be excluded");
assert.equal(gpaToComparablePercent(4.3, "4.3"), 100, "A 4.3 GPA scale must be supported");

console.log("case-analysis checks passed");
