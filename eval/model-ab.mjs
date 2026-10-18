import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resolveExactInstitution } from "../master-data.mjs";
import { standardizeGpa } from "../case-analysis.mjs";
import {
  assessmentPrompt,
  buildScreeningProjects,
  normalizeAgentAssessments,
  normalizeProbabilityCalibration,
  parseModelJson,
  prepareAgentAnalysis,
  probabilityCalibrationPrompt,
  screeningPrompt,
  validateProgrammeScreeningResult
} from "../miniprogram/cloudfunctions/admissionApi/agent/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ADMISSION_EVAL_DATA_DIR || join(root, "miniprogram", "cloud-data");
const outputDir = process.env.ADMISSION_EVAL_OUTPUT_DIR || join(root, "outputs", "model-ab");
const inputByteLimit = 55000;
const stageLimits = { selection: 6000, assessment: 5000, ranking: 4000 };
const qwenChallenger = process.argv.includes("--qwen-challenger");
const deepseekReview = process.argv.includes("--deepseek-review");
const crossDiscipline = process.argv.includes("--cross-discipline");
const expandedDiscipline = process.argv.includes("--cross-discipline-expanded");
const gpaFiveReview = process.argv.includes("--gpa-five-review");
const gpaCompare = process.argv.includes("--gpa-compare");
const schoolTierSmoke = process.argv.includes("--school-tier-smoke");
const nonEliteSweep = process.argv.includes("--non-elite-sweep");
if ([qwenChallenger, deepseekReview, crossDiscipline, expandedDiscipline, gpaFiveReview, gpaCompare, schoolTierSmoke, nonEliteSweep].filter(Boolean).length > 1) {
  throw new Error("单模型评测模式不能同时启用。");
}
const maxCnyDefault = nonEliteSweep ? 5 : crossDiscipline || expandedDiscipline || gpaCompare ? 2 : deepseekReview || gpaFiveReview || schoolTierSmoke ? 1 : qwenChallenger ? 5 : 10;
const schoolTierProfile = university => {
  const institution = resolveExactInstitution(university);
  assert.ok(institution, `测试院校不在主表中：${university}`);
  const profile = {
    university, schoolTier: institution.scoreTier, schoolClassification: institution.classification,
    major: "electronic", majorName: "电子信息工程", gpaScale: "100", gpaValue: 82,
    languageTest: "IELTS", language: 7, targetFields: ["electronic"],
    internships: [{ direction: "electronic", companyTypes: ["private"] }], researches: [], awards: []
  };
  return { ...profile, gpaStandardization: standardizeGpa(profile) };
};
const schoolTierProfiles = ["中国矿业大学", "成都理工大学", "杭州电子科技大学", "南京邮电大学"]
  .map((university, index) => ({
    id: `school-tier-${index + 1}`, profile: schoolTierProfile(university),
    assessmentIds: ["hkust-ee"]
  }));
const qwenChallengerScenarios = new Set([
  "selection-electronic",
  "selection-sparse-and-adjacent",
  "assessment-cuhk-mae",
  "assessment-polyu-hk-intelligent-robotics-engineering",
  "assessment-cityu-hk-msc-artificial-intelligence",
  "assessment-ntu-financial-technology",
  "ranking-automation",
  "ranking-evidence-scarcity"
]);
const deepseekReviewScenarios = new Set([
  "selection-sparse-and-adjacent",
  "assessment-polyu-hk-intelligent-robotics-engineering",
  "assessment-hku-infrastructure-engineering-management",
  "assessment-cityu-hk-msc-artificial-intelligence",
  "assessment-ntu-financial-technology",
  "ranking-evidence-scarcity"
]);

const allProviders = [
  {
    name: "千问",
    model: process.env.QWEN_MODEL || (qwenChallenger ? "qwen3.7-plus" : "qwen-flash-2025-07-28"),
    url: process.env.QWEN_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    key: process.env.DASHSCOPE_API_KEY,
    inputPrice: qwenChallenger ? 2 : 0.367,
    cacheInputPrice: qwenChallenger ? 0.4 : 0.367,
    outputPrice: qwenChallenger ? 8 : 2.936,
    priceBasis: qwenChallenger ? "阿里云百炼北京地域公开原价，CNY/百万 token" : "公开峰时/较高地域非缓存单价，CNY/百万 token"
  },
  {
    name: "DeepSeek",
    model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
    url: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    key: process.env.DEEPSEEK_API_KEY,
    inputPrice: 2,
    cacheInputPrice: 0.04,
    outputPrice: 8,
    priceBasis: "公开峰时输入未命中/输出单价，CNY/百万 token"
  }
];
const providers = qwenChallenger
  ? allProviders.filter(provider => provider.name === "千问")
  : deepseekReview || crossDiscipline || expandedDiscipline || gpaFiveReview || gpaCompare || schoolTierSmoke || nonEliteSweep
    ? allProviders.filter(provider => provider.name === "DeepSeek")
    : allProviders;

const baseProfile = {
  university: "中国矿业大学",
  schoolTier: 2,
  schoolClassification: "211 / 双一流",
  major: "automation",
  majorName: "自动化",
  gpaScale: "100",
  gpaValue: 81.2,
  languageTest: "IELTS",
  language: 7,
  targetFields: ["automation"],
  internships: [{ direction: "automation", companyTypes: ["state-owned"] }]
};

// Synthetic applicants use only fields available in the desktop form; no real applicant is represented.
const crossProfiles = [
  {
    id: "finance", fields: ["finance"],
    profile: { university: "上海大学", schoolTier: 2, schoolClassification: "211 / 双一流",
      major: "economics", majorCode: "020301K", majorName: "金融学", gpaScale: "100", gpaValue: 85.5,
      languageTest: "IELTS", language: 7, targetFields: ["finance"],
      internships: [{ companyTier: "established", direction: "finance" }], researches: [], awards: [] },
    programmeIds: ["hku-master-of-finance", "cityu-hk-msc-finance", "cuhk-master-of-accountancy", "nus-master-of-science-in-quantitative-finance"],
    assessmentIds: ["hku-master-of-finance", "cityu-hk-msc-finance"]
  },
  {
    id: "media", fields: ["media"],
    profile: { university: "深圳大学", schoolTier: 1, schoolClassification: "普通本科",
      major: "media", majorCode: "050301", majorName: "新闻学", gpaScale: "100", gpaValue: 82,
      languageTest: "TOEFL", language: 95, targetFields: ["media"],
      internships: [{ companyTier: "medium", direction: "media" }], researches: [], awards: [] },
    programmeIds: ["cityu-hk-ma-communication-and-new-media", "hku-master-of-journalism", "cuhk-ma-in-journalism", "cityu-hk-ma-creative-media"],
    assessmentIds: ["cityu-hk-ma-communication-and-new-media", "hku-master-of-journalism"]
  },
  {
    id: "law", fields: ["law"],
    profile: { university: "复旦大学", schoolTier: 3, schoolClassification: "985 / 211 / 双一流",
      major: "law", majorCode: "030101K", majorName: "法学", gpaScale: "100", gpaValue: 78.5,
      languageTest: "IELTS", language: 6.5, targetFields: ["law"],
      internships: [], researches: [], awards: [{ level: "school", category: "law" }] },
    programmeIds: ["cuhk-master-of-laws-in-common-law", "cityu-hk-master-of-laws", "cuhk-master-of-laws-in-chinese-business-law", "hku-master-of-public-administration"],
    assessmentIds: ["cuhk-master-of-laws-in-common-law", "cityu-hk-master-of-laws"]
  },
  {
    id: "public-health", fields: ["public-health"],
    profile: { university: "南方医科大学", schoolTier: 1, schoolClassification: "普通本科",
      major: "medicine", majorCode: "100401K", majorName: "预防医学", gpaScale: "100", gpaValue: 88,
      languageTest: "IELTS", language: 6.5, targetFields: ["public-health"],
      internships: [{ companyTier: "established", direction: "public-health" }],
      researches: [{ direction: "public-health", type: "course" }], awards: [] },
    programmeIds: ["hku-master-of-public-health", "cityu-hk-master-of-public-health", "cuhk-master-of-public-health", "cuhk-msc-in-nutrition-food-science-and-technology"],
    assessmentIds: ["hku-master-of-public-health", "cityu-hk-master-of-public-health"]
  }
];

const expandedProfiles = [
  {
    id: "education", fields: ["education"],
    profile: { university: "山东师范大学", schoolTier: 1, schoolClassification: "普通本科",
      major: "education", majorCode: "040101", majorName: "教育学", gpaScale: "100", gpaValue: 86,
      languageTest: "IELTS", language: 7, targetFields: ["education"],
      internships: [{ companyTier: "medium", direction: "education" }], researches: [], awards: [] },
    programmeIds: ["cuhk-master-of-education", "hku-master-of-education", "cuhk-ma-in-teaching-english-to-speakers-of-other-languages", "hku-master-of-arts-in-teaching-english-to-speakers-of-other-languages"],
    assessmentIds: ["cuhk-master-of-education", "hku-master-of-education"]
  },
  {
    id: "psychology", fields: ["psychology"],
    profile: { university: "北京大学", schoolTier: 3, schoolClassification: "985 / 211 / 双一流",
      major: "psychology", majorCode: "071101", majorName: "心理学", gpaScale: "100", gpaValue: 81,
      languageTest: "IELTS", language: 7, targetFields: ["psychology"],
      internships: [], researches: [{ direction: "psychology", type: "course" }], awards: [] },
    programmeIds: ["polyu-hk-applied-psychology", "polyu-hk-school-and-community-psychology", "polyu-hk-marriage-and-family-therapy", "hku-master-of-social-work"],
    assessmentIds: ["polyu-hk-applied-psychology", "polyu-hk-school-and-community-psychology"]
  }
];
const allCrossProfiles = [...crossProfiles, ...expandedProfiles];
const gpaFiveProfile = {
  id: "gpa-five-health", fields: ["public-health", "food-nutrition"],
  profile: { university: "西南交通大学", schoolTier: 2, schoolClassification: "211 / 双一流",
    major: "biotechnology", majorCode: "083001", majorName: "生物工程", gpaScale: "5", gpaValue: 3.5,
    languageTest: "IELTS", language: 7, targetFields: ["public-health", "food-nutrition"],
    internships: [{ companyTier: "medium", direction: "biotechnology" }], researches: [], awards: [] },
  programmeIds: ["hku-master-of-public-health", "cityu-hk-master-of-public-health",
    "cuhk-msc-in-nutrition-food-science-and-technology", "cuhk-master-of-public-health"],
  assessmentIds: ["hku-master-of-public-health", "cuhk-msc-in-nutrition-food-science-and-technology"]
};
// Synthetic paired transcript: both numbers are declared official; neither is converted from the other.
const gpaPercentProfile = {
  ...gpaFiveProfile,
  id: "gpa-percent-health",
  profile: { ...gpaFiveProfile.profile, gpaScale: "100", gpaValue: 82.6 }
};
const nonEliteDirections = [
  { id: "electronic", schools: ["南京邮电大学", "杭州电子科技大学"], fields: ["electronic", "communication"],
    major: "electronic", majorName: "电子信息工程", score: 82,
    programmeIds: ["hkust-ee", "cityu-eie", "cuhk-ee", "ntu-electronics"], assessmentIds: ["hkust-ee", "cityu-eie"] },
  { id: "ai", schools: ["南京邮电大学", "杭州电子科技大学"], fields: ["ai", "data"],
    major: "computer", majorName: "计算机科学与技术", score: 85,
    programmeIds: ["cityu-hk-msc-artificial-intelligence", "cuhk-msc-in-artificial-intelligence", "hku-master-of-science-in-artificial-intelligence", "hku-master-of-journalism"],
    assessmentIds: ["cityu-hk-msc-artificial-intelligence", "cuhk-msc-in-artificial-intelligence"] },
  { id: "finance", schools: ["河南大学", "南京财经大学"], fields: ["finance"],
    major: "economics", majorName: "金融学", score: 85.5,
    programmeIds: ["hku-master-of-finance", "cityu-hk-msc-finance", "cuhk-master-of-accountancy", "nus-master-of-science-in-quantitative-finance"],
    assessmentIds: ["cityu-hk-msc-finance", "hku-master-of-finance"] },
  { id: "media", schools: ["河南大学", "青岛大学"], fields: ["media"],
    major: "media", majorName: "新闻学", score: 82,
    programmeIds: ["cityu-hk-ma-communication-and-new-media", "hku-master-of-journalism", "cuhk-ma-in-journalism", "cityu-hk-ma-creative-media"],
    assessmentIds: ["cityu-hk-ma-communication-and-new-media", "hku-master-of-journalism"] },
  { id: "law", schools: ["河南大学", "青岛大学"], fields: ["law"],
    major: "law", majorName: "法学", score: 84,
    programmeIds: ["cuhk-master-of-laws-in-common-law", "cityu-hk-master-of-laws", "cuhk-master-of-laws-in-chinese-business-law", "hku-master-of-public-administration"],
    assessmentIds: ["cityu-hk-master-of-laws", "cuhk-master-of-laws-in-common-law"] },
  { id: "public-health", schools: ["广州医科大学", "青岛大学"], fields: ["public-health"],
    major: "medicine", majorName: "预防医学", score: 88,
    programmeIds: ["hku-master-of-public-health", "cityu-hk-master-of-public-health", "cuhk-master-of-public-health", "cuhk-msc-in-nutrition-food-science-and-technology"],
    assessmentIds: ["hku-master-of-public-health", "cityu-hk-master-of-public-health"] },
  { id: "education", schools: ["河南大学", "江苏师范大学"], fields: ["education"],
    major: "education", majorName: "教育学", score: 86,
    programmeIds: ["cuhk-master-of-education", "hku-master-of-education", "cuhk-ma-in-teaching-english-to-speakers-of-other-languages", "hku-master-of-arts-in-teaching-english-to-speakers-of-other-languages"],
    assessmentIds: ["cuhk-master-of-education", "hku-master-of-education"] },
  { id: "psychology", schools: ["河南大学", "江苏师范大学"], fields: ["psychology"],
    major: "psychology", majorName: "心理学", score: 84,
    programmeIds: ["polyu-hk-applied-psychology", "polyu-hk-school-and-community-psychology", "polyu-hk-marriage-and-family-therapy", "hku-master-of-social-work"],
    assessmentIds: ["polyu-hk-applied-psychology", "polyu-hk-school-and-community-psychology"] },
  { id: "environment", schools: ["成都理工大学", "广东工业大学"], fields: ["environmental", "energy"],
    major: "environmental", majorName: "环境工程", score: 83,
    programmeIds: ["hku-master-of-science-in-environmental-management", "cityu-hk-msc-energy-and-environment", "hkust-msc-pgd-in-environmental-engineering-and-management", "cuhk-master-of-laws-in-energy-and-environmental-law"],
    assessmentIds: ["hku-master-of-science-in-environmental-management", "cityu-hk-msc-energy-and-environment"] },
  { id: "design", schools: ["中国美术学院", "广东工业大学"], fields: ["design", "arts"],
    major: "design", majorName: "工业设计", score: 84,
    programmeIds: ["polyu-hk-design", "polyu-hk-fashion-design", "cityu-hk-ma-creative-media", "hku-master-of-architecture-design"],
    assessmentIds: ["polyu-hk-design", "cityu-hk-ma-creative-media"] }
];
const nonEliteProfiles = nonEliteDirections.flatMap(direction => direction.schools.map((university, index) => {
  const institution = resolveExactInstitution(university);
  assert.ok(institution && (index === 0 ? institution.classification === "双一流" : institution.classification === "双非"),
    `非985/211对照院校分类不符：${university}`);
  const profile = {
    university, schoolTier: institution.scoreTier, schoolClassification: institution.classification,
    major: direction.major, majorName: direction.majorName, gpaScale: "100", gpaValue: direction.score,
    languageTest: "IELTS", language: 7, targetFields: direction.fields,
    internships: [{ direction: direction.fields[0], companyTypes: ["private"] }], researches: [], awards: []
  };
  return { id: `nonelite-${direction.id}-${index ? "ordinary" : "dfc"}`, domain: direction.id,
    fields: direction.fields, profile: { ...profile, gpaStandardization: standardizeGpa(profile) },
    programmeIds: direction.programmeIds, assessmentIds: direction.assessmentIds };
}));
const fixtureProfiles = [...allCrossProfiles, gpaFiveProfile, gpaPercentProfile, ...nonEliteProfiles];

const sha256 = value => createHash("sha256").update(String(value)).digest("hex");
const dataNames = {
  cases: ["cases.json", "cases.jsonl"],
  programmes: ["programmes.json", "programmes.jsonl"],
  evidence: ["programme_evidence.json", "programme-evidence.jsonl"]
};
const readJsonLines = name => {
  const fileName = dataNames[name]?.find(candidate => {
    try { readFileSync(join(dataDir, candidate)); return true; } catch { return false; }
  });
  if (!fileName) throw new Error(`找不到评测数据：${name}`);
  return readFileSync(join(dataDir, fileName), "utf8")
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
};
const programmes = readJsonLines("programmes");
const cases = readJsonLines("cases").filter(item => item.reviewStatus === "approved");
const evidence = readJsonLines("evidence");
const catalogPath = process.env.ADMISSION_EVAL_CATALOG_PATH
  || join(root, "miniprogram/cloudfunctions/admissionApi/catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

const programmeCards = new Map(catalog.programmes.map(item => [item.id, item]));
const programmeRows = new Map(programmes.map(item => [item.programmeId, item]));
const casesByProgramme = new Map();
for (const item of cases) {
  const rows = casesByProgramme.get(item.programmeId) || [];
  rows.push(item);
  casesByProgramme.set(item.programmeId, rows);
}
const evidenceByProgramme = new Map();
for (const item of evidence) {
  const rows = evidenceByProgramme.get(item.programmeId) || [];
  rows.push(item);
  evidenceByProgramme.set(item.programmeId, rows);
}

function candidateFor(id) {
  const card = programmeCards.get(id);
  const row = programmeRows.get(id);
  assert.ok(card && row, `找不到固定测试项目 ${id}`);
  return { ...card, ...row, id, name: row.nameEn || card.name };
}

// These are exploration fixtures, not admissions ground truth. The reference IDs/order
// are temporary human labels used only to make model outputs auditable and comparable.
const selectionScenarios = [
  {
    id: "selection-automation",
    fields: ["automation", "robotics"],
    programmeIds: ["ntu-cca", "cuhk-mae", "nus-robotics", "ntu-robotics-intelligent-systems", "hkust-ee", "cityu-eie", "ntu-financial-technology", "hku-infrastructure-engineering-management"],
    referenceIds: ["ntu-cca", "cuhk-mae", "nus-robotics", "ntu-robotics-intelligent-systems"]
  },
  {
    id: "selection-electronic",
    fields: ["electronic", "communication"],
    programmeIds: ["cuhk-ee", "hkust-ee", "ntu-electronics", "cityu-eie", "polyu-eie", "ntu-communications", "ntu-cca", "cityu-cie"],
    referenceIds: ["cuhk-ee", "hkust-ee", "ntu-electronics", "cityu-eie", "polyu-eie"]
  },
  {
    id: "selection-data-ai",
    fields: ["data", "computer", "ai"],
    programmeIds: ["hkust-bdt", "nus-mcomp-ai", "cityu-business-data-analytics", "cuhk-ie", "cityu-cie", "ntu-financial-technology", "ntu-cca", "cuhk-mae"],
    referenceIds: ["hkust-bdt", "nus-mcomp-ai", "cityu-business-data-analytics", "cuhk-ie", "cityu-cie"]
  },
  {
    id: "selection-sparse-and-adjacent",
    fields: ["automation", "robotics"],
    programmeIds: ["polyu-hk-intelligent-robotics-engineering", "hku-infrastructure-engineering-management", "cityu-hk-master-of-architecture", "ntu-robotics-intelligent-systems", "nus-robotics", "cityu-hk-msc-ai-driven-innovation", "cityu-hk-msc-artificial-intelligence", "cityu-hk-msc-digital-transformation-and-technological-innovation"],
    referenceIds: ["polyu-hk-intelligent-robotics-engineering", "ntu-robotics-intelligent-systems", "nus-robotics"]
  },
  ...fixtureProfiles.map(item => ({ ...item, id: `cross-${item.id}-selection`, referenceIds: item.assessmentIds }))
];

const assessmentScenarios = [
  "cityu-eie",
  "ntu-cca",
  "cuhk-mae",
  "polyu-hk-intelligent-robotics-engineering",
  "hku-infrastructure-engineering-management",
  "cityu-hk-msc-artificial-intelligence",
  "ntu-financial-technology",
  "hku-eee"
].map(id => ({ id: `assessment-${id}`, programmeId: id }))
  .concat([...fixtureProfiles, ...schoolTierProfiles].flatMap(item => item.assessmentIds.map(programmeId => ({
    id: `cross-${item.id}-assessment-${programmeId}`, programmeId,
    comparisonIds: item.assessmentIds, profile: item.profile
  }))));

const rankingScenarios = [
  {
    id: "ranking-automation",
    programmeIds: ["ntu-cca", "cuhk-mae", "nus-robotics", "polyu-hk-intelligent-robotics-engineering"],
    referenceOrder: ["ntu-cca", "cuhk-mae", "nus-robotics", "polyu-hk-intelligent-robotics-engineering"]
  },
  {
    id: "ranking-data-ai",
    programmeIds: ["hkust-bdt", "nus-mcomp-ai", "cuhk-ie", "cityu-business-data-analytics"],
    referenceOrder: ["nus-mcomp-ai", "hkust-bdt", "cuhk-ie", "cityu-business-data-analytics"]
  },
  {
    id: "ranking-evidence-scarcity",
    programmeIds: ["cityu-hk-msc-artificial-intelligence", "polyu-hk-intelligent-robotics-engineering", "ntu-financial-technology", "hku-infrastructure-engineering-management"],
    referenceOrder: ["cityu-hk-msc-artificial-intelligence", "polyu-hk-intelligent-robotics-engineering", "ntu-financial-technology", "hku-infrastructure-engineering-management"]
  },
  ...fixtureProfiles.map(item => ({ id: `cross-${item.id}-ranking`,
    programmeIds: item.assessmentIds, profile: item.profile, referenceOrder: [] }))
].map(item => ({ ...item, profile: item.profile || { ...baseProfile } }));

function selectionFixture(definition) {
  const candidates = definition.programmeIds.map(candidateFor);
  const projects = buildScreeningProjects(candidates);
  const input = {
    screeningStage: "card",
    profile: { structured: { ...(definition.profile || baseProfile), targetFields: definition.fields }, narrative: null },
    requestedRegions: definition.profile ? ["香港"] : ["香港", "新加坡"],
    requestedFields: definition.fields,
    projects
  };
  return {
    stage: "selection",
    scenario: definition.id,
    referenceIds: definition.referenceIds,
    dataHash: sha256(JSON.stringify({ profile: input.profile, projects })),
    input,
    systemPrompt: screeningPrompt
  };
}

function preparedFor(ids, profile = baseProfile) {
  const candidates = ids.map(candidateFor);
  const evidenceInput = Object.fromEntries(candidates.map(programme => [programme.id, {
    allCases: casesByProgramme.get(programme.id) || [],
    official: evidenceByProgramme.get(programme.id) || []
  }]));
  return prepareAgentAnalysis(profile, candidates, evidenceInput);
}

function comparisonProgrammes(prepared) {
  return prepared.modelInput.programmes.map(programme => ({
    id: programme.id,
    name: programme.name,
    nameEn: programme.nameEn,
    officialRequirements: String(programme.officialRequirements || "").slice(0, 2000),
    languageAssessment: programme.languageAssessment,
    positioning: String(programme.positioning || "").slice(0, 1000),
    curriculum: String(programme.curriculum || "").slice(0, 1500),
    focusTags: programme.focusTags,
    majorTags: programme.majorTags,
    courseTags: programme.courseTags,
    caseDistribution: programme.caseDistribution
  }));
}

function assessmentFixture(definition) {
  const prepared = preparedFor(definition.comparisonIds || [definition.programmeId], definition.profile);
  const programme = prepared.modelInput.programmes.find(item => item.id === definition.programmeId);
  const comparisons = comparisonProgrammes(prepared);
  const input = { ...prepared.modelInput, programmes: [programme], comparisonProgrammes: comparisons };
  return {
    stage: "assessment",
    scenario: definition.id,
    programmeId: definition.programmeId,
    caseCount: (casesByProgramme.get(definition.programmeId) || []).length,
    evidenceCount: programme.evidenceSelection.length,
    prepared,
    input,
    dataHash: sha256(JSON.stringify(input)),
    systemPrompt: assessmentPrompt
  };
}

function rankingFixture(definition) {
  const prepared = preparedFor(definition.programmeIds, definition.profile);
  const input = { profile: prepared.modelInput.profile, programmes: comparisonProgrammes(prepared) };
  return {
    stage: "ranking",
    scenario: definition.id,
    referenceOrder: definition.referenceOrder,
    programmeIds: definition.programmeIds,
    caseCounts: Object.fromEntries(prepared.modelInput.programmes.map(item => [item.id, item.caseDistribution.caseCount])),
    prepared,
    input,
    dataHash: sha256(JSON.stringify(input)),
    systemPrompt: probabilityCalibrationPrompt
  };
}

function requestFor(provider, fixture) {
  return {
    model: provider.model,
    temperature: 0,
    max_tokens: stageLimits[fixture.stage],
    response_format: { type: "json_object" },
    ...(provider.name === "千问" ? { enable_thinking: false } : { thinking: { type: "disabled" } }),
    messages: [
      { role: "system", content: fixture.systemPrompt },
      { role: "user", content: JSON.stringify(fixture.input) }
    ]
  };
}

function maximumEstimatedCost(provider, requestBytes, stage) {
  // Conservative preflight only: it intentionally overestimates UTF-8 bytes as tokens.
  const inputTokens = requestBytes * 2 + 1000;
  return (inputTokens * provider.inputPrice + stageLimits[stage] * provider.outputPrice) / 1_000_000;
}

function usageBreakdown(provider, usage) {
  const inputTokens = Number(usage?.prompt_tokens);
  const outputTokens = Number(usage?.completion_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const cachedTokens = Math.max(0, Number(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0
  ) || 0);
  const uncachedTokens = Math.max(0, inputTokens - cachedTokens);
  const conservativeCostCny = (inputTokens * provider.inputPrice + outputTokens * provider.outputPrice) / 1_000_000;
  const cacheAwareCostCny = (uncachedTokens * provider.inputPrice
    + cachedTokens * provider.cacheInputPrice + outputTokens * provider.outputPrice) / 1_000_000;
  return {
    inputTokens,
    cachedTokens,
    uncachedTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens,
    conservativeCostCny,
    cacheAwareCostCny
  };
}

export function impossibleRankClaims(value) {
  const claims = [];
  const visit = item => {
    if (typeof item === "string") {
      for (const pattern of [
        /\brank\s*(\d+)\s*\/\s*(\d+)\b/gi,
        /第\s*(\d+)\s*(?:位)?\s*[（(]\s*共\s*(\d+)\s*(?:人|例|个|条)?\s*[）)]/g,
        /第\s*(\d+)\s*\/\s*(\d+)\s*(?:位|人|例)?/g
      ]) {
        for (const match of item.matchAll(pattern)) {
          if (Number(match[1]) > Number(match[2])) claims.push(match[0]);
        }
      }
      for (const match of item.matchAll(/在\s*(\d+)\s*(?:条|例|个|人)[^。；，]{0,24}?排名第\s*(\d+)\s*(?:位|名)?/g)) {
        if (Number(match[2]) > Number(match[1])) claims.push(match[0]);
      }
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(claims)];
}

function selectionMetrics(parsed, fixture) {
  const selected = Array.isArray(parsed?.selectedProgrammeIds) ? parsed.selectedProgrammeIds : [];
  const reference = new Set(fixture.referenceIds);
  const hits = selected.filter(id => reference.has(id)).length;
  const decisions = parsed?.programmeDecisions || {};
  const candidateIds = fixture.input.projects.map(item => item.id);
  return {
    selectedCount: selected.length,
    referenceCount: reference.size,
    referenceRecall: reference.size ? hits / reference.size : null,
    referencePrecision: selected.length ? hits / selected.length : null,
    invalidDecisionCoverage: candidateIds.filter(id => !decisions[id]).length,
    selectedProgrammeIds: selected
  };
}

function assessmentMetrics(parsed, fixture) {
  const assessments = parsed?.assessments || {};
  const normalized = normalizeAgentAssessments(assessments, fixture.prepared);
  return {
    contractValid: Boolean(normalized[fixture.programmeId]),
    assessmentPresent: Boolean(assessments[fixture.programmeId]),
    unexpectedProgrammeIds: Object.keys(assessments).filter(id => id !== fixture.programmeId),
    caseCount: fixture.caseCount,
    evidenceCount: fixture.evidenceCount,
    center: normalized[fixture.programmeId]?.center ?? null,
    rangeWidth: normalized[fixture.programmeId]
      ? normalized[fixture.programmeId].high - normalized[fixture.programmeId].low : null
  };
}

function rankingMetrics(parsed, fixture) {
  const normalized = normalizeProbabilityCalibration(parsed, fixture.prepared);
  const rows = Object.entries(normalized).sort((a, b) => a[1].rank - b[1].rank);
  const actualOrder = rows.map(([id]) => id);
  const expectedPositions = new Map(fixture.referenceOrder.map((id, index) => [id, index]));
  const displacement = fixture.referenceOrder.length
    ? actualOrder.reduce((sum, id, index) => sum + Math.abs(index - (expectedPositions.get(id) ?? index)), 0) : null;
  return {
    coverage: actualOrder.length / fixture.programmeIds.length,
    uniqueRanks: new Set(rows.map(([, value]) => value.rank)).size === rows.length,
    rankOrder: actualOrder,
    top1ReferenceHit: fixture.referenceOrder.length ? actualOrder[0] === fixture.referenceOrder[0] : null,
    referenceOrderDisplacement: displacement,
    monotonicCenters: rows.every(([, value], index) => index === 0 || value.center < rows[index - 1][1].center),
    rangeWidths: Object.fromEntries(rows.map(([id, value]) => [id, value.high - value.low])),
    normalized
  };
}

function summarizeResults(results) {
  const groups = new Map();
  for (const item of results) {
    const key = `${item.provider}/${item.stage}`;
    const group = groups.get(key) || {
      provider: item.provider,
      stage: item.stage,
      calls: 0,
      contractValid: 0,
      usageKnown: 0,
      conservativeCostCny: 0,
      cacheAwareCostCny: 0,
      latencyMs: []
    };
    group.calls += 1;
    group.contractValid += Number(item.contractValid === true);
    group.usageKnown += Number(Boolean(item.usageBreakdown));
    group.conservativeCostCny += Number(item.usageBreakdown?.conservativeCostCny || 0);
    group.cacheAwareCostCny += Number(item.usageBreakdown?.cacheAwareCostCny || 0);
    group.latencyMs.push(Number(item.latencyMs || 0));
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    averageLatencyMs: group.latencyMs.length
      ? group.latencyMs.reduce((sum, value) => sum + value, 0) / group.latencyMs.length : null,
    costPerContractValidCny: group.contractValid
      ? group.conservativeCostCny / group.contractValid : null
  }));
}

function makeJobs() {
  const allFixtures = [
    ...selectionScenarios.map(selectionFixture),
    ...assessmentScenarios.map(assessmentFixture),
    ...rankingScenarios.map(rankingFixture)
  ];
  const fixtures = crossDiscipline
    ? allFixtures.filter(fixture => crossProfiles.some(profile => fixture.scenario.startsWith(`cross-${profile.id}-`)))
    : expandedDiscipline
    ? allFixtures.filter(fixture => expandedProfiles.some(profile => fixture.scenario.startsWith(`cross-${profile.id}-`)))
    : gpaFiveReview
    ? allFixtures.filter(fixture => fixture.scenario.startsWith(`cross-${gpaFiveProfile.id}-`))
    : nonEliteSweep
    ? allFixtures.filter(fixture => {
      const profile = nonEliteProfiles.find(item => fixture.scenario.startsWith(`cross-${item.id}-`));
      return profile && (fixture.stage === "selection"
        || fixture.stage === "assessment" && fixture.programmeId === profile.assessmentIds[0]
        || fixture.stage === "ranking" && ["electronic", "finance", "psychology", "design"].includes(profile.domain));
    })
    : schoolTierSmoke
    ? allFixtures.filter(fixture => fixture.scenario.startsWith("cross-school-tier-"))
    : gpaCompare
    ? allFixtures.filter(fixture => [gpaFiveProfile, gpaPercentProfile]
      .some(profile => fixture.scenario.startsWith(`cross-${profile.id}-`)))
    : qwenChallenger
    ? allFixtures.filter(fixture => qwenChallengerScenarios.has(fixture.scenario))
    : deepseekReview
      ? allFixtures.filter(fixture => deepseekReviewScenarios.has(fixture.scenario))
    : allFixtures.filter(fixture => !fixture.scenario.startsWith("cross-"));
  if (crossDiscipline) assert.equal(fixtures.length, 16, "跨专业测试场景集不完整");
  if (expandedDiscipline) assert.equal(fixtures.length, 8, "扩展测试场景集不完整");
  if (gpaFiveReview) assert.equal(fixtures.length, 4, "五分制跨专业测试场景集不完整");
  if (gpaCompare) assert.equal(fixtures.length, 8, "GPA与均分成对测试场景集不完整");
  if (schoolTierSmoke) assert.equal(fixtures.length, 4, "院校分层对照场景集不完整");
  if (nonEliteSweep) assert.equal(fixtures.length, 48, "非985/211跨方向对照场景集不完整");
  if (qwenChallenger) assert.equal(fixtures.length, qwenChallengerScenarios.size, "千问候选模型场景集不完整");
  if (deepseekReview) assert.equal(fixtures.length, deepseekReviewScenarios.size, "DeepSeek 提示词复测场景集不完整");
  return fixtures.flatMap(fixture => providers.map(provider => {
    const request = requestFor(provider, fixture);
    const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    assert.ok(requestBytes <= inputByteLimit, `${fixture.stage}/${fixture.scenario} 输入 ${requestBytes} bytes 超过预检上限 ${inputByteLimit}`);
    return {
      fixture,
      provider,
      request,
      requestBytes,
      maximumEstimatedCny: maximumEstimatedCost(provider, requestBytes, fixture.stage),
      promptHash: sha256(fixture.systemPrompt),
      inputHash: sha256(JSON.stringify({ prompt: fixture.systemPrompt, input: fixture.input }))
    };
  }));
}

const jobs = makeJobs();
const plannedMaximum = jobs.reduce((sum, job) => sum + job.maximumEstimatedCny, 0);
const running = process.argv.includes("--run");
const recheckArgument = process.argv.find(arg => arg.startsWith("--recheck="));
if (recheckArgument && running) throw new Error("离线复核不能与真实调用同时运行。");
const maxCnyArgument = process.argv.find(arg => arg.startsWith("--max-cny="));
const maxCny = Number(maxCnyArgument?.split("=")[1] || maxCnyDefault);

const plan = {
  mode: nonEliteSweep ? "non-elite-sweep" : schoolTierSmoke ? "school-tier-smoke" : gpaCompare ? "gpa-compare" : gpaFiveReview ? "gpa-five-review" : expandedDiscipline ? "cross-discipline-expanded" : crossDiscipline ? "cross-discipline" : deepseekReview ? "deepseek-review" : qwenChallenger ? "qwen-challenger" : running ? "run" : "dry-run",
  budgetCny: maxCny,
  stages: {
    selection: jobs.filter(item => item.fixture.stage === "selection").length,
    assessment: jobs.filter(item => item.fixture.stage === "assessment").length,
    ranking: jobs.filter(item => item.fixture.stage === "ranking").length
  },
  totalCalls: jobs.length,
  promptHashes: [...new Set(jobs.map(item => item.promptHash))],
  scenarios: [...new Map(jobs.map(job => [job.fixture.scenario, job.fixture])).values()].map(item => (
    item.stage === "selection"
      ? { stage: item.stage, scenario: item.scenario, projects: item.input.projects.length, referenceCount: item.referenceIds.length }
      : item.stage === "assessment"
        ? { stage: item.stage, scenario: item.scenario, programmeId: item.programmeId, approvedCaseCount: item.caseCount }
        : { stage: item.stage, scenario: item.scenario, projects: item.programmeIds.length, referenceCount: item.referenceOrder.length }
  )),
  calls: jobs.map(item => ({
    stage: item.fixture.stage,
    scenario: item.fixture.scenario,
    provider: item.provider.name,
    model: item.provider.model,
    requestBytes: item.requestBytes,
    inputHash: item.inputHash,
    conservativeEstimateCny: Number(item.maximumEstimatedCny.toFixed(4))
  })),
  combinedConservativeEstimateCny: Number(plannedMaximum.toFixed(4)),
  costSemantics: {
    preflight: "按请求大小和最大输出 token 的保守估算，用于阻止超预算，不是服务商账单",
    usageBased: "调用成功后按服务商返回 prompt/completion token 计算；同时保留缓存命中 token，价格变化或折扣仍需以账单为准",
    quality: "referenceRecall/referencePrecision 与 referenceOrder 只是临时人工标注指标，不是真实录取率"
  }
};

if (recheckArgument) {
  const runDir = resolve(recheckArgument.slice("--recheck=".length));
  const original = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
  const fixtures = new Map(jobs.map(job => [`${job.fixture.stage}/${job.fixture.scenario}`, job.fixture]));
  const rows = original.results.map(item => {
    const fixture = fixtures.get(`${item.stage}/${item.scenario}`);
    assert.ok(fixture && fixture.dataHash === item.dataHash, `原始资料与当前资料不一致：${item.scenario}`);
    let contractValid = false;
    if (item.parsed && fixture.stage === "selection") {
      try { validateProgrammeScreeningResult(item.parsed, fixture.input); contractValid = true; } catch {}
    } else if (item.parsed && fixture.stage === "assessment") {
      contractValid = Boolean(normalizeAgentAssessments(item.parsed.assessments, fixture.prepared)[fixture.programmeId]);
    } else if (item.parsed && fixture.stage === "ranking") {
      const metrics = rankingMetrics(item.parsed, fixture);
      contractValid = metrics.coverage === 1 && metrics.uniqueRanks && metrics.monotonicCenters;
    }
    return {
      stage: item.stage, scenario: item.scenario, provider: item.provider,
      originalContractValid: item.contractValid, recheckedContractValid: contractValid,
      impossibleRankClaims: impossibleRankClaims(item.parsed)
    };
  });
  const report = {
    source: join(runDir, "results.json"),
    note: "仅用已保存模型输出和当前校验规则离线复核，没有再次请求 API，也不能验证事实正确性。",
    summary: Object.fromEntries(providers.map(provider => {
      const own = rows.filter(item => item.provider === provider.name);
      return [provider.name, {
        calls: own.length,
        originalContractValid: own.filter(item => item.originalContractValid).length,
        recheckedContractValid: own.filter(item => item.recheckedContractValid).length
      }];
    })),
    rows
  };
  writeFileSync(join(runDir, "离线复核.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: join(runDir, "离线复核.json"),
    changed: rows.filter(item => item.originalContractValid !== item.recheckedContractValid).length,
    byProvider: Object.fromEntries(providers.map(provider => [provider.name,
      rows.filter(item => item.provider === provider.name && item.recheckedContractValid).length])) }, null, 2));
} else if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) console.log(JSON.stringify(plan, null, 2));

if (running) {
  const budgetCeiling = nonEliteSweep ? 5 : crossDiscipline || expandedDiscipline || gpaCompare ? 2 : deepseekReview || gpaFiveReview || schoolTierSmoke ? 1 : qwenChallenger ? 5 : 10;
  if (!Number.isFinite(maxCny) || maxCny <= 0 || maxCny > budgetCeiling) throw new Error(`本轮预算必须显式设置为 ${budgetCeiling} 元或更低；未发起模型请求。`);
  if (deepseekReview || crossDiscipline || expandedDiscipline || gpaFiveReview || gpaCompare || schoolTierSmoke || nonEliteSweep) {
    if (providers.length !== 1 || providers[0]?.model !== "deepseek-flash") {
      throw new Error("本轮复测只允许使用 deepseek-flash；未发起模型请求。");
    }
  } else if (qwenChallenger) {
    if (providers[0]?.model !== "qwen3.7-plus") throw new Error("候选实验只允许使用 qwen3.7-plus；未发起模型请求。");
  } else if (providers[0].model !== "qwen-flash-2025-07-28" || providers[1].model !== "deepseek-flash") {
    throw new Error("常规对比只支持千问 Flash 与 DeepSeek Flash；未发起模型请求。");
  }
  if (plannedMaximum > maxCny) throw new Error(`保守预估 ${plannedMaximum.toFixed(4)} 元超过预算 ${maxCny} 元，未发起模型请求。`);
  for (const provider of providers) {
    if (!provider.key) throw new Error(`缺少 ${provider.name} 的本机 API Key 环境变量；未发起模型请求。`);
    const url = new URL(provider.url);
    if (url.protocol !== "https:" || !/\/chat\/completions\/?$/i.test(url.pathname)) {
      throw new Error(`${provider.name} 接口地址必须是 HTTPS Chat Completions 完整路径。`);
    }
  }

  const runDir = join(outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(runDir, { recursive: true });
  const results = [];
  let usageBasedTotalCny = 0;
  let stoppedReason = null;

  for (const job of jobs) {
    const { fixture, provider, request } = job;
    const started = performance.now();
    const record = {
      stage: fixture.stage,
      scenario: fixture.scenario,
      programmeId: fixture.programmeId || null,
      provider: provider.name,
      requestedModel: provider.model,
      priceBasis: provider.priceBasis,
      promptHash: job.promptHash,
      inputHash: job.inputHash,
      dataHash: fixture.dataHash,
      requestBytes: job.requestBytes,
      caseCount: fixture.caseCount ?? null,
      request,
      startedAt: new Date().toISOString()
    };
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(60000)
      });
      record.httpStatus = response.status;
      const responseText = await response.text();
      let payload;
      try { payload = JSON.parse(responseText); } catch { throw new Error(`HTTP ${response.status} 返回非 JSON 内容`); }
      record.responseModel = payload.model || null;
      record.usage = payload.usage || null;
      record.finishReason = payload.choices?.[0]?.finish_reason || null;
      record.rawOutput = payload.choices?.[0]?.message?.content || "";
      record.usageBreakdown = usageBreakdown(provider, record.usage);
      if (!response.ok) throw new Error(String(payload.error?.message || `HTTP ${response.status}`).slice(0, 300));
      const parsed = parseModelJson(record.rawOutput, record.finishReason);
      record.parsed = parsed;
      record.impossibleRankClaims = impossibleRankClaims(parsed);
      if (fixture.stage === "selection") {
        validateProgrammeScreeningResult(parsed, fixture.input);
        record.metrics = selectionMetrics(parsed, fixture);
        record.contractValid = true;
      } else if (fixture.stage === "assessment") {
        record.metrics = assessmentMetrics(parsed, fixture);
        record.contractValid = record.metrics.contractValid;
      } else {
        record.metrics = rankingMetrics(parsed, fixture);
        record.contractValid = record.metrics.coverage === 1
          && record.metrics.uniqueRanks && record.metrics.monotonicCenters;
      }
    } catch (error) {
      record.error = String(error.message || error);
      record.contractValid = false;
    }
    record.latencyMs = Math.round(performance.now() - started);
    results.push(record);
    if (record.usageBreakdown) usageBasedTotalCny += record.usageBreakdown.conservativeCostCny;
    writeFileSync(join(runDir, "results.json"), JSON.stringify({
      syntheticFixture: true,
      budgetCny: maxCny,
      plannedMaximumCny: plannedMaximum,
      usageBasedTotalCny,
      stoppedReason,
      summary: summarizeResults(results),
      results
    }, null, 2));
    console.log(`${fixture.stage} / ${fixture.scenario} / ${provider.name}: ${record.contractValid ? "通过结构校验" : "未通过"}，${record.latencyMs}ms，${record.usageBreakdown?.conservativeCostCny ?? "费用未知"}元(用量估算)`);
    if (!record.usageBreakdown) {
      stoppedReason = "服务商未返回可核对的 token 用量，停止后续调用";
      break;
    }
  }

  const rows = [[
    "层级", "场景", "模型", "结构校验", "耗时ms", "输入tokens", "缓存tokens", "输出tokens",
    "费用估算元", "缓存口径费用元", "案例数", "召回率/覆盖率", "精确率/Top1", "排序位移", "明显不可能的名次", "人工事实错误数", "人工引用错误数", "人工硬性条件错误数", "人工建议可用性0-2", "人工备注"
  ], ...results.map(item => {
    const metrics = item.metrics || {};
    return [item.stage, item.scenario, item.provider, item.contractValid ? "是" : "否", item.latencyMs,
      item.usageBreakdown?.inputTokens ?? "", item.usageBreakdown?.cachedTokens ?? "", item.usageBreakdown?.outputTokens ?? "",
      item.usageBreakdown?.conservativeCostCny ?? "", item.usageBreakdown?.cacheAwareCostCny ?? "", item.caseCount ?? "",
      metrics.referenceRecall ?? metrics.coverage ?? "", metrics.referencePrecision ?? metrics.top1ReferenceHit ?? "",
      metrics.referenceOrderDisplacement ?? "", (item.impossibleRankClaims || []).join("；"), "", "", "", "", ""];
  })];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  writeFileSync(join(runDir, "人工评分表.csv"), `\ufeff${csv}`);
  const summary = summarizeResults(results);
  writeFileSync(join(runDir, "结果汇总.json"), JSON.stringify({
    budgetCny: maxCny,
    plannedMaximumCny: plannedMaximum,
    usageBasedTotalCny,
    summary,
    note: "contractValid 是程序结构验收，不代表事实正确；人工评分完成后再决定模型优劣。"
  }, null, 2));
  writeFileSync(join(runDir, "实验计划.json"), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ runDir, completedCalls: results.length, usageBasedTotalCny, stoppedReason, summary }, null, 2));
}
