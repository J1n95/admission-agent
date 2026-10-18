import assert from "node:assert/strict";
import { readableEvidenceIds } from "./display-evidence.mjs";

assert.equal(readableEvidenceIds("[e_alpha] 判断；[c_case] 案例；[e_beta] 课程"), "判断；案例；课程");
assert.equal(readableEvidenceIds("[e_missing] 待核对，课程[选修]"), "待核对，课程[选修]");
assert.equal(readableEvidenceIds("[2251f36c6fb07f1db68f] 成功案例；[0a26d82bf92215d58f6c] 可对照"), "成功案例；可对照");
console.log("display-evidence checks passed");
