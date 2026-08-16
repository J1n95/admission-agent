import { copyFile } from "node:fs/promises";
import { classifyExperienceRecords, mergeExperienceFields } from "./experience-classifier.mjs";
import { defaultDbPath, openCaseStore } from "./store.mjs";

const dbPath = process.argv[2] || defaultDbPath;
const backupPath = `${dbPath}.before-experience-backfill`;
await copyFile(dbPath, backupPath);

const db = openCaseStore(dbPath);
const rows = db.prepare(`SELECT fingerprint, internships_json, work_experience_json, research_json,
  competitions_json, awards_json, patents_json, projects_json, experiences_json, raw_json FROM cases`).all();
const update = db.prepare(`UPDATE cases SET internships_json=?, work_experience_json=?, research_json=?,
  competitions_json=?, awards_json=?, patents_json=?, projects_json=?, experiences_json=?, raw_json=? WHERE fingerprint=?`);

let changed = 0;
let inferredRecords = 0;
db.exec("BEGIN");
try {
  for (const row of rows) {
    const candidate = {
      internships: JSON.parse(row.internships_json || "[]"),
      workExperience: JSON.parse(row.work_experience_json || "[]"),
      research: JSON.parse(row.research_json || "[]"),
      competitions: JSON.parse(row.competitions_json || "[]"),
      awards: JSON.parse(row.awards_json || "[]"),
      patents: JSON.parse(row.patents_json || "[]"),
      projects: JSON.parse(row.projects_json || "[]"),
      experiences: JSON.parse(row.experiences_json || "[]")
    };
    const experiences = classifyExperienceRecords(candidate.experiences);
    const fields = mergeExperienceFields({ ...candidate, experiences });
    const before = JSON.stringify(candidate);
    const after = JSON.stringify({ ...fields, experiences });
    if (before === after) continue;
    const raw = { ...JSON.parse(row.raw_json || "{}"), ...fields, experiences };
    update.run(
      JSON.stringify(fields.internships), JSON.stringify(fields.workExperience), JSON.stringify(fields.research),
      JSON.stringify(fields.competitions), JSON.stringify(fields.awards), JSON.stringify(fields.patents),
      JSON.stringify(fields.projects), JSON.stringify(experiences), JSON.stringify(raw), row.fingerprint
    );
    changed += 1;
    inferredRecords += experiences.filter(item => item.category !== "unknown").length;
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.close();
console.log(JSON.stringify({ scanned: rows.length, changed, inferredRecords, backupPath }, null, 2));
