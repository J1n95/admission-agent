import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assessBatchQuality, collectUrl, loadSources, mergeProgrammeJobs } from "./agent.mjs";
import { openCaseStore, storeStatus } from "./store.mjs";

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const manifest = resolve(process.argv[2] || "collector/batches/pilot-20-2026-08-11.txt");
const limitFlag = process.argv.find(argument => argument.startsWith("--limit="));
const limit = Math.max(1, Number(limitFlag?.split("=")[1] || 20));
const dryRun = process.argv.includes("--dry-run");
const forceRefresh = process.argv.includes("--force-refresh");
const delayMs = Number(process.env.CRAWL_DELAY_MS || 2500);

function databaseStatus() {
  const db = openCaseStore();
  try { return storeStatus(db); } finally { db.close(); }
}

function addUsage(target, usage) {
  for (const [stage, row] of Object.entries(usage || {})) {
    if (!row) continue;
    target[stage] ||= { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    target[stage].promptTokens += Number(row.prompt_tokens || 0);
    target[stage].completionTokens += Number(row.completion_tokens || 0);
    target[stage].totalTokens += Number(row.total_tokens || 0);
  }
}

const sources = await loadSources();
const requestedJobs = (await readFile(manifest, "utf8"))
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [url, programmeId] = line.split(/\t+/).map(value => value.trim());
    return { url, programmeId: programmeId || null };
  })
  .slice(0, limit);
const jobs = mergeProgrammeJobs(requestedJobs);
const urls = jobs.map(job => job.url);
const report = {
  id: randomUUID(), manifest, dryRun, forceRefresh, startedAt: new Date().toISOString(), finishedAt: null,
  databaseBefore: databaseStatus(), databaseAfter: null, usage: {}, pages: []
};
const approvedBefore = report.databaseBefore.approved || 0;

for (const [index, url] of urls.entries()) {
  const startedAt = new Date();
  try {
    const result = await collectUrl(url, sources, {
      dryRun,
      forceRefresh,
      programmeId: jobs[index].programmeId || undefined,
      programmeIds: jobs[index].requestedProgrammeIds
    });
    addUsage(report.usage, result.usage);
    report.pages.push({
      index: index + 1,
      url,
      programmeId: jobs[index].programmeId,
      requestedProgrammeIds: jobs[index].requestedProgrammeIds,
      status: "completed",
      durationMs: Date.now() - startedAt.getTime(),
      extracted: result.extracted,
      extractedCandidates: (result.extractedCandidates || []).map(candidate => ({
        fingerprint: candidate.fingerprint,
        targetProgrammeId: candidate.targetProgrammeId,
        targetUniversity: candidate.targetUniversity,
        targetProgramme: candidate.targetProgramme,
        targetProgrammeEnglishRaw: candidate.targetProgrammeEnglishRaw,
        offerYear: candidate.offerYear,
        undergraduateUniversity: candidate.undergraduateUniversity,
        gpaRaw: candidate.gpaRaw,
        languageTest: candidate.languageTest,
        languageScore: candidate.languageScore,
        reviewStatus: candidate.reviewStatus,
        issues: candidate.issues,
        sourceMatched: candidate.sourceEvidence?.matched || {},
        sourceMissing: candidate.sourceEvidence?.missing || []
      })),
      queued: result.queued,
      duplicates: result.duplicates,
      scoped: result.scoped,
      preservedUnmatched: result.preservedUnmatched || 0,
      skipped: result.skipped,
      skipReason: result.skipReason,
      modelCalled: result.modelCalled,
      extractionMethod: result.extractionMethod || null,
      prefilter: result.prefilter,
      ocr: result.ocr,
      criticalVerification: result.criticalVerification,
      usage: result.usage,
      candidates: (result.candidates || []).map(candidate => ({
        fingerprint: candidate.fingerprint,
        targetProgrammeId: candidate.targetProgrammeId,
        targetUniversity: candidate.targetUniversity,
        targetProgramme: candidate.targetProgramme,
        offerYear: candidate.offerYear,
        undergraduateUniversity: candidate.undergraduateUniversity,
        undergraduateMajor: candidate.undergraduateMajor,
        gpaRaw: candidate.gpaRaw,
        languageTest: candidate.languageTest,
        languageScore: candidate.languageScore,
        reviewStatus: candidate.reviewStatus,
        issues: candidate.issues,
        sourceMatched: candidate.sourceEvidence?.matched || {},
        sourceMissing: candidate.sourceEvidence?.missing || [],
        criticalStatus: candidate.sourceEvidence?.criticalVerification?.status || null
      }))
    });
  } catch (error) {
    report.pages.push({ index: index + 1, url, status: "failed", durationMs: Date.now() - startedAt.getTime(), error: error.message });
  }
  const latest = report.pages.at(-1);
  console.log(`[${index + 1}/${urls.length}] ${latest.status} ${url} (${latest.durationMs} ms)`);
  if (index < urls.length - 1) await sleep(delayMs);
}

report.finishedAt = new Date().toISOString();
report.databaseAfter = databaseStatus();
report.summary = {
  attemptedPages: report.pages.length,
  completedPages: report.pages.filter(page => page.status === "completed").length,
  failedPages: report.pages.filter(page => page.status === "failed").length,
  extractedCases: report.pages.reduce((sum, page) => sum + Number(page.extracted || 0), 0),
  queuedCases: report.pages.reduce((sum, page) => sum + Number(page.queued || 0), 0),
  skippedPages: report.pages.filter(page => page.skipped).length,
  modelCalls: report.pages.filter(page => page.modelCalled).length,
  elapsedSeconds: Math.round((new Date(report.finishedAt) - new Date(report.startedAt)) / 1000),
  approvedAdded: Math.max(0, Number(report.databaseAfter.approved || 0) - approvedBefore)
};
report.summary.tokensPerApproved = report.summary.approvedAdded
  ? Math.round(Object.values(report.usage).reduce((sum, usage) => sum + Number(usage?.totalTokens || 0), 0) / report.summary.approvedAdded)
  : null;
report.quality = assessBatchQuality(report);
const reportPath = resolve("collector/data", `pilot-report-${report.id}.json`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ reportPath, ...report.summary, quality: report.quality, databaseBefore: report.databaseBefore, databaseAfter: report.databaseAfter, usage: report.usage }, null, 2));
