import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCaseStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const aliasMap = JSON.parse(fs.readFileSync(path.join(here, "data", "programme-alias-map.json"), "utf8"));
const lowMappings = aliasMap.mappings.filter(item => item.confidence === "low" && item.sourceName);
const db = openCaseStore();
const find = db.prepare(`SELECT fingerprint, issues_json, evidence_json, raw_json
  FROM cases WHERE source_url LIKE '%hksg.org%' AND target_programme = ? AND review_status = 'approved'`);
const update = db.prepare(`UPDATE cases SET review_status='needs-review', issues_json=?, evidence_json=?, raw_json=?
  WHERE fingerprint=?`);
let downgraded = 0;
for (const mapping of lowMappings) {
  for (const row of find.all(mapping.sourceName)) {
    const issue = "项目别名映射置信度低，需要人工确认";
    const issues = [...new Set([...JSON.parse(row.issues_json || "[]"), issue])];
    const evidence = JSON.parse(row.evidence_json || "{}");
    evidence.programmeAliasMapping = { ...mapping, checkedAt: aliasMap.checkedAt };
    const raw = JSON.parse(row.raw_json || "{}");
    raw.reviewStatus = "needs-review";
    raw.issues = issues;
    raw.sourceEvidence = evidence;
    update.run(JSON.stringify(issues), JSON.stringify(evidence), JSON.stringify(raw), row.fingerprint);
    downgraded += 1;
  }
}
console.log(JSON.stringify({ lowMappings: lowMappings.length, downgraded }, null, 2));
db.close();
