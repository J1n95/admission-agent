import assert from 'node:assert/strict';
import { extractLanguageAssessment, unsupportedLanguageClaim } from '../miniprogram/cloudfunctions/admissionApi/agent/runtime.mjs';

// Synthetic contract tests, not a measurement of real model accuracy.
const unsafeClaims = [
  '申请人 IELTS 6.5，完全满足语言要求。',
  '你的雅思成绩符合语言要求。',
  '申请人已经达到语言门槛。',
  '雅思成绩达标。',
  '申请人超过官方语言最低要求。',
  '申请人满足 IELTS 最低要求。',
  '语言要求已满足。',
  '托福成绩已达标。',
  '申请人符合 TOEFL 要求。',
  '申请人已满足全部语言要求。'
];
const safeClaims = [
  'IELTS 总分达标，但单项成绩待核验。',
  '雅思总分达到最低分；不能确认语言要求已全部满足。',
  '申请人没有提供雅思单项成绩。',
  '语言要求尚未满足。',
  '官方资料没有可核验总分要求，因此不能声称申请人 IELTS 7 满足或超过语言门槛。',
  '当前证据不足，语言是否达标未知。',
  '建议补充单项分数再确认语言门槛。',
  'TOEFL 总分达到要求，单项尚未核验。',
  '语言达标情况需要进一步核验。',
  '官方未披露可比较的语言要求。'
];
const withComponents = extractLanguageAssessment(
  { requirements: 'IELTS 总分不低于 6.5，单项不低于 6.0。TOEFL 总分不低于 90，单项不低于 20。' },
  { languageTest: 'IELTS', language: 6.5 }
);
const belowMinimum = extractLanguageAssessment(
  { requirements: 'IELTS 总分不低于 6.5。' }, { languageTest: 'IELTS', language: 5.5 }
);
const noRequirement = extractLanguageAssessment(
  { requirements: '具体语言要求请以官方页面为准。' }, { languageTest: 'IELTS', language: 7 }
);
const fullyMet = extractLanguageAssessment(
  { requirements: 'IELTS 总分不低于 6.5。' }, { languageTest: 'IELTS', language: 7 }
);
const scenarios = [
  ...unsafeClaims.map((claim, index) => ({ id: `component-${index + 1}`, claim, assessment: withComponents, reject: false })),
  ...unsafeClaims.map((claim, index) => ({ id: `below-${index + 1}`, claim, assessment: belowMinimum, reject: true })),
  ...unsafeClaims.map((claim, index) => ({ id: `unknown-${index + 1}`, claim, assessment: noRequirement, reject: true })),
  ...safeClaims.map((claim, index) => ({ id: `safe-${index + 1}`, claim, assessment: withComponents, reject: false })),
  ...unsafeClaims.map((claim, index) => ({ id: `met-${index + 1}`, claim, assessment: fullyMet, reject: false }))
];
assert.equal(scenarios.length, 50);
assert.equal(withComponents.overallMeets, true);
assert.equal(withComponents.meets, true);
assert.equal(belowMinimum.meets, false);
assert.equal(noRequirement.meets, null);
assert.equal(fullyMet.meets, true);
let passed = 0;
for (const scenario of scenarios) {
  const actual = unsupportedLanguageClaim({ fit: [scenario.claim] }, scenario.assessment);
  assert.equal(actual, scenario.reject, `${scenario.id}: ${scenario.claim}`);
  passed++;
}
console.log(`${passed}/${scenarios.length} synthetic language-claim guardrail checks passed; not an Agent accuracy score`);
