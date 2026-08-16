import { caseIdentityKey, listCases, openCaseStore } from "./store.mjs";

const db = openCaseStore();
const rows = listCases(db, 10000);
const groups = new Map();
for (const row of rows) {
  const key = caseIdentityKey(row);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const update = db.prepare("UPDATE cases SET evidence_json=?, raw_json=? WHERE fingerprint=?");
let updated = 0;
db.exec("BEGIN");
try {
  for (const group of groups.values()) {
    const source = group.find(row => row.sourceEvidence?.matched && Object.keys(row.sourceEvidence.matched).length);
    if (!source) continue;
    for (const row of group) {
      if (row.reviewStatus === "rejected") continue;
      if (row.sourceEvidence?.matched && Object.keys(row.sourceEvidence.matched).length) continue;
      const raw = (() => {
        try { return JSON.parse(db.prepare("SELECT raw_json FROM cases WHERE fingerprint=?").get(row.fingerprint).raw_json); }
        catch { return {}; }
      })();
      raw.sourceEvidence = source.sourceEvidence;
      update.run(JSON.stringify(source.sourceEvidence), JSON.stringify(raw), row.fingerprint);
      updated += 1;
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  db.close();
  throw error;
}
db.close();
console.log(JSON.stringify({ scanned: rows.length, updated }, null, 2));
