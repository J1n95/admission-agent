import assert from "node:assert/strict";
import { applyReviewPolicy, triageCase } from "./review-engine.mjs";

const base = {
  targetProgrammeId: "cuhk-ee",
  undergraduateInstitutionId: "moe:test",
  undergraduateUniversity: "某大学",
  undergraduateMajor: "电子工程",
  offerYear: 2026,
  gpaRaw: "GPA85",
  gpaScale: "PERCENT_100",
  languageTest: "IELTS",
  languageScore: 7,
  issues: [],
  sourceEvidence: { matched: {
    targetUniversity: true, targetProgramme: true, undergraduateUniversity: true,
    undergraduateMajor: true, gpaRaw: true
  } }
};

assert.equal(triageCase(base).status, "approved");
assert.equal(triageCase({ ...base, offerYear: 2020 }).status, "rejected");
assert.equal(triageCase({ ...base, gpaScale: "UNKNOWN" }).status, "approved");
assert.equal(triageCase({ ...base, undergraduateInstitutionId: null, undergraduateUniversity: "211院校" }).status, "approved");
assert.equal(triageCase({ ...base, undergraduateInstitutionId: null, undergraduateUniversity: "985高校", sourceEvidence: { matched: { ...base.sourceEvidence.matched, undergraduateUniversity: false } }, issues: ["网页正文无法定位字段：undergraduateUniversity"] }).status, "approved");
assert.equal(triageCase({ ...base, languageTest: null, languageScore: null }).status, "approved");
assert.equal(triageCase({ ...base, undergraduateUniversity: "专科院校" }).status, "rejected");
assert.equal(triageCase({ ...base, undergraduateInstitutionId: null, undergraduateUniversity: "某高校" }).status, "needs-review");
assert.equal(triageCase({ ...base, undergraduateMajor: null, sourceEvidence: { matched: { ...base.sourceEvidence.matched, undergraduateMajor: false } } }).status, "rejected");
assert.equal(triageCase({ ...base, targetProgrammeId: null }).status, "needs-review");
assert.equal(triageCase({ ...base, issues: ["缺少语言成绩"] }).status, "approved");
assert.equal(triageCase({ ...base, offerYear: 2019, issues: ["不在最近五年范围"] }).status, "rejected");
assert.equal(triageCase({ ...base, sourceEvidence: { ...base.sourceEvidence, criticalVerification: { status: "conflict" } } }).status, "needs-review");
assert.equal(triageCase({ ...base, sourceEvidence: { ...base.sourceEvidence, criticalVerification: { status: "conflict", unresolved: ["gpaRaw"] } }, issues: ["关键字段二次OCR未通过：gpaRaw"] }).status, "approved");
assert.equal(triageCase({ ...base, sourcePublishedAt: "2026-08-10", sourceEvidence: { ...base.sourceEvidence, criticalVerification: { status: "conflict", unresolved: ["offerYear"] } }, issues: ["缺少录取年份", "关键字段二次OCR未通过：offerYear-missing", "关键字段OCR复核存在冲突，不能自动入库"] }).status, "approved");
assert.equal(triageCase({ ...base, sourceEvidence: { ...base.sourceEvidence, criticalVerification: { status: "conflict" }, reviewAudit: [{ reviewer: "manual", status: "approved" }] } }).status, "approved");

assert.equal(triageCase({ ...base, issues: ["\u9879\u76ee\u672a\u5339\u914d\u4e3b\u8868"] }).status, "approved");
assert.equal(triageCase({ ...base, issues: ["\u6848\u4f8b\u4fdd\u7559\u5728\u9694\u79bb\u533a\uff0c\u4e0d\u8fdb\u5165\u5f53\u524d\u5de5\u79d1\u5206\u6790"] }).status, "approved");
assert.equal(triageCase({ ...base, issues: ["网页正文无法定位字段：targetProgramme"] }).status, "approved");
assert.equal(triageCase({ ...base, undergraduateUniversity: "\u4fc4\u4ea5\u4fc4\u5dde\u7acb\u5927\u5b66", undergraduateInstitutionId: "ohio-state", issues: ["\u672c\u79d1\u9662\u6821\u65e2\u672a\u8bc6\u522b\u4e3a\u5177\u4f53\u9ad8\u6821\uff0c\u4e5f\u672a\u62ab\u9732985/211/\u53cc\u4e00\u6d41/\u53cc\u975e\u6216\u6d77\u5916\u672c\u79d1\u5c42\u7ea7"] }).status, "approved");
assert.equal(triageCase({ ...base, undergraduateUniversity: "\u9ad8\u7ea7\u4e2d\u5b66" }).status, "rejected");
assert.deepEqual(applyReviewPolicy({ ...base, issues: ["缺少语言成绩", "缺少语言成绩；缺少语言成绩", "????"] }).issues, []);
assert.deepEqual(
  applyReviewPolicy({ ...base, undergraduateInstitutionId: null, undergraduateUniversity: "某高校", issues: ["本科院校未匹配主表；本科院校未匹配主表"] }).issues,
  ["本科院校未匹配主表", "本科院校既未识别为具体高校，也未披露985/211/双一流/双非或海外本科层级"]
);

console.log("review-engine checks passed");
