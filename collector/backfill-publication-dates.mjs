import { copyFile, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { candidateFingerprint, inferSourcePublishedAt, preparePageTextForSource, stripHtml } from "./agent.mjs";

const manifest = process.argv[2];
if (!manifest) throw new Error("用法：node collector/backfill-publication-dates.mjs <URL清单>");

const dbPath = new URL("./data/cases.sqlite", import.meta.url).pathname.slice(1);
const backupPath = dbPath.replace(/\.sqlite$/, `.before-publication-backfill-${Date.now()}.sqlite`);
await copyFile(dbPath, backupPath);
const urls = (await readFile(manifest, "utf8")).split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const db = new DatabaseSync(dbPath);
const select = db.prepare("SELECT * FROM cases WHERE source_url = ? AND offer_year IS NULL");
const updateCase = db.prepare(`UPDATE cases SET fingerprint=?, offer_year=?, source_published_at=?, quality_score=?, review_status=?, issues_json=?, evidence_json=?, raw_json=? WHERE fingerprint=?`);
const updateSource = db.prepare("UPDATE case_sources SET case_fingerprint=? WHERE case_fingerprint=?");
let updated = 0;

db.exec("BEGIN");
try {
  for (const url of urls) {
    const text = preparePageTextForSource(stripHtml(await (await fetch(url)).text()), "compassedu-public-cases");
    const sourcePublishedAt = inferSourcePublishedAt(text);
    const offerYear = Number(sourcePublishedAt?.slice(0, 4));
    if (!offerYear) continue;
    for (const row of select.all(url)) {
      const issues = JSON.parse(row.issues_json || "[]").filter(issue => issue !== "\u7f3a\u5c11\u5f55\u53d6\u5e74\u4efd");
      const evidence = JSON.parse(row.evidence_json || "{}");
      evidence.inferred = { ...evidence.inferred, offerYear: { value: offerYear, confidence: "medium", basis: "source-publication-year-proxy", sourcePublishedAt } };
      const raw = JSON.parse(row.raw_json || "{}");
      Object.assign(raw, { offerYear, sourcePublishedAt, sourceEvidence: evidence });
      const candidate = {
        targetUniversity: row.target_university, targetProgramme: row.target_programme,
        offerYear, undergraduateUniversity: row.undergraduate_university,
        undergraduateMajor: row.undergraduate_major, gpaRaw: row.gpa_raw, gpa100: row.gpa100,
        languageTest: row.language_test, languageScale: row.language_scale, languageScore: row.language_score
      };
      const fingerprint = candidateFingerprint(candidate);
      const reviewStatus = issues.length ? "needs-review" : "pending";
      updateSource.run(fingerprint, row.fingerprint);
      updateCase.run(fingerprint, offerYear, sourcePublishedAt, 100, reviewStatus, JSON.stringify(issues), JSON.stringify(evidence), JSON.stringify(raw), row.fingerprint);
      updated += 1;
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

console.log(JSON.stringify({ updated, backupPath }, null, 2));
