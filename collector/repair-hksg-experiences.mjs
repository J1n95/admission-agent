import { copyFile } from "node:fs/promises";
import { classifyExperienceRecords, mergeExperienceFields } from "./experience-classifier.mjs";
import { extractStructuredCasesForSource, preparePageTextForSource, stripHtml } from "./agent.mjs";
import { defaultDbPath, openCaseStore } from "./store.mjs";

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const limit = Math.max(0, Number(option("limit") || 0));
const concurrency = Math.max(1, Math.min(16, Number(option("concurrency") || 8)));
const requestedFingerprints = new Set(String(option("fingerprints") || "").split(",").map(value => value.trim()).filter(Boolean));
const dbPath = option("db") || defaultDbPath;
const backupPath = `${dbPath}.before-hksg-experience-repair`;
await copyFile(dbPath, backupPath);

const db = openCaseStore(dbPath);
const rows = db.prepare(`SELECT fingerprint, source_url, raw_json FROM cases
  WHERE source_url LIKE 'https://m.hksg.org/offer_%' AND experiences_json='[]'
  ORDER BY review_status='approved' DESC, offer_year DESC, fingerprint`).all()
  .filter(row => !requestedFingerprints.size || requestedFingerprints.has(row.fingerprint))
  .slice(0, limit || undefined);
const update = db.prepare(`UPDATE cases SET internships_json=?, work_experience_json=?, research_json=?,
  competitions_json=?, awards_json=?, patents_json=?, projects_json=?, experiences_json=?, raw_json=? WHERE fingerprint=?`);

let cursor = 0;
let repaired = 0;
let noDisclosure = 0;
const errors = [];

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "AdmissionCaseResearchBot/0.1" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return preparePageTextForSource(stripHtml(await response.text()), "hksg-public-cases");
}

async function worker() {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    try {
      const pageText = await fetchText(row.source_url);
      const extracted = extractStructuredCasesForSource(pageText, "hksg-public-cases")[0];
      const experiences = classifyExperienceRecords(extracted?.experiences || []);
      if (!experiences.some(item => item.category !== "unknown")) {
        noDisclosure += 1;
        continue;
      }
      const fields = mergeExperienceFields({ experiences });
      const raw = { ...JSON.parse(row.raw_json || "{}"), ...fields, experiences };
      update.run(
        JSON.stringify(fields.internships), JSON.stringify(fields.workExperience), JSON.stringify(fields.research),
        JSON.stringify(fields.competitions), JSON.stringify(fields.awards), JSON.stringify(fields.patents),
        JSON.stringify(fields.projects), JSON.stringify(experiences), JSON.stringify(raw), row.fingerprint
      );
      repaired += 1;
    } catch (error) {
      errors.push({ fingerprint: row.fingerprint, url: row.source_url, error: error.message });
    }
    const processed = repaired + noDisclosure + errors.length;
    if (processed % 50 === 0 || processed === rows.length) {
      console.log(`processed=${processed}/${rows.length} repaired=${repaired} noDisclosure=${noDisclosure} errors=${errors.length}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));
db.close();
console.log(JSON.stringify({ scanned: rows.length, repaired, noDisclosure, errors: errors.length, errorSamples: errors.slice(0, 10), backupPath }, null, 2));
