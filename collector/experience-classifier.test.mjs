import assert from "node:assert/strict";
import { approximateExperienceCount, classifyExperienceRecords, mergeExperienceFields } from "./experience-classifier.mjs";

const records = classifyExperienceRecords([
  { raw: "1、科研：1段", category: "unknown" },
  { raw: "2、软著专利一项", category: "unknown" },
  { raw: "实习两段", category: "unknown" },
  { raw: "大创项目", category: "unknown" },
  { raw: "数据分析中心分析员 2. 挑战杯", category: "unknown" }
]);

assert.deepEqual(records.map(item => item.category), ["research", "patent", "internship", "project", "work", "competition"]);
const fields = mergeExperienceFields({ experiences: records });
assert.deepEqual(fields.internships, ["实习两段"]);
assert.deepEqual(fields.research, ["科研：1段"]);
assert.deepEqual(fields.patents, ["软著专利一项"]);
assert.deepEqual(fields.projects, ["大创项目"]);
assert.deepEqual(fields.competitions, ["挑战杯"]);
assert.equal(approximateExperienceCount("科研两段"), 2);
assert.equal(approximateExperienceCount("专利一项"), 1);
assert.equal(approximateExperienceCount("银行风险分析实习"), 1);
assert.equal(approximateExperienceCount(""), 0);

console.log("experience-classifier tests passed");
