import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessmentPrompt, screeningPrompt, prepareAgentAnalysis,
  normalizeAgentAssessments, normalizeProbabilityCalibration, mergeProbabilityCalibration,
  validateProgrammeScreeningResult, extractLanguageAssessment, unsupportedLanguageClaim, parseModelJson
} from './runtime.mjs';

assert.deepEqual(parseModelJson('{"probabilities":{"p":{"rank":1}}', 'stop'), { probabilities: { p: { rank: 1 } } },
  'Only a completed response missing one final object brace may be recovered');
assert.throws(() => parseModelJson('{"probabilities":{"p":{"rank":1}}', 'length'));
assert.throws(() => parseModelJson('{"probabilities":{"p":{"rank":1}}', null));
assert.throws(() => parseModelJson('{"probabilities":{"p":{"rank":}}}', 'stop'));

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

// Keep the behavior-defining assets byte-for-byte identical to the old web Agent.
for (const relative of [
  ['case-analysis.mjs', 'case-analysis.mjs'],
  ['assessment-contract.mjs', 'assessment-contract.mjs'],
  ['assessment-system.txt', 'prompts/assessment-system.txt'],
  ['probability-calibration-system.txt', 'prompts/probability-calibration-system.txt'],
  ['project-screening-system.txt', 'prompts/project-screening-system.txt']
]) {
  const normalizeNewlines = value => value.replace(/\r\n/g, '\n').trimEnd();
  assert.equal(
    normalizeNewlines(readFileSync(join(here, relative[0]), 'utf8')),
    normalizeNewlines(readFileSync(join(repoRoot, relative[1]), 'utf8')),
    `${relative[0]} must stay identical to the old Agent source`
  );
}
assert.ok(assessmentPrompt.includes('evidenceSelection'));
assert.ok(assessmentPrompt.includes('comparisonProgrammes'));
assert.ok(readFileSync(join(here, 'probability-calibration-system.txt'), 'utf8').includes('0 条案例仍必须'));
assert.ok(screeningPrompt.includes('selectedProgrammeIds'));

const readJsonLines = name => readFileSync(join(repoRoot, 'miniprogram', 'cloud-data', name), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const programmes = readJsonLines('programmes.json');
const cases = readJsonLines('cases.json');
const official = readJsonLines('programme_evidence.json');
const programme = programmes.find(item => item.programmeId === 'cityu-eie');
assert.ok(programme, 'cityu-eie fixture must exist');

const profile = {
  university: '中国矿业大学', schoolTier: 2, schoolClassification: '211 / 双一流',
  major: 'automation', gpaScale: '100', gpaValue: 81.2,
  languageTest: 'IELTS', language: 7, targetFields: ['automation'],
  internships: [{ direction: 'automation', companyTypes: ['state-owned'] }]
};
const candidate = { ...programme, id: programme.programmeId, name: programme.nameEn };
const programmeCases = cases.filter(item => item.programmeId === programme.programmeId);
const programmeOfficial = official.filter(item => item.programmeId === programme.programmeId);
const prepared = prepareAgentAnalysis(profile, [candidate], {
  [candidate.id]: { allCases: programmeCases, official: programmeOfficial }
});

assert.equal(prepared.comparisons.length, 1);
assert.equal(prepared.comparisons[0].result.assessmentAvailable, false);
assert.equal(prepared.comparisons[0].result.center, null);
assert.equal(prepared.modelInput.programmes[0].caseDistribution.caseCount, programmeCases.length);
assert.ok(prepared.modelInput.programmes[0].evidenceSelection.length > 0);
assert.ok(prepared.modelInput.programmes[0].retrievedEvidence.length <= programmeOfficial.length + 6);
assert.equal(JSON.stringify(prepared).includes('50.6'), false);
const selectedCases = prepared.modelInput.programmes[0].retrievedEvidence.filter(item => item.provenance === 'public-case');
assert.equal(selectedCases[0].metadata.fingerprint, prepared.comparisons[0].result.nearest.fingerprint);
const publicHealth = programmes.find(item => item.programmeId === 'cityu-hk-master-of-public-health');
const publicHealthPrepared = prepareAgentAnalysis({ ...profile, major: 'medicine', majorName: '预防医学' },
  [{ ...publicHealth, id: publicHealth.programmeId, name: publicHealth.nameEn }], {
    [publicHealth.programmeId]: {
      allCases: cases.filter(item => item.programmeId === publicHealth.programmeId),
      official: official.filter(item => item.programmeId === publicHealth.programmeId)
    }
  });
assert.equal(publicHealthPrepared.modelInput.programmes[0].caseDistribution.background.sameMajorCount, 1,
  'The real MPH fixture must recognize the disclosed exact major despite a missing majorField');

const evidenceId = prepared.modelInput.programmes[0].evidenceSelection[0];
const generated = {
  [candidate.id]: {
    center: 48, low: 33, high: 63,
    fit: ['方向与课程存在可核验交集。'],
    psCv: ['CV按任务、方法和结果组织相关经历。'],
    reasoning: [`[${evidenceId}] 根据固定证据形成边界判断。`],
    evidenceUsed: [{ documentId: evidenceId, field: 'programme', comparison: '与申请背景逐项核对', missing: false }],
    uncertainties: ['公开案例只有成功样本，不能解释为真实录取率。']
  }
};
const normalized = normalizeAgentAssessments(generated, prepared);
assert.equal(normalized[candidate.id].center, 48);
assert.deepEqual(normalizeAgentAssessments({ [candidate.id]: {
  ...generated[candidate.id], reasoning: [`${evidenceId} 根据固定证据形成边界判断。`]
} }, prepared)[candidate.id].reasoning, [`[${evidenceId}] 根据固定证据形成边界判断。`]);
assert.equal(normalizeAgentAssessments({ [candidate.id]: { ...generated[candidate.id], center: 101 } }, prepared)[candidate.id], undefined);

const componentLanguage = extractLanguageAssessment({
  requirements: 'IELTS 总分不低于 6.5；单项不低于 6.0。'
}, { languageTest: 'IELTS', language: 6.5 });
assert.equal(componentLanguage.overallMeets, true);
assert.equal(componentLanguage.componentRequirementPresent, true);
assert.equal(componentLanguage.meets, true);
const officialOnlyLanguage = extractLanguageAssessment({ requirements: '' },
  { languageTest: 'IELTS', language: 7 }, [{ id: 'official:requirements', section: 'requirements', provenance: 'official-structured',
    text: '雅思 IELTS 总分不低于 6.5，单项不低于 6.0。' }]);
assert.equal(officialOnlyLanguage.officialTests.IELTS, 6.5);
assert.equal(officialOnlyLanguage.overallMeets, true);
assert.equal(officialOnlyLanguage.componentRequirementPresent, true);
assert.equal(extractLanguageAssessment({ requirements: 'IELTS 6.5' }, { languageTest: 'IELTS', language: null }).overallMeets,
  null, 'An unreported applicant score is unknown, not zero');
const mixedToefl = extractLanguageAssessment({ requirements: '' }, { languageTest: 'TOEFL', language: 95 },
  [{ id: 'hku:requirements', section: 'requirements', provenance: 'official-structured',
    text: '托福不低于587（纸笔）/240（机考）/95（网考），或雅思总分不低于7.0且单项不低于6.0。' }]);
assert.equal(mixedToefl.officialTests.TOEFL, 95, 'Use the internet-based TOEFL minimum, not paper/computer scores');
assert.equal(mixedToefl.officialTests.IELTS, 7);
assert.equal(mixedToefl.overallMeets, true);
assert.equal(extractLanguageAssessment({ requirements: '' }, { languageTest: 'TOEFL', language: 88 },
  [{ id: 'cuhk:requirements', section: 'requirements', provenance: 'official-structured',
    text: 'TOEFL（纸考）570分以上、TOEFL（网考）88分以上、IELTS 6.5分以上。' }]).officialTests.TOEFL, 88);
assert.equal(extractLanguageAssessment({ requirements: '' }, { languageTest: 'IELTS', language: 7 },
  [{ id: 'reversed:requirements', section: 'requirements', provenance: 'official-structured',
    text: '雅思单项不低于 6.0，总分不低于 7.0。' }]).officialTests.IELTS, 7);
assert.equal(extractLanguageAssessment({ requirements: '' }, { languageTest: 'IELTS', language: 7 },
  [{ id: 'component-only:requirements', section: 'requirements', provenance: 'official-structured',
    text: '雅思单项不低于 6.0。' }]).comparable, false);
assert.equal(extractLanguageAssessment({ requirements: '' }, { languageTest: 'IELTS', language: 7 },
  [{ id: 'ai:requirements', section: 'requirements', provenance: 'ai-derived', text: 'IELTS 6.5' }]).comparable, false,
  'AI-derived material must not become an official language threshold');
assert.equal(extractLanguageAssessment({ requirements: '' }, { languageTest: 'IELTS', language: 7 },
  [{ id: 'untagged:requirements', section: 'requirements', text: 'IELTS 6.5' }]).comparable, false,
  'Untagged sources must not silently become official requirements');
const officialPrepared = prepareAgentAnalysis(profile, [{ ...candidate, id: 'official-only', requirements: '', languageMin: null }], {
  'official-only': { allCases: [], official: [{ id: 'official-only:requirements', section: 'requirements',
    provenance: 'official-structured', text: 'IELTS 总分不低于 6.5，单项不低于 6.0。' }] }
});
assert.equal(officialPrepared.modelInput.programmes[0].languageAssessment.officialTests.IELTS, 6.5,
  'The complete Agent input must read official requirements snapshots, not only catalogue cards');
assert.equal(unsupportedLanguageClaim({ fit: ['申请人 IELTS 总分 6.5，达到总分要求。'] }, componentLanguage), false);
assert.equal(unsupportedLanguageClaim({ fit: ['IELTS 总分达标；单项成绩待核验。'] }, componentLanguage), false);
const unknownLanguage = { meets: null };
assert.equal(unsupportedLanguageClaim({ reasoning: ['非英语母语者需满足语言要求，但官方未提供最低分。'] }, unknownLanguage), false);
assert.equal(unsupportedLanguageClaim({ psCv: ['语言成绩虽达标但未被官方确认。'] }, unknownLanguage), true);
const componentPrepared = prepareAgentAnalysis(profile, [{ ...candidate, requirements: 'IELTS 总分不低于 6.5；单项不低于 6.0。' }], {
  [candidate.id]: { allCases: programmeCases, official: programmeOfficial }
});
assert.equal(normalizeAgentAssessments({ [candidate.id]: {
  ...generated[candidate.id], fit: ['申请人 IELTS 7，达到总分要求。']
} }, componentPrepared)[candidate.id].center, 48);

const zeroCaseCandidate = { ...candidate, id: 'zero-case', programmeId: 'zero-case', caseCount: 0 };
const zeroPrepared = prepareAgentAnalysis(profile, [zeroCaseCandidate], {
  'zero-case': { allCases: [], official: [] }
});
assert.deepEqual(zeroPrepared.modelInput.programmes[0].evidenceSelection, ['zero-case:programme-card']);
const calibration = normalizeProbabilityCalibration({ probabilities: {
  [candidate.id]: { rank: 1, center: 55, low: 50, high: 60, confidence: 'medium', basis: ['案例位置'] }
} }, prepared);
assert.equal(calibration[candidate.id].center, 55);
assert.ok(calibration[candidate.id].high - calibration[candidate.id].low >= 20);
assert.deepEqual(normalizeProbabilityCalibration({ probabilities: {
  [candidate.id]: { rank: 1, center: 55, low: 35, high: 75, basis: ['无实习、无奖项，因此相关经历不足'] }
} }, prepared), {}, 'Undisclosed form fields cannot become confirmed applicant disadvantages in ranking');
assert.equal(normalizeProbabilityCalibration({ probabilities: {
  [candidate.id]: { rank: 1, center: 55, low: 35, high: 75, basis: ['无实习/科研经历填写，区间维持较宽'] }
} }, prepared)[candidate.id].center, 55, 'Explicitly describing a disclosure gap is not an absolute absence claim');

const secondCandidate = { ...candidate, id: 'second', programmeId: 'second', name: 'Second Programme' };
const twoPrepared = prepareAgentAnalysis(profile, [candidate, secondCandidate], {
  [candidate.id]: { allCases: programmeCases, official: programmeOfficial },
  second: { allCases: programmeCases, official: programmeOfficial }
});
const separated = normalizeProbabilityCalibration({ probabilities: {
  [candidate.id]: { rank: 1, center: 55, low: 35, high: 75, confidence: 'medium', basis: ['第一'] },
  second: { rank: 2, center: 55, low: 35, high: 75, confidence: 'medium', basis: ['第二'] }
} }, twoPrepared);
assert.equal(separated[candidate.id].center, 55);
assert.equal(separated.second.center, 54);

const zeroEvidenceId = zeroPrepared.modelInput.programmes[0].evidenceSelection[0];
const zeroAssessment = normalizeAgentAssessments({ 'zero-case': {
  center: 40, low: 20, high: 65,
  fit: ['金融方向相关'], psCv: ['说明相关经历'],
  reasoning: [`[${zeroEvidenceId}] 根据项目目录资料与申请背景独立判断。`],
  evidenceUsed: [{ documentId: zeroEvidenceId, field: 'programme', comparison: '项目方向与申请背景相关', missing: false }],
  uncertainties: ['没有公开成功案例']
} }, zeroPrepared);
const zeroCalibration = normalizeProbabilityCalibration({ probabilities: {
  'zero-case': { rank: 1, center: 41, low: 30, high: 50, confidence: 'medium', basis: ['仅项目资料'] }
} }, zeroPrepared);
const mergedZero = mergeProbabilityCalibration(zeroAssessment, zeroCalibration, zeroPrepared)['zero-case'];
assert.equal(mergedZero.center, 41);
assert.equal(mergedZero.confidence, 'low');
assert.equal(mergedZero.evidenceMode, 'ai-project-profile-only');
assert.ok(mergedZero.high - mergedZero.low >= 45);
assert.ok(mergedZero.uncertainties.some(item => item.includes('没有公开成功案例')));

assert.deepEqual(validateProgrammeScreeningResult({
  selectedProgrammeIds: [candidate.id],
  programmeDecisions: { [candidate.id]: { decision: 'include', directionFit: 'direct' } }
}, { projects: [{ id: candidate.id }] }).selectedProgrammeIds, [candidate.id]);

console.log(`legacy Agent cloud runtime checks passed (${programmeCases.length} approved cityu-eie cases)`);
