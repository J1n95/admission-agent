import assert from "node:assert/strict";
import { programmes, schools } from "./data.mjs";
import { analyzeCaseEvidence, caseGpaInput, caseYearWeight, estimateFourPointGpa, gpaToComparablePercent, standardizeGpa } from "./case-analysis.mjs";
import { analyzeCaseEvidence as analyzeMiniProgramCaseEvidence } from "./miniprogram/cloudfunctions/admissionApi/agent/case-analysis.mjs";

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
assert.deepEqual(estimateFourPointGpa(85), { min: 3.3, max: 3.7, label: "3.3–3.7" }, "Percent scores must use a rough GPA interval");
const standardized211 = standardizeGpa({ gpaScale: "100", gpaValue: 86, schoolTier: 2, schoolClassification: "211 / 双一流" });
assert.deepEqual(standardized211.equivalentScore, { min: 84, max: 85, default: 84.5 }, "211 background correction must preserve an equivalent-score range");
assert.equal(standardized211.officialGpa, null, "A percent average must not be mislabeled as official GPA");
const standardizedGpa = standardizeGpa({ gpaScale: "4", gpaValue: 3.23, schoolTier: 3, schoolClassification: "海外本科" });
assert.equal(standardizedGpa.officialGpa, 3.23, "An entered four-point GPA must remain an original GPA");
assert.equal(standardizedGpa.estimatedGpa4, null, "An official four-point GPA must not be re-estimated");
assert.equal(gpaToComparablePercent(3.7, "4"), null, "Four-point GPA must not be turned into an invented percentage");
assert.equal(standardizeGpa({ gpaScale: "5", gpaValue: 3.5, schoolClassification: "211" }).equivalentScore, null, "3.5/5 must not become a misleading 68.5/100");
assert.equal(caseYearWeight(2026, 2026), 1, "The reference year must have full weight");
assert.ok(caseYearWeight(2025, 2026) > caseYearWeight(2023, 2026), "Recent cases must carry more weight");
assert.ok(caseYearWeight(2023, 2026) >= 0.6, "Older cases must retain meaningful weight when recent samples are sparse");
assert.equal(analysis.evidence.caseCount, programme.cases.length, "Every approved case must appear in the evidence count");
assert.equal(analysis.evidence.gpa.total, 1, "Only published percent averages may enter a percent comparison");
assert.ok(analysis.evidence.gpa.min <= analysis.evidence.gpa.median && analysis.evidence.gpa.median <= analysis.evidence.gpa.max, "GPA evidence must be ordered");
assert.ok(analysis.nearest, "A nearest disclosed case must be available for comparison");
assert.equal(analysis.center, null, "Case analysis must not invent an admission probability");

const positionProfile = { ...profile, schoolTier: 3, schoolClassification: "985本科" };
const positionProgramme = { cases: [80, 85].map(gpa => ({
  school: "北京大学", schoolTier: 3, schoolClassification: "985本科",
  gpaRaw: `${gpa}/100`, gpaScale: "PERCENT_100", gpa100: gpa
})) };
const belowAll = analyzeCaseEvidence({ ...positionProfile, gpaValue: 70 }, positionProgramme).evidence.gpa;
assert.equal(belowAll.total, 2);
assert.equal(belowAll.rank, null, "A new applicant below all cases must not be called rank 3/2");
assert.equal(belowAll.positionNote, "仅 2 条同分制可比成功案例，不展示 GPA 名次；个别成功样本不能证明成绩优势、劣势或录取门槛。");
assert.equal(analyzeMiniProgramCaseEvidence({ ...positionProfile, gpaValue: 70 }, positionProgramme).evidence.gpa.rank,
  belowAll.rank, "Both clients must avoid a rank when cases are scarce");
const atMinimum = analyzeCaseEvidence({ ...positionProfile, gpaValue: 80 }, positionProgramme).evidence.gpa;
assert.equal(atMinimum.rank, null, "Fewer than five comparable cases must not expose a rank");
assert.equal(atMinimum.positionNote, belowAll.positionNote);
assert.equal(analyzeCaseEvidence({ ...positionProfile, gpaValue: 90 }, positionProgramme).evidence.gpa.rank, null);
assert.equal(analyzeCaseEvidence({ ...positionProfile, gpaValue: 90 }, positionProgramme).evidence.background.gpaPercentileAmongSuccessfulCases, null);
const fiveCaseProgramme = { cases: [70, 75, 80, 85, 90].map(gpa => ({
  schoolTier: 3, schoolClassification: "985本科", gpaRaw: `${gpa}/100`, gpaScale: "PERCENT_100", gpa100: gpa
})) };
assert.equal(analyzeCaseEvidence({ ...positionProfile, gpaValue: 80 }, fiveCaseProgramme).evidence.gpa.rank, 3,
  "Five comparable cases may expose an insertion position");
assert.equal(analyzeMiniProgramCaseEvidence({ ...positionProfile, gpaValue: 80 }, fiveCaseProgramme).evidence.gpa.rank, 3);
const lastInsertion = analyzeCaseEvidence({ ...positionProfile, gpaValue: 72 }, fiveCaseProgramme).evidence.gpa;
assert.equal(lastInsertion.rank, 5);
assert.match(lastInsertion.positionNote, /并非低于全部案例/);
assert.equal(analyzeMiniProgramCaseEvidence({ ...positionProfile, gpaValue: 72 }, fiveCaseProgramme).evidence.gpa.positionNote, lastInsertion.positionNote);
assert.equal(analyzeCaseEvidence(positionProfile, { cases: [] }).evidence.gpa.rank, null,
  "Zero-case projects must not expose a case position");
const tierEvidence = analyzeCaseEvidence({ ...profile, major: "education", schoolTier: 1, schoolClassification: "普通本科" }, {
  cases: [{ schoolTier: 1, majorTag: "education", gpaRaw: "85/100", gpaScale: "PERCENT_100", gpa100: 85,
    schoolClassification: "未知本科层次" }]
}).evidence.background;
assert.ok(tierEvidence.sameTierMajorCount <= tierEvidence.sameTierCount,
  "The same-tier-and-major count must use the same standardized tier definition as same-tier count");
const exactMajorProfile = { ...profile, major: 'medicine', majorName: '预防医学', schoolTier: 1, schoolClassification: '普通本科' };
const exactMajorCases = { cases: [
  { majorTag: null, majorName: '公共卫生(预防医学)', schoolTier: 1, schoolClassification: '普通本科', gpaRaw: '85/100', gpaScale: 'PERCENT_100', gpa100: 85 },
  { majorTag: 'medicine', majorName: '临床医学', schoolTier: 1, schoolClassification: '普通本科', gpaRaw: '84/100', gpaScale: 'PERCENT_100', gpa100: 84 }
] };
for (const analyze of [analyzeCaseEvidence, analyzeMiniProgramCaseEvidence]) {
  const background = analyze(exactMajorProfile, exactMajorCases).evidence.background;
  assert.equal(background.sameMajorCount, 1, 'An explicitly named exact major must count even when majorField is missing');
  assert.equal(background.sameTierMajorCount, 1, 'A related but different named major must not count as exact');
}

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
assert.equal(fourPointProfile.evidence.gpa.available, false, "Four-point GPA must not be compared with percent cases");
assert.equal(fourPointProfile.evidence.gpa.scale, "GPA_4");

const crossScale = analyzeCaseEvidence({ ...profile, schoolClassification: "211", gpaScale: "100", gpaValue: 86 }, {
  cases: [
    { school: "某211院校", schoolTier: 2, gpaRaw: "86/100", gpaScale: "PERCENT_100", gpa100: 86 },
    { school: "南京大学", schoolTier: 3, gpaRaw: "3.7/4", gpaScale: "GPA_4" },
    { school: "海外院校", schoolClassification: "海外本科", gpaRaw: "4.5/5", gpaScale: "GPA_5" }
  ]
});
assert.equal(crossScale.evidence.gpa.total, 1, "Different GPA scales must stay out of a percent distribution");
assert.deepEqual([crossScale.evidence.gpa.min, crossScale.evidence.gpa.max], [84.5, 84.5]);
const fivePointProfile = analyzeCaseEvidence({ ...profile, gpaScale: "5", gpaValue: 3.5 }, {
  cases: [
    { schoolTier: 2, gpaRaw: "3.7/5", gpaScale: "GPA_5", gpa100: 74 },
    { schoolTier: 2, gpaRaw: "84/100", gpaScale: "PERCENT_100", gpa100: 84 }
  ]
});
assert.equal(fivePointProfile.evidence.gpa.scale, "GPA_5");
assert.equal(fivePointProfile.evidence.gpa.user, 3.5);
assert.equal(fivePointProfile.evidence.gpa.min, 3.7);
assert.equal(fivePointProfile.evidence.gpa.total, 1);
assert.equal(fivePointProfile.evidence.gpa.rank, null);
assert.equal(fivePointProfile.evidence.gpa.normalization.applied, false);
assert.deepEqual(caseGpaInput({ gpaRaw: "3.7/5", gpaScale: "GPA_5", gpa100: 74 }),
  { scale: "GPA_5", value: 3.7 }, "Old linear gpa100 values must not override a five-point GPA");
assert.deepEqual(caseGpaInput({ gpaRaw: "5分制 3.5", gpaScale: "GPA_5", gpa100: 70 }),
  { scale: "GPA_5", value: 3.5 }, "A scale label before the score must not be mistaken for the score");
assert.equal(standardizeGpa({ gpaScale: "5", gpaValue: null }).rawScore, null,
  "A missing GPA must not become zero");
assert.equal(analyzeCaseEvidence({ ...profile, gpaScale: "5", gpaValue: 3.5 }, positionProgramme).evidence.gpa.available,
  false, "A five-point applicant cannot be ranked against percent-only cases");
assert.deepEqual(caseGpaInput({ gpaRaw: "均分86.12，GPA 3.56/4.0", gpaScale: "GPA_4" }), { scale: "PERCENT_100", value: 86.12 }, "A published average must take precedence over a second official GPA value");
assert.deepEqual(caseGpaInput({ gpaRaw: "85.2（4.26/5）", gpaScale: "GPA_5" }), { scale: "PERCENT_100", value: 85.2 }, "A standalone percentage must not be treated as a five-point GPA");
assert.deepEqual(caseGpaInput({ gpaRaw: "2.1/4.3，70.25", gpaScale: "GPA_4" }), { scale: "PERCENT_100", value: 70.25 }, "A disclosed percentage must take precedence over a 4.3 GPA");
assert.deepEqual(caseGpaInput({ gpaRaw: "0/其他", gpaScale: "UNKNOWN" }), { scale: "UNKNOWN", value: null }, "Placeholder zero values must be excluded");
assert.deepEqual(caseGpaInput({ gpaRaw: "3.8", gpaScale: "UNKNOWN", gpa100: 95 }),
  { scale: "UNKNOWN", value: null }, "An unknown GPA scale and old inferred percent cannot establish a comparable score");
assert.deepEqual(caseGpaInput({ gpaRaw: "85", gpaScale: "UNKNOWN", gpa100: 85 }),
  { scale: "UNKNOWN", value: null }, "A bare score with unknown scale must not be assumed to be a percentage");
assert.equal(gpaToComparablePercent(4.3, "4.3"), null, "A 4.3 GPA must remain on its own scale");

console.log("case-analysis checks passed");
