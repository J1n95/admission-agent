import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeCandidate } from "./agent.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";
import { defaultDbPath, insertCases, openCaseStore, replaceCasesForSource } from "./store.mjs";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("用法：node collector/import-batch.mjs <批次JSON>");

const payload = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const rows = Array.isArray(payload) ? payload : payload.cases;
if (!Array.isArray(rows)) throw new Error("批次JSON必须是数组或包含cases数组");

const normalized = rows.map(row => {
  const candidate = normalizeCandidate(row, row.sourceUrl);
  const review = applyReviewPolicy(candidate);
  return { ...candidate, reviewStatus: review.status, issues: review.issues, reviewPolicy: review };
});
const replaceSource = process.argv.includes("--replace-source");
const db = openCaseStore();
try {
  const inserted = replaceSource
    ? replaceCasesForSource(db, normalized[0]?.sourceUrl, normalized)
    : insertCases(db, normalized);
  console.log(JSON.stringify({ input: rows.length, inserted: inserted.length, duplicates: replaceSource ? 0 : rows.length - inserted.length, replacedSource: replaceSource ? normalized[0]?.sourceUrl : null, database: defaultDbPath }, null, 2));
} finally {
  db.close();
}
