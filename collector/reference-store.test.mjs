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
}

console.log("reference-store checks passed");
