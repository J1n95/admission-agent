import assert from "node:assert/strict";
import { modelReferencePresentation, readableEvidenceIds } from "./display-evidence.mjs";

assert.equal(readableEvidenceIds("[e_alpha] 判断；[c_case] 案例；[e_beta] 课程"), "判断；案例；课程");
assert.equal(readableEvidenceIds("[e_missing] 待核对，课程[选修]"), "待核对，课程[选修]");
assert.equal(readableEvidenceIds("[2251f36c6fb07f1db68f] 成功案例；[0a26d82bf92215d58f6c] 可对照"), "成功案例；可对照");
assert.equal(readableEvidenceIds("【e_2861790accc2aa613e3a4981:requirements】 官方要求"), "官方要求");
assert.equal(readableEvidenceIds("e_2861790accc2aa613e3a4981：语言总分达到要求"), "语言总分达到要求");
assert.equal(readableEvidenceIds("2251f36c6fb07f1db68f 案例均分相近"), "案例均分相近");
assert.equal(readableEvidenceIds("cityu-hk-msc-ee:programme-card 项目方向匹配"), "项目方向匹配");
assert.equal(readableEvidenceIds("课程[选修]与[2026]学年信息"), "课程[选修]与[2026]学年信息");
const modelResult = { assessmentAvailable: true, center: 41, low: 18, high: 63 };
assert.deepEqual(modelReferencePresentation(modelResult, 0), {
  available: true, intervalOnly: true, label: "模型区间参考 · 证据有限", value: "18%–63%"
});
assert.equal(modelReferencePresentation(modelResult, 4).value, "18%–63%");
assert.equal(modelReferencePresentation(modelResult, 5).value, "41%");
assert.equal(modelReferencePresentation({}, 10).value, "暂无数值");
console.log("display-evidence checks passed");
