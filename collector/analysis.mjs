import { openCaseStore } from "./store.mjs";

const round = value => Math.round(value * 100) / 100;
const groupCount = (rows, key) => Object.fromEntries(Object.entries(rows.reduce((total, row) => {
  const value = row[key] ?? "missing";
  total[value] = (total[value] || 0) + 1;
  return total;
}, {})).sort());
const average = values => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};

export function summarizeCases(rows) {
  const percentGpas = rows.map(row => row.gpa100).filter(Number.isFinite);
  const categories = ["internships", "workExperience", "research", "competitions", "awards", "patents", "projects"];
  return {
    total: rows.length,
    reviewStatus: groupCount(rows, "reviewStatus"),
    sources: new Set(rows.map(row => row.sourceUrl)).size,
    gpaScales: groupCount(rows, "gpaScale"),
    comparablePercentGpa: percentGpas.length ? {
      count: percentGpas.length,
      min: Math.min(...percentGpas),
      mean: average(percentGpas),
      median: median(percentGpas),
      max: Math.max(...percentGpas)
    } : null,
    language: rows.reduce((total, row) => {
      const key = row.languageTest ? `${row.languageTest}:${row.languageScale}` : "missing";
      total[key] = (total[key] || 0) + 1;
      return total;
    }, {}),
    background: Object.fromEntries(categories.map(category => {
      const counts = rows.map(row => (row[category] || []).length);
      return [category, { disclosedCases: counts.filter(Boolean).length, totalItems: counts.reduce((sum, value) => sum + value, 0), averageItems: average(counts) }];
    }))
  };
}

if (process.argv[1]?.endsWith("analysis.mjs")) {
  const db = openCaseStore();
  try {
    const allRows = db.prepare("SELECT raw_json, review_status FROM cases ORDER BY collected_at").all();
    const allCandidates = allRows.map(row => ({ ...JSON.parse(row.raw_json), reviewStatus: row.review_status }));
    const includeAll = process.argv.includes("--all");
    const rows = includeAll
      ? allCandidates
      : allRows.filter(row => row.review_status === "approved")
        .map(row => ({ ...JSON.parse(row.raw_json), reviewStatus: row.review_status }));
    console.log(JSON.stringify({
      analysisMode: includeAll ? "all-records" : "approved-only",
      excludedFromDefault: includeAll ? 0 : allCandidates.length - rows.length,
      ...summarizeCases(rows)
    }, null, 2));
  } finally {
    db.close();
  }
}
