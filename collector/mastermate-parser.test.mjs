import assert from "node:assert/strict";
import { extractMastermateBackground, extractMastermateGpa } from "./mastermate-parser.mjs";

const cases = [
  ["双非，金融学 83分 雅思6", "83", "PERCENT_100", 83],
  ["双非，管理科学，2.87，雅思6.5", "2.87", "UNKNOWN", null],
  ["双非，会计84.47/3.29，雅思6.5", "84.47/3.29", "UNKNOWN", null],
  ["GPA 3.23，雅思7", "3.23", "UNKNOWN", null],
  ["GPA 3.23/4.0", "3.23/4.0", "GPA_4", 80.75],
  ["均分85分，雅思6.5", "85", "PERCENT_100", 85],
  ["商业智能和信息系统，4.83/7", "4.83/7", "GPA_7", 69],
  ["汉语言文学，3.8/4.5，雅思6.5", "3.8/4.5", "GPA_4.5", 84.44444444444444],
  ["公共卫生（预防医学）+83.62", "83.62", "PERCENT_100", 83.62],
  ["经济与金融，81.07/100", "81.07/100", "PERCENT_100", 81.07]
];

for (const [input, raw, scale, gpa100] of cases) {
  const actual = extractMastermateGpa(input);
  assert.ok(actual, input);
  assert.equal(actual.gpaRaw, raw, input);
  assert.equal(actual.gpaScale, scale, input);
  assert.equal(actual.gpa100, gpa100, input);
}

const backgrounds = [
  ["双非一本 医学实验技术 GPA3.26/5 雅思6", "双非一本", "医学实验技术", "3.26/5"],
  ["211，金融，3.6/4.0，雅思7", "211", "金融", "3.6/4.0"],
  ["双非，管理科学，2.87，雅思6.5", "双非", "管理科学", "2.87"],
  ["（海本QS267）+2024年毕业+经济学+3.4/4+GRE332", "海本QS267", "经济学", "3.4/4"]
];

for (const [input, institution, major, gpaRaw] of backgrounds) {
  const actual = extractMastermateBackground(input);
  assert.equal(actual.institution, institution, input);
  assert.equal(actual.major, major, input);
  assert.equal(actual.gpaRaw, gpaRaw, input);
}

console.log(JSON.stringify({ passedGpa: cases.length, passedBackgrounds: backgrounds.length }));
