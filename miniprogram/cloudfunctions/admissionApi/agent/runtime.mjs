import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeCaseEvidence, caseYearWeight, referenceYearForCases, standardizeGpa
} from './case-analysis.mjs';
import { normalizeAssessment } from './assessment-contract.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const assessmentPrompt = readFileSync(join(root, 'assessment-system.txt'), 'utf8').trim();
export const screeningPrompt = readFileSync(join(root, 'project-screening-system.txt'), 'utf8').trim();
export const probabilityCalibrationPrompt = readFileSync(join(root, 'probability-calibration-system.txt'), 'utf8').trim();

const asStrings = value => [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];

// Kept in sync with the field aliases used by the old knowledge-base retrieval layer.
const programmeFieldAliases = {
  electronic: ['electronic', 'integrated-circuit', 'semiconductor', 'embedded'],
  communication: ['communication', 'communications', 'network', 'signal'],
  computer: ['computer', 'software', 'data', 'ai'],
  automation: ['automation', 'control', 'robotics'],
  control: ['control', 'automation', 'robotics'],
  electrical: ['electrical', 'power', 'energy'],
  ai: ['ai', 'artificial-intelligence', 'data', 'computer', 'software'],
  data: ['data', 'analytics', 'ai', 'computer'],
  software: ['software', 'computer', 'information-technology'],
  cloud: ['cloud', 'computer', 'software', 'network'],
  robotics: ['robotics', 'automation', 'control', 'mechanical'],
  mechanical: ['mechanical', 'manufacturing', 'robotics'],
  civil: ['civil', 'construction', 'built-environment'],
  chemical: ['chemical', 'materials'], materials: ['materials', 'chemical', 'nanotechnology'],
  mathematics: ['mathematics', 'statistics', 'quantitative'], statistics: ['statistics', 'data', 'mathematics', 'quantitative'],
  physics: ['physics', 'quantum'], biology: ['biology', 'life-science', 'bioscience', 'biotechnology'],
  biotechnology: ['biotechnology', 'biology', 'life-science'], biomedical: ['biomedical', 'healthcare', 'medical'],
  healthcare: ['healthcare', 'biomedical', 'medical'], medicine: ['medicine', 'healthcare', 'biomedical'],
  pharmacy: ['pharmacy', 'healthcare', 'medicine'], 'public-health': ['public-health', 'healthcare', 'medicine'],
  'food-nutrition': ['food-nutrition', 'life-science', 'biology'], psychology: ['psychology', 'behavioural', 'social-science'],
  environmental: ['environmental', 'energy', 'sustainability'], energy: ['energy', 'environmental', 'power', 'electrical'],
  power: ['power', 'energy', 'electrical'], network: ['network', 'communication', 'computer'],
  signal: ['signal', 'communication', 'electronic'], iot: ['iot', 'network', 'communication', 'embedded'],
  'integrated-circuit': ['integrated-circuit', 'semiconductor', 'electronic'],
  semiconductor: ['semiconductor', 'integrated-circuit', 'electronic'],
  manufacturing: ['manufacturing', 'mechanical', 'automation'], instrumentation: ['instrumentation', 'electronic', 'control'],
  optoelectronics: ['optoelectronics', 'electronic', 'physics'], railway: ['railway', 'transportation', 'civil', 'mechanical'],
  business: ['business', 'management', 'commerce'], finance: ['finance', 'accounting'], accounting: ['accounting', 'finance', 'business'],
  economics: ['economics', 'finance', 'business'], operations: ['operations', 'management', 'business', 'supply-chain'],
  marketing: ['marketing'], law: ['law', 'legal'], education: ['education', 'learning'], media: ['media'], design: ['design'],
  architecture: ['architecture', 'built-environment'], 'public-policy': ['public-policy', 'social-science', 'governance'],
  'social-science': ['social-science', 'public-policy', 'psychology'], humanities: ['humanities', 'language', 'media'],
  'life-science': ['life-science', 'biomedical', 'healthcare'], other: []
};

const aliasesFor = field => new Set(programmeFieldAliases[String(field || '').toLowerCase()] || [String(field || '').toLowerCase()]);
const fieldMatches = (programme, field) => {
  const tags = programme.focusTags?.length ? programme.focusTags : programme.majorTags || [];
  if (field === 'other') return !tags.length;
  const aliases = aliasesFor(field);
  return tags.some(tag => aliases.has(String(tag).toLowerCase()));
};

function retrieval(programme, input = {}) {
  const regions = asStrings(input.regions);
  const targetSchools = asStrings(input.targetSchools);
  const fields = asStrings(input.fields).map(value => value.toLowerCase());
  const major = String(input.profile?.major || '').toLowerCase();
  const tags = programme.majorTags || [];
  const matchedFields = fields.filter(field => fieldMatches(programme, field));
  const majorAliases = aliasesFor(major);
  const exactMajorMatch = Boolean(major && tags.includes(major));
  const majorMatch = exactMajorMatch || Boolean(major && tags.some(tag => majorAliases.has(tag)));
  const regionMatch = !regions.length || regions.includes(programme.region);
  const schoolMatch = !targetSchools.length || targetSchools.includes(programme.university) || targetSchools.includes(programme.school);
  const eligible = regionMatch && schoolMatch && (!fields.length || matchedFields.length > 0);
  return {
    eligible, majorMatch, exactMajorMatch, matchedFields,
    score: (regionMatch ? 10 : 0) + (schoolMatch ? 4 : 0)
      + matchedFields.reduce((score, field) => score + ([10, 3, 1][Math.min(fields.indexOf(field), 2)] || 1), 0)
      + (exactMajorMatch ? 8 : majorMatch ? 4 : 0)
  };
}

export function selectScreeningCandidates(programmes = [], input = {}, maximum = 16) {
  const ranked = programmes.map(programme => ({ programme, retrieval: retrieval(programme, input) }))
    .filter(entry => entry.retrieval.eligible)
    .sort((a, b) => b.retrieval.score - a.retrieval.score
      || Number(b.programme.caseCount || 0) - Number(a.programme.caseCount || 0)
      || a.programme.id.localeCompare(b.programme.id));
  const anchors = [];
  const add = entry => {
    if (entry && !anchors.some(item => item.programme.id === entry.programme.id)) anchors.push(entry);
  };
  for (const field of asStrings(input.fields).map(value => value.toLowerCase())) {
    add(ranked.filter(entry => fieldMatches(entry.programme, field))
      .sort((a, b) => Number(b.retrieval.majorMatch) - Number(a.retrieval.majorMatch)
        || b.retrieval.score - a.retrieval.score || a.programme.id.localeCompare(b.programme.id))[0]);
  }
  for (const school of asStrings(input.targetSchools)) {
    add(ranked.find(entry => entry.programme.university === school || entry.programme.school === school));
  }
  if (input.profile?.major) {
    ranked.filter(entry => entry.retrieval.exactMajorMatch).slice(0, 2).forEach(add);
  }
  return [...anchors, ...ranked]
    .filter((entry, index, entries) => entries.findIndex(candidate => candidate.programme.id === entry.programme.id) === index)
    .slice(0, Math.max(8, Number(maximum) || 16))
    .map(entry => ({ ...entry.programme, _retrieval: entry.retrieval }));
}

export function parseModelJson(content, finishReason = null) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); }
  catch (error) {
    // A completed JSON-mode response can occasionally omit exactly its final object brace.
    // Never repair a length-limited response or any other malformed structure.
    if (finishReason === 'stop' && cleaned.startsWith('{') && cleaned.endsWith('}')) {
      try { return JSON.parse(`${cleaned}}`); } catch { /* preserve the original parse error */ }
    }
    throw error;
  }
}

export function validateProgrammeScreeningResult(value, input) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  const selected = asStrings(value?.selectedProgrammeIds);
  const decisions = value?.programmeDecisions && typeof value.programmeDecisions === 'object'
    ? value.programmeDecisions : {};
  const ids = new Set(projects.map(project => project.id));
  if (selected.length > 8 || selected.some(id => !ids.has(id))) {
    throw new Error('项目筛选结果包含无效候选或超过8个项目');
  }
  if (projects.some(project => !decisions[project.id])) throw new Error('项目筛选结果没有覆盖全部项目');
  for (const id of selected) {
    const decision = decisions[id];
    if (!['include', 'uncertain'].includes(String(decision?.decision || '').toLowerCase())) {
      throw new Error('项目筛选结果把非纳入项目放进候选');
    }
    if (String(decision?.directionFit || '').toLowerCase() !== 'direct') {
      throw new Error('项目筛选结果包含非直接匹配方向');
    }
  }
  return value;
}

export function mergeScreeningResults(results = [], maximum = Number.POSITIVE_INFINITY) {
  const decisions = Object.assign({}, ...results.map(result => result.programmeDecisions || {}));
  const selectedProgrammeIds = [...new Set(results.flatMap(result => result.selectedProgrammeIds || []))]
    .filter(id => {
      const value = decisions[id];
      return ['include', 'uncertain'].includes(String(value?.decision || '').toLowerCase())
        && String(value?.directionFit || '').toLowerCase() === 'direct';
    }).slice(0, maximum);
  return { selectedProgrammeIds, programmeDecisions: decisions, configured: true };
}

export function finalizeProgrammeScreening(cardResult = {}, fullResult = null, candidates = [], options = {}) {
  const maximum = Math.max(1, Number(options.maximum || 8));
  const cardDecisions = cardResult.programmeDecisions || {};
  const fullDecisions = fullResult?.programmeDecisions || {};
  const decisions = { ...cardDecisions };
  for (const [id, value] of Object.entries(cardDecisions)) {
    if (String(value?.decision || '').toLowerCase() === 'uncertain' && fullDecisions[id]) decisions[id] = fullDecisions[id];
  }
  const available = new Set(candidates.map(programme => programme.id));
  const selectedProgrammeIds = [...new Set([...(cardResult.selectedProgrammeIds || []), ...(fullResult?.selectedProgrammeIds || [])])]
    .filter(id => available.has(id)
      && ['include', 'uncertain'].includes(String(decisions[id]?.decision || '').toLowerCase())
      && String(decisions[id]?.directionFit || '').toLowerCase() === 'direct')
    .slice(0, maximum);
  return { selectedProgrammeIds, programmeDecisions: decisions, configured: true, applied: true };
}

function clipScreeningText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text || null;
}

export function buildScreeningProjects(candidates = [], fullEvidenceByProgramme = null) {
  return candidates.map(programme => {
    const identity = {
      id: programme.id,
      name: `${programme.university} ${programme.nameZh || programme.name}`,
      nameEn: programme.name,
      officialUrl: programme.officialUrl || null
    };
    if (fullEvidenceByProgramme) {
      return {
        ...identity,
        officialRequirements: programme.requirements || programme.officialNote || null,
        positioning: programme.positioning || programme.overview || null,
        curriculum: programme.curriculum || null,
        officialEvidence: officialDocuments(fullEvidenceByProgramme[programme.id]?.officialDocuments
          || fullEvidenceByProgramme[programme.id]?.official || [])
      };
    }
    return {
      ...identity,
      officialCard: {
        documentId: `${programme.id}:card`,
        region: programme.region,
        focusTags: programme.focusTags || programme.majorTags || [],
        majorTags: programme.majorTags || [],
        courseTags: programme.courseTags || [],
        languageMin: programme.languageMin ?? null,
        languageRequirement: programme.languageMin == null ? null : { test: 'IELTS', minimum: programme.languageMin },
        requirements: clipScreeningText(programme.requirements || programme.officialNote, 900),
        positioning: clipScreeningText(programme.positioning || programme.overview, 700),
        duration: programme.duration || null,
        orientation: clipScreeningText(programme.orientation, 900)
      }
    };
  });
}

export function toAgentCase(item = {}) {
  return {
    fingerprint: String(item._id || ''),
    school: item.undergraduate?.university || null,
    schoolTier: item.undergraduate?.scoreTier ?? null,
    schoolClassification: item.undergraduate?.classification || null,
    majorTag: item.undergraduate?.majorField || null,
    majorName: item.undergraduate?.major || null,
    gpaRaw: item.gpa?.raw || null,
    gpaScale: item.gpa?.scale || 'UNKNOWN',
    gpa100: Number(item.gpa?.value100) || null,
    languageTest: item.language?.test || null,
    language: Number(item.language?.score) || null,
    offerYear: Number(item.offerYear) || null,
    cycle: Number(item.offerYear) || null,
    experiences: item.experiences || {},
    experienceTags: item.experienceTags || [],
    companyTypes: item.companyTypes || [],
    qualityScore: Number(item.qualityScore) || 0
  };
}

function caseDocument(item, referenceYear) {
  const agentCase = toAgentCase(item);
  const experienceText = Object.entries(item.experiences || {})
    .flatMap(([kind, values]) => (values || []).map(value => `${kind}：${value}`)).join('；');
  const documentId = String(item._id || '');
  return {
    id: documentId,
    documentId,
    section: 'case',
    title: `${item.offerYear || '年份未披露'}年公开成功案例`,
    text: [
      `本科院校：${item.undergraduate?.university || '未披露'}`,
      `本科层次：${item.undergraduate?.classification || '未披露'}`,
      `本科专业：${item.undergraduate?.major || '未披露'}`,
      `GPA原文：${item.gpa?.raw || '未披露'}`,
      `语言：${item.language?.test && item.language?.score ? `${item.language.test} ${item.language.score}` : '未披露'}`,
      `经历：${experienceText || '未披露'}`
    ].join('\n'),
    provenance: 'public-case',
    metadata: {
      fingerprint: agentCase.fingerprint,
      offerYear: agentCase.offerYear,
      yearWeight: caseYearWeight(agentCase.offerYear, referenceYear)
    }
  };
}

function officialDocuments(rows = []) {
  return rows.map(item => ({
    id: String(item._id || item.id || ''),
    documentId: String(item._id || item.id || ''),
    section: item.section || 'programme',
    title: item.title || '项目官方资料',
    text: String(item.text || ''),
    provenance: item.provenance || 'official',
    metadata: { academicYears: item.academicYears || [], checkedAt: item.checkedAt || null }
  })).filter(item => item.id && item.text);
}

function programmeCardDocument(programme) {
  const documentId = `${programme.id}:programme-card`;
  return {
    id: documentId,
    documentId,
    section: 'catalogue-card',
    title: '项目目录资料',
    text: [
      `项目：${programme.university || ''} ${programme.nameZh || programme.name || ''}`.trim(),
      `英文名：${programme.name || '未提供'}`,
      `方向标签：${[...(programme.focusTags || []), ...(programme.majorTags || [])].filter(Boolean).join('、') || '未提供'}`,
      `课程标签：${(programme.courseTags || []).join('、') || '未提供'}`,
      `项目定位：${programme.positioning || programme.overview || '未提供'}`,
      `课程方向：${programme.orientation || programme.curriculum || '未提供'}`
    ].join('\n'),
    provenance: 'catalogue-card',
    metadata: {}
  };
}

function selectedEvidence(allDocuments, nearestFingerprint, cap = 6) {
  const official = allDocuments.filter(document => document.provenance !== 'public-case');
  const preferred = new Set(['requirements', 'curriculum', 'orientation', 'catalogue-card']);
  const structured = official.filter(document => preferred.has(document.section));
  const selectedOfficial = structured.length ? structured : official.slice(0, 1);
  const orderedCases = allDocuments.filter(document => document.provenance === 'public-case')
    .sort((a, b) => Number(b.metadata?.yearWeight || 0) - Number(a.metadata?.yearWeight || 0)
      || Number(b.metadata?.offerYear || 0) - Number(a.metadata?.offerYear || 0)
      || String(a.id).localeCompare(String(b.id)));
  const nearest = orderedCases.find(document => document.metadata?.fingerprint === nearestFingerprint);
  const cases = [nearest, ...orderedCases.filter(document => document !== nearest)].filter(Boolean).slice(0, cap);
  return [...selectedOfficial, ...cases];
}

function languageMinimum(text, test) {
  const name = test === 'IELTS' ? '(?:IELTS|雅思)' : '(?:TOEFL|托福)';
  const segments = [...String(text || '').matchAll(new RegExp(`${name}(?:\\s+Academic)?(?:(?!IELTS|雅思|TOEFL|托福)[\\s\\S]){0,120}`, 'ig'))]
    .map(match => match[0]);
  for (const segment of segments) {
    if (test === 'TOEFL') {
      const online = segment.match(/(?:网考|iBT|internet[- ]based)[^0-9]{0,12}(\d{2,3})/i)
        || segment.match(/(\d{2,3})[^。；;,]{0,12}(?:网考|iBT|internet[- ]based)/i);
      if (online && Number(online[1]) >= 60 && Number(online[1]) <= 120) return Number(online[1]);
    }
    if (test === 'IELTS') {
      const overall = segment.match(/(?:总分|overall)[^0-9]{0,20}(\d(?:\.\d)?)/i);
      if (overall && Number(overall[1]) >= 4 && Number(overall[1]) <= 9) return Number(overall[1]);
    }
    const values = [...segment.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    if (test === 'IELTS' && /(?:单项|小分|各项|每项|each\s+(?:band|component|skill|section))[^0-9]{0,20}\d/i.test(segment)
      && /(?:单项|小分|各项|每项|each\s+(?:band|component|skill|section))/i.exec(segment).index
        < segment.search(/\d/)) continue;
    const minimum = values.find(value => test === 'IELTS' ? value >= 4 && value <= 9 : value >= 60 && value <= 120);
    if (minimum != null) return minimum;
  }
  return null;
}

export function extractLanguageAssessment(programme, profile = {}, officialRows = []) {
  const officialRequirements = officialDocuments(officialRows.filter(item =>
    ['official', 'official-structured'].includes(item.provenance))).filter(item => item.section === 'requirements');
  const cardText = String(programme?.requirements || programme?.officialNote || '');
  const text = [...officialRequirements.map(item => item.text), cardText].join('\n');
  const officialTests = {
    IELTS: officialRequirements.map(item => languageMinimum(item.text, 'IELTS')).find(value => value != null)
      ?? languageMinimum(cardText, 'IELTS') ?? (programme?.languageMin ?? null),
    TOEFL: officialRequirements.map(item => languageMinimum(item.text, 'TOEFL')).find(value => value != null)
      ?? languageMinimum(cardText, 'TOEFL')
  };
  const test = String(profile.languageTest || '').toUpperCase().startsWith('TOEFL') ? 'TOEFL' : 'IELTS';
  const score = profile.language == null || profile.language === '' ? NaN : Number(profile.language);
  const required = officialTests[test] == null ? null : Number(officialTests[test]);
  const name = test === 'IELTS' ? '(?:IELTS|雅思)' : '(?:TOEFL|托福)';
  const otherName = test === 'IELTS' ? '(?:TOEFL|托福)' : '(?:IELTS|雅思)';
  const section = (text.match(new RegExp(`${name}[^。\\n]{0,220}`, 'i'))?.[0] || text)
    .split(new RegExp(otherName, 'i'))[0];
  const componentRequirementPresent = test === 'IELTS'
    ? /单项|小分|各项|每项|each\s+(?:band|component|skill|section)|no\s+(?:individual\s+)?band\s+below/i.test(section)
    : /单项|小分|各项|每项|each\s+(?:component|skill|section)|minimum\s+in\s+each/i.test(section);
  const overallMeets = Number.isFinite(required) && Number.isFinite(score) ? score >= required : null;
  return {
    applicantTest: test,
    applicantScore: Number.isFinite(score) ? score : null,
    officialTests,
    comparable: Number.isFinite(required),
    overallMeets,
    componentRequirementPresent,
    meets: overallMeets,
    instruction: Number.isFinite(required)
      ? `当前版本只比较同为${test}的总分，不判断单项分数；申请人${test}总分 ${Number.isFinite(score) ? score : '未披露'}，本地官方资料快照列出的总分最低${required}。当前申请年份请复核官网完整条件。`
      : `已收录项目资料没有提供可比较的${test}总分最低分，不能声称申请人的语言成绩满足要求。`
  };
}

export function unsupportedLanguageClaim(value, languageAssessment = {}) {
  if (languageAssessment.meets === true) return false;
  const items = field => Array.isArray(value?.[field]) ? value[field] : [];
  const claims = [...items('fit'), ...items('psCv'), ...items('reasoning'),
    ...items('evidenceUsed').map(item => item?.comparison)];
  return claims.some(claim => {
    const sentence = String(claim || '').replace(/\s+/g, '');
    const pass = /(?:满足|达到|符合)(?:了)?(?:全部)?(?:语言|雅思|IELTS|托福|TOEFL)(?:最低)?(?:要求|门槛)|(?:语言|雅思|IELTS|托福|TOEFL)(?:成绩|要求)?(?:已|完全|虽)?(?:达标|满足(?:最低)?(?:要求|门槛)?)|(?:超过|超出)(?:官方)?(?:语言|雅思|IELTS|托福|TOEFL)(?:最低)?(?:要求|门槛)/ig;
    for (const match of sentence.matchAll(pass)) {
      const before = sentence.slice(Math.max(0, match.index - 32), match.index);
      const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 12);
      if (/^情况(?:需要|仍需|尚需|待).{0,8}(?:核验|确认)/.test(after)) continue;
      const explicitlyNegated = /(?:尚未|未|不|无法|不能|待核验|未知|不能确认|无法确认)[^。；;，,]{0,5}$/.test(before)
        || /(?:不能|不应|不宜|不可|无法)(?:据此)?(?:声称|断言|认定|证明|确认)[^。；;，,]{0,20}$/.test(before);
      if (!explicitlyNegated
        && !/(?:需|需要|必须|应当)$/.test(before)) return true;
    }
    return false;
  });
}

export function prepareAgentAnalysis(profile, candidates, evidenceByProgramme, caseEvidenceCap = 6) {
  const structuredProfile = { ...profile, gpaStandardization: standardizeGpa(profile) };
  const comparisons = [];
  const evidenceSelections = {};
  const programmes = candidates.map(programme => {
    const evidence = evidenceByProgramme[programme.id] || { allCases: [], official: [] };
    const cases = evidence.allCases.map(toAgentCase);
    const agentProgramme = {
      ...programme,
      nameEn: programme.name,
      officialNote: programme.requirements || programme.officialNote || '',
      courseOrientation: programme.orientation || '',
      cases
    };
    const result = analyzeCaseEvidence(structuredProfile, agentProgramme);
    comparisons.push({ programme, result });
    const referenceYear = referenceYearForCases(cases, structuredProfile.applicationYear);
    const official = officialDocuments(evidence.official);
    const documents = [
      ...(official.length ? official : [programmeCardDocument(programme)]),
      ...evidence.allCases.map(item => caseDocument(item, referenceYear))
    ];
    const selection = selectedEvidence(documents, result.nearest?.fingerprint || '', caseEvidenceCap);
    evidenceSelections[programme.id] = selection;
    return {
      id: programme.id,
      name: `${programme.university} ${programme.nameZh || programme.name}`,
      nameEn: programme.name,
      officialUrl: programme.officialUrl || null,
      officialRequirements: agentProgramme.officialNote,
      languageAssessment: extractLanguageAssessment(programme, structuredProfile, evidence.official),
      positioning: programme.positioning || programme.overview || null,
      curriculum: programme.orientation || programme.curriculum || null,
      focusTags: programme.focusTags || programme.majorTags || [],
      majorTags: programme.majorTags || [],
      courseTags: programme.courseTags || [],
      retrievedEvidence: selection,
      evidenceSelection: selection.map(document => document.id),
      caseDistribution: result.evidence
    };
  });
  return {
    profile: { structured: structuredProfile, narrative: profile.profileText || null },
    comparisons,
    evidenceSelections,
    modelInput: {
      profile: { structured: structuredProfile, narrative: profile.profileText || null },
      evidencePolicy: {
        minimumApprovedCases: 0,
        successCasesOnly: true,
        allApprovedCaseDetails: false,
        lowCaseAllowed: true,
        instruction: '全部 approved 案例已经由本地程序汇总进 caseDistribution；只阅读固定代表案例正文。公开成功案例不能解释为真实录取率。案例不足不阻断判断，必须回到官方项目资料和申请人背景独立分析，并扩大不确定区间。'
      },
      programmes
    }
  };
}

export function normalizeAgentAssessments(generated, prepared) {
  return Object.fromEntries(prepared.comparisons.map(({ programme, result }) => {
    const agentProgramme = prepared.modelInput.programmes.find(item => item.id === programme.id);
    if (unsupportedLanguageClaim(generated?.[programme.id], agentProgramme?.languageAssessment)) return [programme.id, null];
    const selection = prepared.evidenceSelections[programme.id] || [];
    const order = selection.map(document => document.id);
    const normalized = normalizeAssessment(generated?.[programme.id], new Set(order), result, order);
    return [programme.id, normalized];
  }).filter(([, value]) => value));
}

function minimumRange(center, low, high, minimumWidth) {
  let boundedLow = Math.max(0, Math.min(center, Math.round(low)));
  let boundedHigh = Math.min(100, Math.max(center, Math.round(high)));
  if (boundedHigh - boundedLow >= minimumWidth) return { low: boundedLow, high: boundedHigh };
  const left = Math.floor(minimumWidth / 2);
  boundedLow = Math.max(0, Math.min(boundedLow, center - left));
  boundedHigh = Math.min(100, Math.max(boundedHigh, center + minimumWidth - left));
  if (boundedHigh - boundedLow < minimumWidth) {
    if (boundedLow === 0) boundedHigh = Math.min(100, minimumWidth);
    else if (boundedHigh === 100) boundedLow = Math.max(0, 100 - minimumWidth);
  }
  return { low: boundedLow, high: boundedHigh };
}

const academicBands = ['elite985', 'non985211', 'doubleFirstClass', 'ordinary'];

export function buildAcademicCalibrationRequest(input) {
  const structured = input?.profile?.structured;
  const classification = String(structured?.schoolClassification || '');
  const band = /985/.test(classification) ? 'elite985'
    : /211/.test(classification) ? 'non985211'
      : /双一流/.test(classification) ? 'doubleFirstClass'
        : /双非/.test(classification) ? 'ordinary' : null;
  const raw = Number(structured?.gpaValue);
  if (!band || String(structured?.gpaScale) !== '100' || !Number.isFinite(raw)) return { input, band: null };
  const { university, schoolTier, schoolClassification, gpaStandardization, ...neutralProfile } = structured;
  const { backgroundCorrection, equivalentScore, ...neutralGpa } = gpaStandardization || {};
  return {
    band,
    input: {
      ...input,
      profile: { ...input.profile, structured: { ...neutralProfile, gpaStandardization: neutralGpa }, narrative: null },
      academicComparison: {
        note: '同一申请资料的内部985基准比较分；不是官方换算或真实录取率',
        scores: {
          elite985: raw,
          non985211: Math.max(0, raw - 1.5),
          doubleFirstClass: Math.max(0, raw - 2),
          ordinary: Math.max(0, raw - 3)
        }
      },
      programmes: (input.programmes || []).map(programme => {
        const distribution = programme.caseDistribution || {};
        const { user, rawUser, rank, positionNote, sameTier, sameTierCount, ...caseGpa } = distribution.gpa || {};
        const { sameTierCount: tierCount, sameTierMajorCount, gpaPercentileAmongSuccessfulCases,
          ...caseBackground } = distribution.background || {};
        return {
          ...programme,
          caseDistribution: { ...distribution, gpa: caseGpa, background: caseBackground }
        };
      })
    }
  };
}

export function normalizeProbabilityCalibration(value, prepared, academicBand = null) {
  const programmes = prepared?.modelInput?.programmes || [];
  const raw = value?.probabilities;
  if (!raw || typeof raw !== 'object') return {};
  const rows = programmes.map(programme => {
    const item = raw[programme.id];
    const profile = prepared?.modelInput?.profile?.structured || {};
    const basis = asStrings(item?.basis).join('；');
    const missingExperienceClaim = [
      [profile.internships, /(?:无|没有|缺少)实习/g],
      [profile.researches, /(?:无|没有|缺少)(?:科研|研究)/g],
      [profile.awards, /(?:无|没有|缺少)奖项/g]
    ].some(([recorded, pattern]) => (!Array.isArray(recorded) || recorded.length === 0)
      && [...basis.matchAll(pattern)].some(match => !/^(?:\s*\/\s*(?:科研|研究))?\s*(?:经历)?(?:填写|披露|资料|信息|记录)/.test(
        basis.slice(match.index + match[0].length))));
    if (missingExperienceClaim) return null;
    const academicCenters = academicBand ? academicBands.map(band => Number(item?.academicCenters?.[band])) : null;
    if (academicCenters && academicCenters.some(center => !Number.isFinite(center) || center < 0 || center > 100)) return null;
    let academicMonotonicAdjusted = false;
    if (academicCenters) {
      for (let index = 1; index < academicCenters.length; index += 1) {
        if (academicCenters[index] > academicCenters[index - 1]) academicMonotonicAdjusted = true;
        academicCenters[index] = Math.min(academicCenters[index], academicCenters[index - 1]);
      }
    }
    const baseCenter = Math.round(Number(item?.center));
    const center = Math.round(academicCenters ? academicCenters[academicBands.indexOf(academicBand)] : baseCenter);
    const shift = center - baseCenter;
    const low = Math.max(0, Number(item?.low) + shift);
    const high = Math.min(100, Number(item?.high) + shift);
    const rank = Number(item?.rank);
    if (![baseCenter, center, low, high, rank].every(Number.isFinite)
      || baseCenter < 0 || baseCenter > 100 || Number(item?.low) < 0
      || Number(item?.low) > baseCenter || baseCenter > Number(item?.high) || Number(item?.high) > 100
      || center < 0 || center > 100 || low > center || center > high) return null;
    return { programme, item, center, low, high, rank, academicMonotonicAdjusted };
  });
  if (rows.some(row => !row)) return {};
  const ranks = rows.map(row => row.rank);
  if (new Set(ranks).size !== rows.length || ranks.some(rank => !Number.isInteger(rank) || rank < 1 || rank > rows.length)) return {};

  const ordered = [...rows].sort(academicBand
    ? (left, right) => right.center - left.center || left.rank - right.rank
    : (left, right) => left.rank - right.rank);
  if (!academicBand) {
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].center >= ordered[index - 1].center) {
        ordered[index].center = Math.max(0, ordered[index - 1].center - 1);
      }
    }
  }
  return Object.fromEntries(ordered.map(({ programme, item, center, low, high, rank, academicMonotonicAdjusted }, index) => {
    const caseCount = Number(programme.caseDistribution?.caseCount || 0);
    const minimumWidth = caseCount === 0 ? 45 : caseCount <= 2 ? 36 : caseCount <= 5 ? 28 : 20;
    const range = minimumRange(center, Math.min(low, center), Math.max(high, center), minimumWidth);
    return [programme.id, {
      rank: academicBand ? index + 1 : rank,
      center,
      ...range,
      confidence: academicMonotonicAdjusted || caseCount < 5 ? 'low' : ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
      basis: asStrings(item.basis),
      academicMonotonicAdjusted,
      evidenceMode: caseCount === 0 ? 'ai-project-profile-only' : caseCount < 5 ? 'ai-limited-cases' : 'ai-full-case-summary'
    }];
  }));
}

export function mergeProbabilityCalibration(assessments, calibration, prepared) {
  return Object.fromEntries(Object.entries(assessments || {}).map(([programmeId, assessment]) => {
    const programme = prepared.modelInput.programmes.find(item => item.id === programmeId);
    const caseCount = Number(programme?.caseDistribution?.caseCount || 0);
    const calibrated = calibration?.[programmeId] || null;
    const minimumWidth = caseCount === 0 ? 45 : caseCount <= 2 ? 36 : caseCount <= 5 ? 28 : 20;
    const fallbackRange = minimumRange(
      Math.round(Number(assessment.center)), Number(assessment.low), Number(assessment.high), minimumWidth
    );
    const evidenceMode = calibrated?.evidenceMode || (caseCount === 0
      ? 'ai-project-profile-only' : caseCount < 5 ? 'ai-limited-cases' : 'ai-full-case-summary');
    const uncertainty = caseCount === 0
      ? '该项目没有公开成功案例，本次概率仅由 AI 根据项目资料与申请背景推断，置信度较低。'
      : caseCount < 5
        ? `该项目仅有 ${caseCount} 条公开成功案例，只能作为个别样本，置信度较低。`
        : '';
    const academicUncertainty = calibrated?.academicMonotonicAdjusted
      ? '模型的院校档次对照顺序不一致，已按同条件比较约束修正；参考数值的置信度较低。' : '';
    return [programmeId, {
      ...assessment,
      ...(!calibrated ? fallbackRange : {
        center: calibrated.center, low: calibrated.low, high: calibrated.high,
        probabilityRank: calibrated.rank, probabilityBasis: calibrated.basis
      }),
      confidence: calibrated?.confidence || (caseCount < 5 ? 'low' : 'medium'),
      evidenceMode,
      displayMode: caseCount < 5 ? 'range-only' : 'point-and-range',
      uncertainties: [...new Set([...(assessment.uncertainties || []), uncertainty, academicUncertainty].filter(Boolean))]
    }];
  }));
}
