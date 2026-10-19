import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { parseCsvLine } from "./csv.mjs";
import { referenceDbPath, resolveReferenceInstitution, searchInstitutions } from "./reference-store.mjs";

assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
assert.equal(searchInstitutions("南京大学", 5)[0].id, "nju");
assert.equal(searchInstitutions("清华", 5)[0].id, "tsinghua");
assert.ok(searchInstitutions("CUHK", 5).some(item => item.id === "cuhk"));
assert.equal(searchInstitutions("成都理工大学", 5)[0].classification, "双一流");
if (existsSync(referenceDbPath)) {
  assert.match(resolveReferenceInstitution("Massachusetts Institute of Technology")?.id || "", /^(https:\/\/ror\.org\/|hipo:)/);
  const moeMatch = searchInstitutions("北京体育大学", 5).find(item => item.source === "MOE");
  if (moeMatch) assert.match(moeMatch.id, /^moe:\d{10}$/);
  assert.equal(resolveReferenceInstitution("北京交通大学")?.classification, "211 / 双一流");
  assert.equal(resolveReferenceInstitution("杭州师范大学")?.classification, "双非");
  assert.equal(resolveReferenceInstitution("中国石油大学（北京）")?.classification, "211 / 双一流");
  assert.equal(resolveReferenceInstitution("杭州师范大学钱江学院")?.classification, "民办本科");
  assert.equal(resolveReferenceInstitution("杭州师范大学钱江学院")?.scoreTier, 1);
  assert.equal(resolveReferenceInstitution("西交利物浦大学")?.scoreTier, null);
  assert.equal(searchInstitutions("杭州师范大学", 5).find(item => item.nameZh === "杭州师范大学")?.scoreTier, 1);
  assert.equal(resolveReferenceInstitution("国家开放大学")?.scoreTier, null);
}

console.log("reference-store checks passed");
