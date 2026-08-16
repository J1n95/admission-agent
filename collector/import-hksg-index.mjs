import { readFile } from "node:fs/promises";
import { resolveInstitution, programmeMaster } from "../master-data.mjs";
import { normalizeCandidate, resolveHksgIndexedProgramme } from "./agent.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";
import { getCrawlSource, getCrawlSourceScope, insertCases, openCaseStore, recordCrawlSource, storeStatus } from "./store.mjs";

const index = JSON.parse(await readFile("collector/data/hksg-offer-index.json", "utf8"));
const aliasReport = JSON.parse(await readFile("collector/data/programme-alias-map.json", "utf8"));
const aliases = new Map(aliasReport.mappings.filter(row => row.programmeId)
  .map(row => [`${row.institutionId}\t${String(row.sourceName || "").trim()}`, row.programmeId]));
const mappedSourceNames = new Set(aliasReport.mappings.map(row => `${row.institutionId}\t${String(row.sourceName || "").trim()}`));
const target = new Set(["hku", "cuhk", "hkust", "cityu-hk", "polyu-hk", "nus", "ntu", "hkbu", "lingnan-hk", "eduhk"]);
const programmeFilter = process.argv.find(argument => argument.startsWith("--programme="))?.split("=").slice(1).join("=") || null;
const maxRows = Math.max(1, Number(process.argv.find(argument => argument.startsWith("--max-rows="))?.split("=")[1] || 100000));
const coreOnly = process.argv.includes("--core-only");

function parseBackground(row) {
  const raw = String(row.achievement || "");
  const gpaRaw = raw.match(/GPA\s*[:：]?\s*([^/]+?)(?=\s*\/|\s*(?:雅思|托福|IELTS|TOEFL)|$)/i)?.[1]?.trim()
    || (row.gpa ? String(row.gpa).trim() : null);
  const language = raw.match(/(雅思|IELTS|托福|TOEFL)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  return { gpaRaw, languageTest: language?.[1] || null, languageScore: language ? Number(language[2]) : null };
}

async function fetchPublishedAt(row) {
  const url = `https://m.hksg.org/offer_${row.id}`;
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 AdmissionCaseResearchBot/0.1" }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const date = html.match(/class=["']article-info["'][^>]*>[\s\S]*?(20\d{2}-\d{2}-\d{2})/i)?.[1] || null;
    return { row, url, date, error: date ? null : "publication date not found" };
  } catch (error) { return { row, url, date: null, error: error?.message || String(error) }; }
}

const db = openCaseStore();
const selected = index.rows.flatMap(row => {
  const institutionId = resolveInstitution(row.university_name)?.id;
  if (!target.has(institutionId)) return [];
  const sourceKey = `${institutionId}\t${String(row.major_name || "").trim()}`;
  const mappedId = aliases.get(sourceKey);
  const mappedProgramme = mappedId
    ? programmeMaster.find(item => item.id === mappedId && item.institutionId === institutionId)
    : null;
  const programmeId = mappedSourceNames.has(sourceKey) && mappedProgramme
    ? mappedProgramme.id
    : resolveHksgIndexedProgramme(row)?.id || null;
  const programme = programmeId ? programmeMaster.find(item => item.id === programmeId) : null;
  if (!programmeId || (programmeFilter && programmeId !== programmeFilter)) return [];
  if (coreOnly && !/[A-Za-z]*(computer|computing|software|cyber|artificial intelligence|data|analytics|electronic|electrical|communication|telecommunication|signal|integrated circuit|semiconductor|robot|automation|control|mechanical|manufactur|engineering|power|energy|microelectronics)/i.test(`${programme?.nameEn || ""} ${programme?.nameZh || ""}`)) return [];
  const sourceUrl = `https://m.hksg.org/offer_${row.id}`;
  const scoped = getCrawlSourceScope(db, sourceUrl, programmeId);
  const global = getCrawlSource(db, sourceUrl);
  const alreadyCompleted = scoped?.status === "completed" && Number(scoped.scoped_count || 0) > 0
    || !scoped && global?.programme_id === programmeId && global?.status === "completed" && Number(global.scoped_count || 0) > 0;
  return alreadyCompleted ? [] : [{ ...row, institutionId, programmeId }];
}).slice(0, maxRows);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const result = await fetchPublishedAt(selected[cursor++]);
    results.push(result);
    if (results.length % 100 === 0) console.log(JSON.stringify({ progress: results.length, total: selected.length, dates: results.filter(x => x.date).length }));
  }
}
await Promise.all(Array.from({ length: 20 }, worker));

const candidates = results.map(({ row, url, date, error }) => {
  const background = parseBackground(row);
  const programme = programmeMaster.find(item => item.id === row.programmeId);
  const base = normalizeCandidate({
    targetUniversity: row.university_name, targetProgramme: row.major_name,
    targetProgrammeEnglishRaw: programme?.nameEn || null,
    offerYear: date ? Number(date.slice(0, 4)) : null,
    undergraduateUniversity: row.school_name,
    undergraduateMajor: row.school_major,
    ...background,
    sourcePublishedAt: date,
    sourceEvidence: {
      matched: { targetUniversity: true, targetProgramme: true, undergraduateUniversity: true, undergraduateMajor: Boolean(row.school_major), gpaRaw: Boolean(background.gpaRaw), offerYear: Boolean(date) },
      missing: [!row.school_major && "undergraduateMajor", !background.gpaRaw && "gpaRaw", !date && "offerYear"].filter(Boolean),
      inferred: date ? { offerYear: { value: Number(date.slice(0, 4)), confidence: "medium", basis: "source-publication-year-proxy" } } : {},
      indexSource: "hksg-list-data", detailFetchError: error
    }
  }, url);
  base.targetInstitutionId = row.institutionId;
  base.targetProgrammeId = row.programmeId;
  base.targetProgrammeEnglishRaw = programme?.nameEn || null;
  const review = applyReviewPolicy(base);
  return { ...base, reviewStatus: review.status, issues: review.issues, reviewPolicy: review };
});
const inserted = insertCases(db, candidates);
for (const candidate of candidates) recordCrawlSource(db, { sourceUrl: candidate.sourceUrl, programmeId: candidate.targetProgrammeId, extractedCount: 1, scopedCount: 1, queuedCount: inserted.some(row => row.sourceUrl === candidate.sourceUrl) ? 1 : 0, error: candidate.sourceEvidence.detailFetchError });
console.log(JSON.stringify({ programmeFilter, coreOnly, maxRows, selected: selected.length, dates: results.filter(x => x.date).length, inserted: inserted.length, byStatus: Object.fromEntries(Object.entries(Object.groupBy(candidates, row => row.reviewStatus)).map(([k,v]) => [k,v.length])), database: storeStatus(db) }, null, 2));
db.close();
