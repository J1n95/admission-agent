import { resolveProgramme } from "../master-data.mjs";
import { normalizeCandidate } from "./agent.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";
import { insertCases, openCaseStore, recordCrawlSource, storeStatus } from "./store.mjs";
import { extractMastermateBackground } from "./mastermate-parser.mjs";

const targetDistricts = [1, 4];
const flagValue = (name, fallback = null) => {
  const value = process.argv.find(argument => argument.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  return value == null || value === "" ? fallback : value;
};
const maxPages = Math.max(1, Number(flagValue("max-pages", Number.POSITIVE_INFINITY)) || Number.POSITIVE_INFINITY);
const startPage = Math.max(1, Number(flagValue("start-page", 1)) || 1);
const minOfferYear = Math.max(2021, Number(flagValue("min-year", 2021)) || 2021);
const quiet = process.argv.includes("--quiet");
const institutionIds = String(flagValue("institutions", ""))
  .split(",").map(value => value.trim()).filter(Boolean);
const focusTags = String(flagValue("focus-tags", ""))
  .split(",").map(value => value.trim()).filter(Boolean);
const home = await fetch("https://www.mastermate.cn/admission", { headers: { "user-agent": "Mozilla/5.0 AdmissionCaseResearchBot/0.1" } });
const html = await home.text();
const token = html.match(/name=["']csrf-token["'] content=["']([^"']+)/)?.[1];
const cookie = (home.headers.getSetCookie?.() || []).map(value => value.split(";")[0]).join("; ");
if (!token) throw new Error("Mastermate CSRF token unavailable");

async function page(districtId, pageNumber) {
  const response = await fetch(`https://www.mastermate.cn/mm_api/admission?page=${pageNumber}`, {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0 AdmissionCaseResearchBot/0.1", "x-requested-with": "XMLHttpRequest", "x-csrf-token": token, cookie, "content-type": "application/json" },
    body: JSON.stringify({ words: "", district_id: Number(districtId), rank_id: 0 }), signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Mastermate page ${districtId}/${pageNumber} returned ${response.status}`);
  return response.json();
}

const rows = [];
for (const districtId of targetDistricts) {
  let pageNumber = startPage;
  let pagesRead = 0;
  while (pagesRead < maxPages) {
    const payload = await page(districtId, pageNumber);
    rows.push(...(payload.data || []));
    pagesRead += 1;
    if (!quiet) console.log(JSON.stringify({ districtId, page: pageNumber, rows: payload.data?.length || 0, total: payload.total }));
    if (!payload.next_page_url) break;
    pageNumber += 1;
  }
}

const db = openCaseStore();
const candidates = rows.filter(row => row.enroll === "录取").flatMap(row => {
  const offerYear = Number(String(row.enroll_time || "").match(/20\d{2}/)?.[0]) || null;
  if (!offerYear || offerYear < minOfferYear) return [];
  const programme = resolveProgramme({ universityName: row.university?.name, programmeName: row.major_name, programmeEnglishName: row.major_ename });
  if (!programme) return [];
  if (institutionIds.length && !institutionIds.includes(programme.institutionId)) return [];
  if (focusTags.length && !(programme.focusTags || []).some(tag => focusTags.includes(tag))) return [];
  const parsed = extractMastermateBackground(row.background);
  const sourceUrl = `https://www.mastermate.cn/admission/${row.id}`;
  const base = normalizeCandidate({
    targetUniversity: row.university.name, targetProgramme: row.major_name, targetProgrammeEnglishRaw: row.major_ename,
    offerYear,
    undergraduateUniversity: parsed.institution, undergraduateMajor: parsed.major,
    gpaRaw: parsed.gpaRaw, gpaScale: parsed.gpaScale, gpa100: parsed.gpa100, languageTest: parsed.languageTest, languageScore: parsed.languageScore,
    sourcePublishedAt: row.enroll_time,
    experiences: row.background ? [{ raw: row.background, category: "unknown", result: null }] : [],
    sourceEvidence: { matched: { targetUniversity: true, targetProgramme: true, undergraduateUniversity: Boolean(parsed.institution), undergraduateMajor: Boolean(parsed.major), gpaRaw: Boolean(parsed.gpaRaw), offerYear: Boolean(row.enroll_time) }, missing: [!parsed.institution && "undergraduateUniversity", !parsed.major && "undergraduateMajor", !parsed.gpaRaw && "gpaRaw"].filter(Boolean), indexSource: "mastermate-mm-api-admission" }
  }, sourceUrl);
  base.targetInstitutionId = programme.institutionId;
  base.targetProgrammeId = programme.id;
  const review = applyReviewPolicy(base);
  return [{ ...base, reviewStatus: review.status, issues: review.issues, reviewPolicy: review }];
});
const eligibleCandidates = candidates.filter(candidate => Number(candidate.offerYear) >= minOfferYear);
const inserted = insertCases(db, eligibleCandidates);
for (const candidate of eligibleCandidates) recordCrawlSource(db, { sourceUrl: candidate.sourceUrl, programmeId: candidate.targetProgrammeId, extractedCount: 1, scopedCount: 1, queuedCount: inserted.some(row => row.sourceUrl === candidate.sourceUrl) ? 1 : 0 });
console.log(JSON.stringify({ source: "mastermate", startPage, maxPages: Number.isFinite(maxPages) ? maxPages : null, minOfferYear, nextStartPage: startPage + (Number.isFinite(maxPages) ? maxPages : 0), fetched: rows.length, offers: rows.filter(row => row.enroll === "录取").length, matched: eligibleCandidates.length, programmes: new Set(eligibleCandidates.map(row => row.targetProgrammeId)).size, inserted: inserted.length, byStatus: Object.fromEntries(Object.entries(Object.groupBy(eligibleCandidates, row => row.reviewStatus)).map(([k,v]) => [k,v.length])), database: storeStatus(db) }, null, 2));
db.close();
