import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listApprovedCases, openCaseStore } from "../collector/store.mjs";
import * as agent from "../miniprogram/cloudfunctions/admissionApi/agent/runtime.mjs";
import { standardizeGpa } from "../miniprogram/cloudfunctions/admissionApi/agent/case-analysis.mjs";
import { normalizeAssessment } from "../miniprogram/cloudfunctions/admissionApi/agent/assessment-contract.mjs";
import { resolveExactInstitution } from "../master-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagedData = Boolean(process.env.ADMISSION_AGENT_DATA_DIR);
const dataDirectory = resolve(process.env.ADMISSION_AGENT_DATA_DIR || join(root, "miniprogram/cloud-data"));
const catalogueDirectory = packagedData
  ? dataDirectory
  : join(root, "miniprogram/cloudfunctions/admissionApi");
const require = createRequire(import.meta.url);
const { selectEvidenceCases, summarizeEvidenceCase } = require("../miniprogram/cloudfunctions/admissionApi/logic.js");

function readJsonLines(name) {
  const fileName = packagedData
    ? { cases: "cases.jsonl", programmes: "programmes.jsonl", "programme-evidence": "programme-evidence.jsonl" }[name]
    : { cases: "cases.json", programmes: "programmes.json", "programme-evidence": "programme_evidence.json" }[name];
  const file = join(dataDirectory, fileName || `${name}.jsonl`);
  if (!existsSync(file)) throw new Error(`找不到旧版 Agent 数据：${name}`);
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`旧版 Agent 数据格式错误：${name} 第 ${index + 1} 行`); }
  });
}

const cataloguePath = join(catalogueDirectory, "catalog.json");
if (!existsSync(cataloguePath)) throw new Error("找不到旧版 Agent 项目目录数据。");
const catalogue = JSON.parse(readFileSync(cataloguePath, "utf8"));
const allCases = readJsonLines("cases").filter(item => item.reviewStatus === "approved");
const programmeRows = readJsonLines("programmes");
const officialRows = readJsonLines("programme-evidence");
const programmeById = new Map(programmeRows.map(item => [item.programmeId, item]));
const casesByProgramme = new Map();
const evidenceByProgramme = new Map();
function compactExperience(value) {
  return (Array.isArray(value) ? value : []).map(item => typeof item === "string" ? item : String(item?.raw || item?.description || item?.title || "")).filter(Boolean);
}

export function toAgentCase(row) {
  return {
    _id: row.fingerprint,
    programmeId: row.targetProgrammeId,
    targetInstitutionId: row.targetInstitutionId,
    offerYear: row.offerYear,
    undergraduate: {
      institutionId: row.undergraduateInstitutionId || null,
      university: row.undergraduateUniversity || null,
      major: row.undergraduateMajor || null
    },
    gpa: { raw: row.gpaRaw || null, scale: row.gpaScale || "UNKNOWN", value100: Number(row.gpa100) || 0 },
    language: { test: row.languageTest || null, scale: row.languageScale || null, score: Number(row.languageScore) || 0 },
    experiences: {
      internships: compactExperience(row.internships),
      work: compactExperience(row.workExperience),
      research: compactExperience(row.research),
      competitions: compactExperience(row.competitions),
      awards: compactExperience(row.awards),
      patents: compactExperience(row.patents),
      projects: compactExperience(row.projects)
    },
    experienceTags: [],
    qualityScore: Number(row.completenessScore) || 0,
    reviewStatus: "approved"
  };
}

export function refreshApprovedCases() {
  casesByProgramme.clear();
  const add = item => {
    if (!item.programmeId) return;
    const rows = casesByProgramme.get(item.programmeId) || [];
    rows.push(item);
    casesByProgramme.set(item.programmeId, rows);
  };
  if (!packagedData) { allCases.forEach(add); return; }
  const originalById = new Map(allCases.map(item => [item._id, item]));
  const db = openCaseStore();
  try {
    listApprovedCases(db).forEach(row => {
      const live = toAgentCase(row);
      const original = originalById.get(row.fingerprint);
      add(original ? {
        ...original, ...live,
        undergraduate: { ...original.undergraduate, ...live.undergraduate },
        experiences: { ...original.experiences, ...live.experiences },
        experienceTags: original.experienceTags || []
      } : live);
    });
  }
  finally { db.close(); }
}

refreshApprovedCases();
for (const item of officialRows) {
  const rows = evidenceByProgramme.get(item.programmeId) || [];
  rows.push(item);
  evidenceByProgramme.set(item.programmeId, rows);
}

const selectedStrings = value => [...new Set((Array.isArray(value) ? value : []).map(String).map(item => item.trim()).filter(Boolean))];

export function citedEvidenceSnapshots(selection = [], evidenceUsed = []) {
  const citedIds = new Set(evidenceUsed.map(item => String(item.documentId)));
  return selection.filter(document => citedIds.has(String(document.id))).map(document => ({
    id: document.id,
    title: document.title,
    provenance: document.provenance,
    text: document.text,
    checkedAt: document.metadata?.checkedAt || null
  }));
}
const clampTimeout = (value, fallback, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || fallback));

export async function runWithConcurrency(items, limit, task) {
  const values = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { values[index] = { status: "fulfilled", value: await task(items[index], index) }; }
      catch (reason) { values[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return values;
}

async function requestAgent(prompt, input, timeoutMs = 60000, thinking = "disabled") {
  const apiUrl = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!apiUrl || !apiKey || !model) throw new Error("请先在模型 API 设置中填写接口地址、API Key 和模型名称。");
  let target;
  try { target = new URL(apiUrl); } catch { throw new Error("模型 API 地址无效。"); }
  if (target.protocol !== "https:") throw new Error("模型 API 必须使用 HTTPS。");

  let response;
  try {
    const body = {
      model,
      temperature: 0,
      max_tokens: Math.min(4000, Math.max(2000, Number(process.env.AI_MAX_TOKENS || 4000))),
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(input) }
      ],
      response_format: { type: "json_object" }
    };
    if (["enabled", "disabled"].includes(thinking)) body.thinking = { type: thinking };
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error("模型接口请求超时。");
    throw new Error("模型接口连接失败，请检查网络和 API 地址。");
  }

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`模型接口未返回 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) {
    throw new Error(String(payload?.error?.message || `模型接口请求失败（${response.status}）`).slice(0, 300));
  }
  return agent.parseModelJson(payload?.choices?.[0]?.message?.content, payload?.choices?.[0]?.finish_reason);
}

async function runProjectScreening(profile, payload, candidates, fullEvidenceByProgramme = null) {
  const timeoutMs = clampTimeout(process.env.SCREENING_AI_TIMEOUT_MS, 10000, 5000, 12000);
  const projects = agent.buildScreeningProjects(candidates, fullEvidenceByProgramme);
  if (!projects.length) throw new Error("第一层候选项目卡片为空");
  const chunks = [];
  for (let index = 0; index < projects.length; index += 8) chunks.push(projects.slice(index, index + 8));
  const results = await Promise.all(chunks.map(async projectChunk => {
    const input = {
      screeningStage: fullEvidenceByProgramme ? "full-review" : chunks.length > 1 ? "card-chunk" : "card",
      profile: { structured: profile, narrative: String(payload.profileText || "") || null },
      requestedRegions: payload.regions || [],
      requestedFields: payload.fields || [],
      projects: projectChunk
    };
    return agent.validateProgrammeScreeningResult(
      await requestAgent(agent.screeningPrompt, input, timeoutMs, process.env.PROJECT_SCREENING_AI_THINKING || "disabled"),
      input
    );
  }));
  return agent.mergeScreeningResults(results, 8);
}

function loadProgrammeCards(candidates) {
  return candidates.map(item => ({ ...item, ...(programmeById.get(item.id) || {}) }));
}

export function loadAnalysisEvidence(candidates, profile) {
  const evidence = Object.fromEntries(candidates.map(programme => {
    const programmeCases = casesByProgramme.get(programme.id) || [];
    const cases = selectEvidenceCases(programmeCases, profile, 5);
    const official = [...(evidenceByProgramme.get(programme.id) || [])]
      .sort((left, right) => Number(["requirements", "curriculum", "orientation"].includes(right.section))
        - Number(["requirements", "curriculum", "orientation"].includes(left.section)))
      .map(item => ({
        ...item,
        id: String(item._id || ""),
        text: String(item.text || "").slice(0, 10000),
        academicYears: item.academicYears || [],
        checkedAt: item.checkedAt || null
      }));
    return [programme.id, { allCases: programmeCases, cases, official }];
  }));
  const cards = loadProgrammeCards(candidates).map(item => ({
    ...item,
    caseCount: (casesByProgramme.get(item.id) || []).length
  }));
  return {
    candidates: cards,
    evidenceByProgramme: evidence,
    retrievedCaseCount: Object.values(evidence).reduce((sum, item) => sum + item.allCases.length, 0)
  };
}

async function runAgentAssessments(prepared) {
  const timeoutMs = clampTimeout(process.env.ASSESSMENT_AI_TIMEOUT_MS, 30000, 15000, 32000);
  const calibrationTimeoutMs = clampTimeout(process.env.CALIBRATION_AI_TIMEOUT_MS, 18000, 10000, 25000);
  const thinking = process.env.ASSESSMENT_AI_THINKING || process.env.AI_THINKING || "disabled";
  const comparisonProgrammes = prepared.modelInput.programmes.map(programme => ({
    id: programme.id,
    name: programme.name,
    nameEn: programme.nameEn,
    officialRequirements: programme.officialRequirements,
    languageAssessment: programme.languageAssessment,
    positioning: programme.positioning,
    curriculum: programme.curriculum,
    focusTags: programme.focusTags,
    majorTags: programme.majorTags,
    courseTags: programme.courseTags,
    caseDistribution: programme.caseDistribution
  }));
  const calibrationInput = {
    profile: prepared.modelInput.profile,
    programmes: comparisonProgrammes.map(programme => ({
      ...programme,
      officialRequirements: String(programme.officialRequirements || "").slice(0, 2000),
      curriculum: String(programme.curriculum || "").slice(0, 1500),
      positioning: String(programme.positioning || "").slice(0, 1000)
    }))
  };
  const settled = await runWithConcurrency(prepared.modelInput.programmes, 2, programme => requestAgent(
    agent.assessmentPrompt,
    { ...prepared.modelInput, programmes: [programme], comparisonProgrammes },
    timeoutMs,
    thinking
  ));
  const academicCalibration = agent.buildAcademicCalibrationRequest(calibrationInput);
  const calibrationResult = await requestAgent(
    agent.probabilityCalibrationPrompt, academicCalibration.input, calibrationTimeoutMs, thinking
  ).then(value => ({ value })).catch(error => ({ error }));
  const assessments = {};
  const errors = [];
  settled.forEach((result, index) => {
    const programmeId = prepared.modelInput.programmes[index].id;
    if (result.status === "fulfilled" && result.value?.assessments?.[programmeId]) {
      assessments[programmeId] = result.value.assessments[programmeId];
    } else {
      errors.push(`${programmeId}:${result.status === "rejected"
        ? result.reason?.message || "模型调用失败"
        : "模型未返回项目判断"}`);
    }
  });
  if (calibrationResult.error) errors.push(`横向概率校准:${calibrationResult.error.message || "模型调用失败"}`);
  return { assessments, calibration: calibrationResult.value || null, academicBand: academicCalibration.band, errors };
}

function toDisplayCase(item) {
  if (!item) return null;
  const experiences = item.experiences || {};
  const count = values => (Array.isArray(values) ? values.length : 0);
  const summary = (value, label) => ({ count: value, level: value ? label : null });
  return {
    fingerprint: String(item._id || ""),
    cycle: Number(item.offerYear) || "年份未披露",
    school: item.undergraduate?.university || "本科背景未披露",
    major: item.undergraduate?.major || "专业未披露",
    gpaRaw: item.gpa?.raw || "成绩未披露",
    languageTest: item.language?.test || "",
    language: item.language?.score ?? null,
    experienceSummary: {
      internships: summary(count(experiences.internships), "公开披露"),
      research: summary(count(experiences.research), "公开披露"),
      projects: summary(count(experiences.projects), "公开披露"),
      competitions: summary(count(experiences.competitions) + count(experiences.awards), "公开披露"),
      patents: summary(count(experiences.patents), "公开披露")
    }
  };
}

export function displayProgramme(programme, cases, evidenceRows = []) {
  const displayed = {
    ...programme,
    school: programme.university || programme.school,
    name: programme.nameEn || programme.name,
    officialNote: programme.requirements || programme.officialNote || "",
    overview: programme.positioning || programme.overview || "",
    courseOrientation: programme.orientation || programme.curriculum || "",
    curriculumStructure: programme.curriculum || programme.orientation || "",
    cases,
    _programmeProvenance: { ...(programme._programmeProvenance || {}) }
  };
  const fields = {
    requirements: ["officialNote", "requirements"],
    positioning: ["overview", "positioning"],
    duration: ["duration", "positioning"],
    curriculum: ["curriculumStructure", "curriculum"],
    orientation: ["courseOrientation", "orientation"]
  };
  for (const row of evidenceRows) {
    if (!fields[row.section] || !["official", "official-structured"].includes(row.provenance)) continue;
    const [field, provenanceField] = fields[row.section];
    if (String(displayed[field] || "").trim() || !String(row.text || "").trim()) continue;
    displayed[field] = String(row.text).trim();
    displayed._programmeProvenance[provenanceField] = "official-structured-snapshot";
    const checkedAt = String(row.checkedAt || "").slice(0, 10);
    if (checkedAt && (!displayed._programmeEvidenceSnapshot || checkedAt > displayed._programmeEvidenceSnapshot)) {
      displayed._programmeEvidenceSnapshot = checkedAt;
    }
  }
  return displayed;
}

export async function analyzeWithLegacyAgent(payload = {}) {
  refreshApprovedCases();
  const submittedProfile = payload.profile || {};
  const verifiedInstitution = resolveExactInstitution(submittedProfile.university);
  const profile = verifiedInstitution ? {
    ...submittedProfile,
    schoolTier: verifiedInstitution.scoreTier,
    schoolClassification: verifiedInstitution.classification
  } : { ...submittedProfile, schoolTier: null, schoolClassification: null };
  const maximumGpa = { "100": 100, "4": 4, "5": 5 }[String(profile.gpaScale)];
  if (!profile.university || !profile.majorName || !Number.isFinite(Number(profile.gpaValue))) {
    throw new Error("本科院校、专业和成绩信息不完整。");
  }
  if (!maximumGpa || Number(profile.gpaValue) <= 0 || Number(profile.gpaValue) > maximumGpa) {
    throw new Error("成绩超出所选分制的有效范围。");
  }

  const analysisProfile = {
    ...profile,
    targetFields: selectedStrings(payload.fields),
    profileText: String(payload.profileText || "").slice(0, 5000)
  };
  analysisProfile.gpaStandardization = standardizeGpa(analysisProfile);
  const candidates = agent.selectScreeningCandidates(catalogue.programmes, payload, 16);
  if (!candidates.length) throw new Error("没有找到符合当前地区、学校和方向筛选的项目。");
  const programmeCards = loadProgrammeCards(candidates);

  let cardScreening;
  try {
    cardScreening = await runProjectScreening(analysisProfile, payload, programmeCards);
    if (!cardScreening.selectedProgrammeIds.length) throw new Error("项目初筛模型没有保留候选项目");
  } catch (error) {
    throw new Error(`项目初筛失败：${error.message || "模型未及时返回"}`);
  }

  const uncertainIds = cardScreening.selectedProgrammeIds
    .filter(id => String(cardScreening.programmeDecisions[id]?.decision || "").toLowerCase() === "uncertain");
  let fullScreening = null;
  if (uncertainIds.length) {
    try {
      const uncertainCandidates = programmeCards.filter(item => uncertainIds.includes(item.id));
      const uncertainEvidence = loadAnalysisEvidence(uncertainCandidates, analysisProfile);
      fullScreening = await runProjectScreening(
        analysisProfile, payload, uncertainEvidence.candidates, uncertainEvidence.evidenceByProgramme
      );
    } catch (error) {
      cardScreening.fullReviewFallbackReason = String(error?.message || "完整项目复核超时");
    }
  }

  const screening = agent.finalizeProgrammeScreening(cardScreening, fullScreening, programmeCards, {
    profileMajor: analysisProfile.major,
    requestedFields: selectedStrings(payload.fields),
    targetSchools: selectedStrings(payload.targetSchools),
    maximum: 8
  });
  const selectedCandidates = programmeCards.filter(item => screening.selectedProgrammeIds.includes(item.id));
  const loaded = loadAnalysisEvidence(selectedCandidates, analysisProfile);
  if (!loaded.candidates.length) throw new Error("完整项目资料复核后没有保留可分析项目。");

  const evidenceByProgramme = Object.fromEntries(screening.selectedProgrammeIds.map(id => [id, loaded.evidenceByProgramme[id]]));
  const prepared = agent.prepareAgentAnalysis(analysisProfile, loaded.candidates, evidenceByProgramme, 6);
  const generated = await runAgentAssessments(prepared);
  const normalized = agent.normalizeAgentAssessments(generated.assessments, prepared);
  const calibration = agent.normalizeProbabilityCalibration(generated.calibration, prepared, generated.academicBand);
  const calibrationValid = Object.keys(calibration).length === prepared.modelInput.programmes.length;
  if (generated.academicBand && !calibrationValid) {
    throw new Error('院校档次横向对照未通过校验，本次不展示未经检查的参考数值。请重试。');
  }
  const assessments = agent.mergeProbabilityCalibration(normalized, calibration, prepared);
  const comparisonProfile = prepared.modelInput.profile.structured;
  const assessmentErrors = [...generated.errors];
  if (!calibrationValid && prepared.modelInput.programmes.length > 1) {
    assessmentErrors.push('横向排序结果未通过结构或证据边界校验，已退回单项目参考值；请勿把它当作有效的横向校准。');
  }
  for (const programme of prepared.modelInput.programmes) {
    if (assessments[programme.id] || !generated.assessments?.[programme.id]) continue;
    assessmentErrors.push(`${programme.id}:模型输出未通过证据契约校验`);
  }

  const allCaseRows = Object.fromEntries(screening.selectedProgrammeIds.map(id => [
    id,
    new Map((evidenceByProgramme[id]?.allCases || []).map(item => [String(item._id), item]))
  ]));
  const insights = {};
  const results = prepared.comparisons.map(({ programme, result }) => {
    const assessment = assessments[programme.id] || null;
    const selection = prepared.evidenceSelections[programme.id] || [];
    insights[programme.id] = assessment ? {
      fit: assessment.fit || [],
      psCv: assessment.psCv || [],
      reasoning: assessment.reasoning || [],
      uncertainties: assessment.uncertainties || [],
      evidenceUsed: assessment.evidenceUsed || [],
      reviewEvidence: citedEvidenceSnapshots(selection, assessment.evidenceUsed || [])
    } : { fit: [], psCv: [], reasoning: [], uncertainties: [], evidenceUsed: [] };

    const caseOrder = selection.filter(document => document.provenance === "public-case").map(document => document.id);
    const caseRows = allCaseRows[programme.id];
    const cases = caseOrder.map(id => toDisplayCase(caseRows.get(String(id)))).filter(Boolean);
    const nearestRow = caseRows.get(String(result.nearest?.fingerprint || ""));
    const displayResult = { ...result, nearest: toDisplayCase(nearestRow), ...(assessment || {}) };
    const displayedProgramme = displayProgramme(programme, cases, evidenceByProgramme[programme.id]?.official);
    displayedProgramme.caseCount = evidenceByProgramme[programme.id]?.allCases?.length || 0;
    const assessmentError = assessmentErrors.find(message => message.startsWith(`${programme.id}:`));
    const evidenceCases = caseOrder.map(id => caseRows.get(String(id))).filter(Boolean).map(item => ({
      ...summarizeEvidenceCase(item, comparisonProfile),
      isNearest: String(item._id) === String(result.nearest?.fingerprint || "")
    }));
    return {
      programme: displayedProgramme,
      result: displayResult,
      evidenceCases,
      assessmentError: assessmentError ? assessmentError.slice(programme.id.length + 1) : ""
    };
  }).sort((left, right) => Number(Boolean(right.result.assessmentAvailable)) - Number(Boolean(left.result.assessmentAvailable))
    || Number(right.result.center || 0) - Number(left.result.center || 0));

  const completed = Object.keys(assessments).length;
  return {
    results,
    insights,
    message: completed
      ? `旧版两层 Agent 已筛选 ${results.length} 个项目，读取 ${loaded.retrievedCaseCount} 条审核成功案例，并完成 ${completed}/${results.length} 个有证据引用的判断。${calibrationValid ? '' : '本轮横向排序未通过校验，页面仅展示单项目模型估计值。'}`
      : "旧版两层 Agent 已完成项目筛选和案例检索，但评估结果未通过证据契约校验，因此不生成概率。",
    mode: completed ? "legacy-two-stage-rag-ai-assessment" : "legacy-evidence-only",
    screening: {
      card: cardScreening,
      fullReview: fullScreening,
      final: screening,
      selectedProgrammeIds: screening.selectedProgrammeIds
    },
    assessmentExecution: {
      requested: results.length,
      completed,
      failed: results.length - completed,
      calibrationValid,
      errors: assessmentErrors
    }
  };
}
