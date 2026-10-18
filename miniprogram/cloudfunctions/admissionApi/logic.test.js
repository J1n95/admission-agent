const assert = require('node:assert/strict');
const {
  searchInstitutions, searchMajors, selectCandidates, selectEvidenceCases,
  summarizeEvidenceCase, caseGpa100, isOpenidLimitExempt
} = require('./logic');

assert.equal(searchInstitutions([{ id: '1', nameZh: '中国矿业大学', aliases: ['矿大'] }], '矿大')[0].id, '1');
assert.equal(searchMajors([{ code: '080801', name: '自动化', aliases: [], field: 'automation' }], '自动')[0].field, 'automation');
assert.equal(isOpenidLimitExempt('owner-openid', 'other,owner-openid'), true);
assert.equal(isOpenidLimitExempt('owner-openid', 'owner'), false);

const broadElectronic = {
  id: 'broad', region: '香港', university: '香港城市大学',
  nameZh: '电子信息工程理学硕士', name: 'Electronic Information Engineering',
  majorTags: ['automation', 'electronic'], caseCount: 100
};
const directAutomation = {
  id: 'direct', region: '香港', university: '香港中文大学',
  nameZh: '机械与自动化工程理学硕士', name: 'Mechanical and Automation Engineering',
  majorTags: ['automation', 'mechanical'], caseCount: 2
};
assert.equal(selectCandidates(
  [broadElectronic, directAutomation],
  { regions: ['香港'], fields: ['automation'], profile: { major: 'automation' } }
)[0].id, 'direct');

const profile = {
  major: 'automation', gpaScale: '100', gpaValue: 82,
  languageTest: 'IELTS', language: 7,
  internships: [{ direction: 'automation', companyTypes: ['state-owned'] }]
};
const evidence = [
  { _id: 'near', offerYear: 2025, undergraduate: { majorField: 'automation' }, gpa: { value100: 81 }, language: { test: 'IELTS', score: 7 }, experienceTags: ['automation'], companyTypes: ['state-owned'], qualityScore: 90 },
  { _id: 'far', offerYear: 2021, undergraduate: { majorField: 'finance' }, gpa: { value100: 65 }, language: { test: 'IELTS', score: 5.5 }, experienceTags: ['finance'], companyTypes: [], qualityScore: 60 }
];
assert.equal(selectEvidenceCases(evidence, profile, 1)[0]._id, 'near');
assert.equal(caseGpa100({ gpa: { raw: '85-89', value100: 89 } }), 87);

const caseSummary = summarizeEvidenceCase({
  _id: 'near', offerYear: 2025,
  undergraduate: { university: '某大学', classification: '211 / 双一流', major: '自动化', majorField: 'automation' },
  gpa: { value100: 81 }, language: { test: 'IELTS', score: 7 },
  experiences: { internships: ['实习:3段'], research: ['研究项目'], awards: ['奖项：无'] }
}, profile);
assert.equal(caseSummary.experience, '实习3 · 科研1');
assert.ok(caseSummary.comparison.includes('本科方向相同'));

const canonicalProfile = {
  ...profile,
  gpaValue: 100,
  gpaStandardization: { rawScore: 81.2, rawScale: '100' }
};
const higherCase = summarizeEvidenceCase({
  _id: 'higher', gpa: { value100: 87 }, experiences: {}
}, canonicalProfile);
const lowerCase = summarizeEvidenceCase({
  _id: 'lower', gpa: { value100: 80 }, experiences: {}
}, canonicalProfile);
assert.ok(higherCase.comparison.includes('案例成绩高于你 5.8 分'));
assert.ok(lowerCase.comparison.includes('案例成绩低于你 1.2 分'));
assert.equal(higherCase.comparison.includes('低于你 13.0 分'), false);

const fourPointSummary = summarizeEvidenceCase({
  _id: 'four-point', gpa: { value100: 87 }, experiences: {}
}, { gpaStandardization: { rawScore: 3.3, rawScale: '4', comparablePercent: 85 } });
const fivePointSummary = summarizeEvidenceCase({
  _id: 'five-point', gpa: { value100: 80 }, experiences: {}
}, { gpaStandardization: { rawScore: 4.1, rawScale: '5', comparablePercent: 82 } });
assert.ok(fourPointSummary.comparison.includes('案例成绩高于你 2.0 分'));
assert.ok(fivePointSummary.comparison.includes('案例成绩低于你 2.0 分'));

// Probability generation intentionally does not exist here. It belongs to the old Agent prompt + contract path.
assert.equal(require('./logic').heuristicAssessment, undefined);
assert.equal(require('./logic').institutionReferenceAdjustment, undefined);
console.log('admissionApi retrieval/UI logic checks passed');
