import { stripHtml } from "./agent.mjs";
import { listCases, openCaseStore } from "./store.mjs";

const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const programmeId = option("programme");
const limit = Math.max(1, Number(option("limit") || 100));
const normalize = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const languageLabels = {
  IELTS: ["IELTS", "雅思"],
  TOEFL: ["TOEFL", "托福"]
};

function valuesFor(row) {
  return [
    ["targetUniversity", row.targetUniversity],
    ["targetProgramme", row.targetProgramme],
    ["undergraduateUniversity", row.undergraduateUniversity],
    ["undergraduateMajor", row.undergraduateMajor],
    ["gpaRaw", row.gpaRaw],
    ...["internships", "workExperience", "research", "competitions", "awards", "patents", "projects"]
      .flatMap(field => (row[field] || []).map((value, index) => [`${field}[${index}]`, value]))
  ].filter(([, value]) => value !== null && value !== undefined && normalize(value));
}

function verifyRow(row, pageText) {
  const text = normalize(pageText);
  const missing = valuesFor(row)
    .filter(([, value]) => !text.includes(normalize(value)))
    .map(([field]) => field);
  const labels = languageLabels[row.languageTest] || [];
  const languageLabelFound = labels.length > 0 && labels.some(label => text.includes(label));
  const languageScoreFound = row.languageScore == null || text.includes(String(row.languageScore));
  if (row.languageTest && !languageLabelFound) missing.push("languageTest");
  if (row.languageScore != null && !languageScoreFound) missing.push("languageScore");
  if (row.issues?.length) missing.push("issues");
  const checked = valuesFor(row).length + (row.languageTest ? 1 : 0) + (row.languageScore != null ? 1 : 0) + (row.issues?.length ? 1 : 0);
  const matched = Math.max(0, checked - missing.length);
  return {
    fingerprint: row.fingerprint,
    reviewStatus: row.reviewStatus,
    targetProgrammeId: row.targetProgrammeId,
    undergraduateUniversity: row.undergraduateUniversity,
    sourceUrl: row.sourceUrl,
    matched,
    checked,
    confidence: checked ? Math.round(matched / checked * 100) : 0,
    missing,
    suggestedAction: missing.length ? "manual-review" : "open-source-confirmation"
  };
}

const db = openCaseStore();
try {
  const rows = listCases(db, 1000)
    .filter(row => (!programmeId || row.targetProgrammeId === programmeId) && ["pending", "needs-review"].includes(row.reviewStatus))
    .slice(0, limit);
  const pages = new Map();
  const report = [];
  for (const row of rows) {
    if (!pages.has(row.sourceUrl)) {
      const response = await fetch(row.sourceUrl);
      if (!response.ok) throw new Error(`source fetch failed ${response.status}: ${row.sourceUrl}`);
      pages.set(row.sourceUrl, stripHtml(await response.text()));
    }
    report.push(verifyRow(row, pages.get(row.sourceUrl)));
  }
  console.log(JSON.stringify({ programmeId: programmeId || null, scanned: report.length, report }, null, 2));
} finally {
  db.close();
}
