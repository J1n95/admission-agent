import { caseIdentityKey, compareCaseFields, listCases, openCaseStore } from "./store.mjs";

const db = openCaseStore();
const rows = listCases(db, 10000);
const groups = new Map();
for (const row of rows) {
  const key = caseIdentityKey(row);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const update = db.prepare("UPDATE cases SET review_status='rejected', issues_json=? WHERE fingerprint=?");
const sourceLink = db.prepare(`INSERT OR IGNORE INTO case_sources
  (case_fingerprint, source_url, evidence_json, comparison_json, first_seen_at) VALUES (?, ?, ?, ?, ?)`);
const duplicates = [];
db.exec("BEGIN");
try {
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => String(a.collectedAt || "").localeCompare(String(b.collectedAt || "")));
    const keeper = ordered.find(row => row.reviewStatus === "approved") || ordered[0];
    for (const row of ordered) {
      if (row.fingerprint === keeper.fingerprint || row.reviewStatus === "rejected") continue;
      const issues = [...new Set([...(row.issues || []), `与案例 ${keeper.fingerprint} 疑似重复；保留原始记录但不进入分析`])];
      update.run(JSON.stringify(issues), row.fingerprint);
      if (row.sourceUrl) sourceLink.run(
        keeper.fingerprint,
        row.sourceUrl,
        JSON.stringify(row.sourceEvidence || {}),
        JSON.stringify(compareCaseFields(keeper, row)),
        row.collectedAt || new Date().toISOString()
      );
      duplicates.push({ rejected: row.fingerprint, kept: keeper.fingerprint, sourceUrl: row.sourceUrl });
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  db.close();
  throw error;
}
db.close();
console.log(JSON.stringify({ scanned: rows.length, duplicatesRejected: duplicates.length, duplicates }, null, 2));
