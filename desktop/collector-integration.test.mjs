import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "admission-collector-"));
const databasePath = join(directory, "cases.sqlite");
copyFileSync(join(root, "build/desktop-seed/cases-seed.sqlite"), databasePath);
process.env.ADMISSION_DATA_DIR = directory;
process.env.ADMISSION_AGENT_DATA_DIR = join(root, "build/desktop-seed");

let db;
try {
  const { loadAnalysisEvidence, refreshApprovedCases, toAgentCase } = await import("./legacy-analysis.mjs");
  const mapped = toAgentCase({
    fingerprint: "new-approved-case", targetProgrammeId: "cuhk-ee", targetInstitutionId: "cuhk",
    offerYear: 2026, undergraduateUniversity: "示例大学", undergraduateMajor: "电子工程",
    gpaRaw: "85/100", gpaScale: "100", gpa100: 85, languageTest: "IELTS", languageScore: 7,
    internships: [{ raw: "电子工程实习" }], research: ["机器人项目"], completenessScore: 80,
    sourceUrl: "https://example.org/private-case"
  });
  assert.equal(mapped._id, "new-approved-case");
  assert.equal(mapped.gpa.value100, 85);
  assert.deepEqual(mapped.experiences.internships, ["电子工程实习"]);
  assert.equal("sourceUrl" in mapped, false);

  db = new DatabaseSync(databasePath);
  const original = db.prepare("SELECT * FROM cases WHERE target_programme_id IS NOT NULL LIMIT 1").get();
  const programmeId = original.target_programme_id;
  const count = () => {
    refreshApprovedCases();
    return loadAnalysisEvidence([{ id: programmeId }], {}).evidenceByProgramme[programmeId].allCases.length;
  };
  const before = count();
  const columns = Object.keys(original);
  const insert = db.prepare(`INSERT INTO cases (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  insert.run(...columns.map(key => key === "fingerprint" ? "new-approved-case" : key === "review_status" ? "approved" : original[key]));
  assert.equal(count(), before + 1, "new approved case must appear in the next analysis");
  insert.run(...columns.map(key => key === "fingerprint" ? "new-pending-case" : key === "review_status" ? "pending" : original[key]));
  assert.equal(count(), before + 1, "pending case must stay out of analysis");
  db.prepare("UPDATE cases SET review_status='rejected' WHERE fingerprint=?").run(original.fingerprint);
  assert.equal(count(), before, "rejected seed case must disappear from analysis");
  console.log("desktop collector case mapping and approved-only refresh: ok");
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
