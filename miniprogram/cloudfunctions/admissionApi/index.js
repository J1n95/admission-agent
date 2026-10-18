const cloud = require('wx-server-sdk');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const catalogue = require('./catalog.json');
const {
  searchInstitutions, searchMajors, selectEvidenceCases, summarizeEvidenceCase, isOpenidLimitExempt
} = require('./logic');
const agentRuntimePromise = import('./agent/runtime.mjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const command = db.command;

const ok = data => ({ ok: true, data });
const fail = message => ({ ok: false, message: String(message || '请求失败') });
const collectionHint = error => /collection|集合|DATABASE_COLLECTION_NOT_EXIST/i.test(String(error?.message || error?.errMsg || ''))
  ? new Error('云数据库尚未初始化，请创建 analyses、feedback、cases、programmes 和 programme_evidence 集合并导入数据。')
  : error;
const parseJson = value => {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
};
const selectedStrings = value => [...new Set((Array.isArray(value) ? value : []).map(String).map(item => item.trim()).filter(Boolean))];

function postJson(url, body, timeoutMs = 45000) {
  const target = new URL(url);
  if (target.protocol !== 'https:') return Promise.reject(new Error('AI_API_URL 必须使用 HTTPS'));
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.AI_API_KEY}`
      }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let payload;
        try { payload = JSON.parse(text); } catch { return reject(new Error('模型接口未返回 JSON')); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(payload?.error?.message || `模型接口请求失败（${response.statusCode}）`));
        }
        resolve(payload);
      });
    });
    request.on('timeout', () => request.destroy(new Error('模型接口请求超时')));
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function requestAgent(prompt, input, timeoutMs = 60000, thinking = 'disabled') {
  if (!process.env.AI_API_URL || !process.env.AI_API_KEY || !process.env.AI_MODEL) {
    throw new Error('旧版 Agent 所需的 AI_API_URL、AI_API_KEY 或 AI_MODEL 尚未配置');
  }
  const body = {
    model: process.env.AI_MODEL,
    temperature: 0,
    max_tokens: Math.min(4000, Math.max(2000, Number(process.env.AI_MAX_TOKENS || 4000))),
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(input) }
    ],
    response_format: { type: 'json_object' }
  };
  if (['enabled', 'disabled'].includes(thinking)) body.thinking = { type: thinking };
  const payload = await postJson(process.env.AI_API_URL, body, timeoutMs);
  return parseJson(payload?.choices?.[0]?.message?.content);
}

async function runProjectScreening(agent, profile, payload, candidates, fullEvidenceByProgramme = null) {
  const timeoutMs = Math.min(12000, Math.max(5000, Number(process.env.SCREENING_AI_TIMEOUT_MS || 10000)));
  const projects = agent.buildScreeningProjects(candidates, fullEvidenceByProgramme);
  if (!projects.length) throw new Error('第一层候选项目卡片为空');
  const chunks = [];
  for (let index = 0; index < projects.length; index += 8) chunks.push(projects.slice(index, index + 8));
  const results = await Promise.all(chunks.map(async projectChunk => {
    const input = {
      screeningStage: fullEvidenceByProgramme ? 'full-review' : chunks.length > 1 ? 'card-chunk' : 'card',
      profile: { structured: profile, narrative: String(payload.profileText || '') || null },
      requestedRegions: payload.regions || [], requestedFields: payload.fields || [], projects: projectChunk
    };
    return agent.validateProgrammeScreeningResult(
      await requestAgent(agent.screeningPrompt, input, timeoutMs, process.env.PROJECT_SCREENING_AI_THINKING || 'disabled'),
      input
    );
  }));
  return agent.mergeScreeningResults(results, 8);
}

async function loadProgrammeCards(candidates) {
  const ids = candidates.map(item => item.id);
  try {
    const rows = await db.collection('programmes').where({ programmeId: command.in(ids) }).limit(30).get();
    const byId = new Map((rows.data || []).map(item => [item.programmeId, item]));
    return candidates.map(item => ({ ...item, ...(byId.get(item.id) || {}) }));
  } catch (error) {
    throw collectionHint(error);
  }
}

async function loadAnalysisEvidence(candidates, profile) {
  const ids = candidates.map(item => item.id);
  let programmeRows;
  let officialRows;
  let caseRows;
  const loadAll = async (collectionName, programmeId) => {
    const rows = [];
    while (true) {
      const page = await db.collection(collectionName).where({ programmeId }).skip(rows.length).limit(100).get();
      rows.push(...(page.data || []));
      if ((page.data || []).length < 100) return rows;
    }
  };
  try {
    [programmeRows, officialRows, caseRows] = await Promise.all([
      db.collection('programmes').where({ programmeId: command.in(ids) }).limit(20).get(),
      Promise.all(ids.map(programmeId => loadAll('programme_evidence', programmeId))),
      Promise.all(ids.map(programmeId => loadAll('cases', programmeId)))
    ]);
  } catch (error) {
    throw collectionHint(error);
  }
  const programmeById = new Map((programmeRows.data || []).map(item => [item.programmeId, item]));
  const enrichedCandidates = candidates.map(item => ({ ...item, ...(programmeById.get(item.id) || {}) }));
  const evidenceByProgramme = Object.fromEntries(ids.map((programmeId, index) => {
    const allCases = caseRows[index] || [];
    const cases = selectEvidenceCases(allCases, profile, 5);
    const official = (officialRows[index] || [])
      .sort((left, right) => Number(['requirements', 'curriculum', 'orientation'].includes(right.section))
        - Number(['requirements', 'curriculum', 'orientation'].includes(left.section)))
      .map(item => ({
        id: item._id, _id: item._id, section: item.section, title: item.title,
        text: String(item.text || '').slice(0, 10000), provenance: item.provenance,
        academicYears: item.academicYears || [], checkedAt: item.checkedAt || null
      }));
    return [programmeId, { allCases, cases, official }];
  }));
  const retrievedCaseCount = Object.values(evidenceByProgramme).reduce((sum, value) => sum + value.allCases.length, 0);
  if (!programmeRows.data?.length) throw new Error('云数据库尚未导入 programmes 项目资料。');
  return { candidates: enrichedCandidates, evidenceByProgramme, retrievedCaseCount };
}

async function enforceDailyLimit(openid) {
  if (isOpenidLimitExempt(openid, process.env.LIMIT_EXEMPT_OPENIDS)) return;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  const perUser = Math.max(1, Number(process.env.PER_USER_DAILY_LIMIT || 3));
  const global = Math.max(perUser, Number(process.env.GLOBAL_DAILY_LIMIT || 200));
  const collection = db.collection('analyses');
  const [userRows, globalCount] = await Promise.all([
    collection.where({ openid, createdAtMs: command.gte(since) }).limit(100).get(),
    collection.where({ createdAtMs: command.gte(since) }).count()
  ]);
  const activeSince = Date.now() - 2 * 60 * 1000;
  const userCount = (userRows.data || []).filter(item => item.status === 'completed'
    || item.status === 'processing' && Number(item.createdAtMs) >= activeSince).length;
  if (userCount >= perUser) throw new Error(`今天每位用户最多生成 ${perUser} 次，请明天再试。`);
  if (globalCount.total >= global) throw new Error('今日公开测试名额已用完，请明天再试。');
}

async function runAgentAssessments(agent, prepared) {
  const timeoutMs = Math.min(32000, Math.max(15000, Number(process.env.ASSESSMENT_AI_TIMEOUT_MS || 30000)));
  const thinking = process.env.ASSESSMENT_AI_THINKING || process.env.AI_THINKING || 'disabled';
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
  const calibrationTimeoutMs = Math.min(25000, Math.max(10000, Number(process.env.CALIBRATION_AI_TIMEOUT_MS || 18000)));
  const calibrationInput = {
    profile: prepared.modelInput.profile,
    programmes: comparisonProgrammes.map(programme => ({
      ...programme,
      officialRequirements: String(programme.officialRequirements || '').slice(0, 2000),
      curriculum: String(programme.curriculum || '').slice(0, 1500),
      positioning: String(programme.positioning || '').slice(0, 1000)
    }))
  };
  const academicCalibration = agent.buildAcademicCalibrationRequest(calibrationInput);
  const [settled, calibrationResult] = await Promise.all([
    Promise.allSettled(prepared.modelInput.programmes.map(programme => requestAgent(
    agent.assessmentPrompt,
    { ...prepared.modelInput, programmes: [programme], comparisonProgrammes },
    timeoutMs,
    thinking
    ))),
    requestAgent(agent.probabilityCalibrationPrompt, academicCalibration.input, calibrationTimeoutMs, thinking)
      .then(value => ({ value })).catch(error => ({ error }))
  ]);
  const assessments = {};
  const errors = [];
  settled.forEach((result, index) => {
    const programmeId = prepared.modelInput.programmes[index].id;
    if (result.status === 'fulfilled' && result.value?.assessments?.[programmeId]) {
      assessments[programmeId] = result.value.assessments[programmeId];
      return;
    }
    errors.push(`${programmeId}:${result.status === 'rejected'
      ? result.reason?.message || '模型调用失败'
      : '模型未返回项目判断'}`);
  });
  if (calibrationResult.error) errors.push(`横向概率校准:${calibrationResult.error.message || '模型调用失败'}`);
  return { assessments, calibration: calibrationResult.value || null, academicBand: academicCalibration.band, errors };
}

async function createAnalysis(payload, openid) {
  if (payload?.consent !== true) throw new Error('请先同意信息保存与反馈授权。');
  const profile = payload.profile || {};
  if (!profile.university || !profile.majorName || !Number.isFinite(Number(profile.gpaValue))) throw new Error('本科院校、专业和成绩信息不完整。');
  const gpaMaximum = { '100': 100, '4': 4, '5': 5 }[String(profile.gpaScale)];
  if (!gpaMaximum || Number(profile.gpaValue) <= 0 || Number(profile.gpaValue) > gpaMaximum) {
    throw new Error('成绩超出所选分制的有效范围。');
  }
  await enforceDailyLimit(openid);
  const analysisId = randomBytes(16).toString('hex');
  const record = {
    _id: analysisId, openid, status: 'processing', createdAtMs: Date.now(), createdAt: db.serverDate(),
    applicant: {
      profile, profileText: String(payload.profileText || '').slice(0, 5000),
      regions: selectedStrings(payload.regions), targetSchools: selectedStrings(payload.targetSchools),
      fields: selectedStrings(payload.fields), consentVersion: '2026-08-26'
    }
  };
  try { await db.collection('analyses').add({ data: record }); } catch (error) { throw collectionHint(error); }
  try {
    const agent = await agentRuntimePromise;
    const analysisProfile = {
      ...profile,
      targetFields: selectedStrings(payload.fields),
      profileText: String(payload.profileText || '').slice(0, 5000)
    };
    const retrievedCandidates = agent.selectScreeningCandidates(catalogue.programmes, payload, 16);
    if (!retrievedCandidates.length) throw new Error('没有找到符合当前地区、学校和方向筛选的项目。');
    const programmeCards = await loadProgrammeCards(retrievedCandidates);
    let cardScreening;
    try {
      cardScreening = await runProjectScreening(agent, analysisProfile, payload, programmeCards);
      if (!cardScreening.selectedProgrammeIds.length) throw new Error('项目初筛模型没有保留候选项目');
    } catch (error) {
      throw new Error(`项目初筛失败：${error.message || '模型未及时返回'}`);
    }

    const uncertainIds = cardScreening.selectedProgrammeIds
      .filter(id => String(cardScreening.programmeDecisions[id]?.decision || '').toLowerCase() === 'uncertain');
    let fullScreening = null;
    if (uncertainIds.length) {
      try {
        const uncertainCandidates = programmeCards.filter(item => uncertainIds.includes(item.id));
        const uncertainEvidence = await loadAnalysisEvidence(uncertainCandidates, analysisProfile);
        fullScreening = await runProjectScreening(
          agent, analysisProfile, payload, uncertainEvidence.candidates, uncertainEvidence.evidenceByProgramme
        );
      } catch (error) {
        cardScreening.fullReviewFallbackReason = String(error.message || '完整项目复核超时');
      }
    }
    const screening = agent.finalizeProgrammeScreening(cardScreening, fullScreening, programmeCards, {
      profileMajor: analysisProfile.major,
      requestedFields: selectedStrings(payload.fields),
      targetSchools: selectedStrings(payload.targetSchools),
      maximum: 8
    });
    const selectedIds = screening.selectedProgrammeIds;
    const selectedProgrammeCards = programmeCards.filter(item => selectedIds.includes(item.id));
    const loaded = await loadAnalysisEvidence(selectedProgrammeCards, analysisProfile);
    const selectedCandidates = loaded.candidates;
    if (!selectedCandidates.length) throw new Error('完整项目资料复核后没有保留可分析项目。');

    const evidenceByProgramme = Object.fromEntries(selectedIds.map(id => [id, loaded.evidenceByProgramme[id]]));
    const prepared = agent.prepareAgentAnalysis(analysisProfile, selectedCandidates, evidenceByProgramme, 6);
    const generated = await runAgentAssessments(agent, prepared);
    const normalizedAssessments = agent.normalizeAgentAssessments(generated.assessments, prepared);
    const calibration = agent.normalizeProbabilityCalibration(generated.calibration, prepared, generated.academicBand);
    if (generated.academicBand && Object.keys(calibration).length !== prepared.modelInput.programmes.length) {
      throw new Error('院校档次横向对照未通过校验，本次不展示未经检查的参考数值。请重试。');
    }
    const assessments = agent.mergeProbabilityCalibration(normalizedAssessments, calibration, prepared);
    const comparisonProfile = prepared.modelInput.profile.structured;
    const assessmentErrors = [...generated.errors];
    for (const programme of prepared.modelInput.programmes) {
      if (assessments[programme.id] || !generated.assessments?.[programme.id]) continue;
      assessmentErrors.push(`${programme.id}:模型输出未通过证据契约校验`);
    }
    const insights = {};
    const results = prepared.comparisons.map(({ programme, result }) => {
      const assessment = assessments[programme.id] || null;
      insights[programme.id] = assessment ? {
        fit: assessment.fit || [], psCv: assessment.psCv || [], reasoning: assessment.reasoning || [],
        uncertainties: assessment.uncertainties || [], evidenceUsed: assessment.evidenceUsed || []
      } : { fit: [], psCv: [], reasoning: [], uncertainties: [], evidenceUsed: [] };
      const evidence = evidenceByProgramme[programme.id] || { allCases: [] };
      const caseOrder = (prepared.evidenceSelections[programme.id] || [])
        .filter(document => document.provenance === 'public-case').map(document => document.id);
      const caseById = new Map(evidence.allCases.map(item => [String(item._id), item]));
      const assessmentError = assessmentErrors.find(message => message.startsWith(`${programme.id}:`));
      return {
        programme: {
          id: programme.id, region: programme.region, school: programme.school,
          university: programme.university, name: programme.name, nameZh: programme.nameZh,
          caseCount: evidence.allCases.length
        },
        result: { ...result, ...(assessment || {}) },
        assessmentError: assessmentError ? assessmentError.slice(programme.id.length + 1) : '',
        evidenceCases: caseOrder.map(id => caseById.get(String(id))).filter(Boolean)
          .map(item => ({
            ...summarizeEvidenceCase(item, comparisonProfile),
            isNearest: String(item._id) === String(result.nearest?.fingerprint || '')
          }))
      };
    }).sort((left, right) => Number(Boolean(right.result.assessmentAvailable)) - Number(Boolean(left.result.assessmentAvailable))
      || Number(right.result.center || 0) - Number(left.result.center || 0));
    const completed = Object.keys(assessments).length;
    const data = {
      analysisId, results, insights,
      message: completed
        ? `旧版两层 Agent 已筛选 ${results.length} 个项目，读取 ${loaded.retrievedCaseCount} 条审核成功案例，并完成 ${completed}/${results.length} 个有证据引用的判断。`
        : `旧版两层 Agent 已完成项目筛选和案例检索，但评估结果未通过证据契约校验，因此不生成概率。`,
      mode: completed ? 'legacy-two-stage-rag-ai-assessment' : 'legacy-evidence-only',
      screening: {
        card: cardScreening,
        fullReview: fullScreening,
        final: screening,
        selectedProgrammeIds: selectedIds
      },
      assessmentExecution: {
        requested: results.length,
        completed,
        failed: results.length - completed,
        errors: assessmentErrors
      }
    };
    await db.collection('analyses').doc(analysisId).update({
      data: { status: 'completed', completedAt: db.serverDate(), result: data }
    });
    return data;
  } catch (error) {
    await db.collection('analyses').doc(analysisId).update({
      data: { status: 'failed', completedAt: db.serverDate(), error: String(error.message || error) }
    }).catch(() => {});
    throw error;
  }
}

async function createFeedback(payload, openid) {
  const analysisId = String(payload?.analysisId || '');
  if (!analysisId) throw new Error('缺少分析记录编号。');
  const analysis = await db.collection('analyses').doc(analysisId).get();
  if (!analysis.data || analysis.data.openid !== openid) throw new Error('无法为这条分析记录提交反馈。');
  const feedback = {
    analysisId, openid, usefulness: String(payload.usefulness || ''), valuable: String(payload.valuable || ''),
    clarity: String(payload.clarity || ''), comment: String(payload.comment || '').slice(0, 1000),
    createdAtMs: Date.now(), createdAt: db.serverDate()
  };
  try { await db.collection('feedback').add({ data: feedback }); } catch (error) { throw collectionHint(error); }
  return { saved: true };
}

exports.main = async event => {
  try {
    const { OPENID: openid } = cloud.getWXContext();
    const action = String(event?.action || '');
    const payload = event?.payload || {};
    if (action === 'institutions.search') return ok({ query: payload.q || '', results: searchInstitutions(catalogue.institutions, payload.q, 8) });
    if (action === 'majors.search') return ok({ query: payload.q || '', results: searchMajors(catalogue.majors, payload.q, 20) });
    if (action === 'analysis.create') return ok(await createAnalysis(payload, openid));
    if (action === 'feedback.create') return ok(await createFeedback(payload, openid));
    return fail('未知云端操作。');
  } catch (error) {
    console.error(error);
    return fail(collectionHint(error).message || '云函数执行失败');
  }
};
