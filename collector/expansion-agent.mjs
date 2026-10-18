import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLowCoverageProgrammePlans, loadSources } from "./agent.mjs";
import { caseCoverage, openCaseStore } from "./store.mjs";
import { DEFAULT_APPROVED_TARGET, TARGET_INSTITUTION_IDS } from "./programme-eligibility.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const collectorDataDir = resolve(process.env.ADMISSION_DATA_DIR || resolve(root, "data"));
const agentPath = resolve(root, "agent.mjs");
const mastermateImportPath = resolve(root, "import-mastermate-index.mjs");
const argValue = (name, fallback) => {
  const value = process.argv.find(argument => argument.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  return value == null || value === "" ? fallback : value;
};
const numberArg = (name, fallback) => Math.max(1, Number(argValue(name, fallback)) || fallback);
const limit = numberArg("limit", 5);
const targetApproved = numberArg("target-approved", DEFAULT_APPROVED_TARGET);
const maxPages = numberArg("max-pages", 6);
const maxDetailPages = numberArg("max-detail-pages", Math.max(maxPages, 8));
const maxApiCalls = numberArg("max-api-calls", 3);
const maxErrors = numberArg("max-errors", 3);
const concurrency = numberArg("concurrency", 3);
// Keep the discovery fan-out broad enough to include the high-yield sources
// (HKSg, Compass, Gaotu, EIC and Mastermate) while bounding the number of web
// requests made by one autonomous batch.
const searchSources = numberArg("search-sources", 14);
const searchRequests = numberArg("search-requests", 56);
const childTimeoutMs = Math.max(60_000, numberArg("child-timeout-ms", 900_000));
const mastermatePages = numberArg("mastermate-pages", 3);
const mastermateHistoryPages = numberArg("mastermate-history-pages", 4);
const programmeScope = argValue("programme-scope", "all");
// Targeted programme discovery is the default. Full-site index import is a
// separate backfill job because it otherwise consumes every expansion batch.
const importMastermate = process.argv.includes("--import-mastermate")
  && !process.argv.includes("--skip-mastermate");
const skipMastermate = !importMastermate;
const strictSearchOnly = process.argv.includes("--strict-search-only") || !process.argv.includes("--allow-generic-sources");
const genericSources = !strictSearchOnly;
// The expansion pool is the full 港八新二 taught-master catalogue. A caller can
// narrow it explicitly, but the default must never spill into other schools.
const institutionIds = String(argValue("institutions", ""))
  .split(",").map(value => value.trim()).filter(Boolean);
const effectiveInstitutionIds = institutionIds.length ? institutionIds : TARGET_INSTITUTION_IDS;
const focusTags = String(argValue("focus-tags", ""))
  .split(",").map(value => value.trim()).filter(Boolean);
const programmeIds = String(argValue("programmes", ""))
  .split(",").map(value => value.trim()).filter(Boolean);
// Expansion is a harvesting job, not the human review gate. Keep collecting
// while a few candidates are pending; callers can opt back into the old
// blocking behavior for a review-only run.
const allowPending = process.argv.includes("--stop-on-pending")
  ? (process.argv.includes("--allow-pending") ? "--allow-pending" : null)
  : "--allow-pending";
const skipIndex = process.argv.includes("--skip-index") ? "--skip-index" : null;
const skipSearch = process.argv.includes("--skip-search") ? "--skip-search" : null;
const recheckEmpty = process.argv.includes("--recheck-empty");
const stopAfterApproved = process.argv.includes("--stop-after-approved");
const lockPath = resolve(collectorDataDir, "expansion-agent.lock");
const mastermateCursorPath = resolve(collectorDataDir, "mastermate-agent-cursor.json");
const lockToken = randomUUID();

function terminateChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
  } else {
    child.kill("SIGTERM");
  }
}

async function acquireLock() {
  await mkdir(collectorDataDir, { recursive: true });
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: lockToken, startedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      if (lock.pid && lock.pid !== process.pid) process.kill(lock.pid, 0);
      throw new Error(`已有独立采集 Agent 正在运行（PID ${lock.pid || "unknown"}）`);
    } catch (lockError) {
      if (lockError.code !== "ESRCH" && lockError.code !== "ENOENT") throw lockError;
      await unlink(lockPath).catch(() => {});
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: lockToken, startedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    }
  }
}

async function releaseLock() {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    if (lock.token === lockToken) await unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function runChild(programmeId) {
  return new Promise(resolvePromise => {
    const childStartedAt = new Date().toISOString();
    const child = spawn(process.execPath, [
      agentPath, "run", programmeId,
      `--target-approved=${targetApproved}`,
      `--max-pages=${maxPages}`,
      `--max-detail-pages=${maxDetailPages}`,
      `--max-api-calls=${maxApiCalls}`,
      `--max-errors=${maxErrors}`,
      `--search-sources=${searchSources}`,
      `--search-requests=${searchRequests}`,
      ...(allowPending ? [allowPending] : []),
      ...(genericSources ? ["--allow-generic-sources"] : []),
      ...(skipIndex ? [skipIndex] : []),
      ...(skipSearch ? [skipSearch] : []),
      ...(programmeIds.includes(programmeId) ? ["--force-eligibility"] : []),
      ...(recheckEmpty ? ["--recheck-empty"] : [])
    ], { cwd: process.cwd(), env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => finish({ programmeId, code: null, report: null, error: error.message, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), timedOut: false }));
    child.on("close", code => {
      try {
        finish({ programmeId, code, report: JSON.parse(stdout.trim()), stderr: stderr.trim(), timedOut: false });
      } catch {
        finish({ programmeId, code, report: null, error: code == null ? "child-closed-without-exit-code" : `child-exited-without-json:${code}`, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), timedOut: false });
      }
    });
    const timeout = setTimeout(() => {
      terminateChild(child);
      const db = openCaseStore();
      try {
        db.prepare(`UPDATE agent_runs
          SET state='aborted', stop_reason='parent-timeout', finished_at=?
          WHERE state='running'
            AND json_extract(goal_json, '$.programmeId')=?
            AND started_at >= ?`).run(new Date().toISOString(), programmeId, childStartedAt);
      } finally {
        db.close();
      }
      finish({ programmeId, code: null, report: null, error: "child-timeout", timedOut: true, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
    }, childTimeoutMs);
  });
}

function runMastermateImport(pages = mastermatePages, startPage = 1) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [
      mastermateImportPath,
      `--start-page=${startPage}`,
      `--max-pages=${pages}`,
      "--quiet",
      `--institutions=${effectiveInstitutionIds.join(",")}`,
      ...(focusTags.length ? [`--focus-tags=${focusTags.join(",")}`] : [])
    ], {
      cwd: process.cwd(),
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => finish({ code: null, report: null, error: error.message, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), timedOut: false }));
    child.on("close", code => {
      try {
        finish({ code, report: JSON.parse(stdout.trim()), stderr: stderr.trim(), timedOut: false });
      } catch {
        finish({ code, report: null, error: code == null ? "child-closed-without-exit-code" : `child-exited-without-json:${code}`, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), timedOut: false });
      }
    });
    const timeout = setTimeout(() => {
      terminateChild(child);
      finish({ code: null, report: null, error: "child-timeout", timedOut: true, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
    }, Math.max(childTimeoutMs, 180_000));
  });
}

async function readMastermateCursor() {
  try {
    const cursor = JSON.parse(await readFile(mastermateCursorPath, "utf8"));
    return { nextPage: Math.max(1, Number(cursor.nextPage) || 1), updatedAt: cursor.updatedAt || null };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { nextPage: mastermatePages + 1, updatedAt: null };
  }
}

function readCoverage(programmeId) {
  const db = openCaseStore();
  try {
    return caseCoverage(db, programmeId);
  } finally {
    db.close();
  }
}

function coverageDelta(before, after) {
  const fields = ["total", "approved", "approved2021", "pending", "pending2021", "rejected"];
  return Object.fromEntries(fields.map(field => [field, Number(after?.[field] || 0) - Number(before?.[field] || 0)]));
}

await acquireLock();
try {
  let sourceImport = { skipped: true };
  if (!skipMastermate) {
    const cursorBefore = await readMastermateCursor();
    const latest = await runMastermateImport(mastermatePages, 1);
    const history = latest.code === 0 && latest.report
      ? await runMastermateImport(mastermateHistoryPages, cursorBefore.nextPage)
      : { code: null, report: null, error: "latest-import-failed", timedOut: false };
    const cursorAfter = history.code === 0 && history.report ? {
      nextPage: cursorBefore.nextPage + mastermateHistoryPages,
      updatedAt: new Date().toISOString(),
      previous: cursorBefore.nextPage,
      latestPages: mastermatePages,
      historyPages: mastermateHistoryPages
    } : cursorBefore;
    if (history.code === 0 && history.report) {
      await writeFile(mastermateCursorPath, JSON.stringify(cursorAfter, null, 2), "utf8");
    }
    sourceImport = { cursorBefore, cursorAfter, latest: latest.report || latest, history: history.report || history };
    console.log(JSON.stringify({
      action: "mastermate-incremental-import",
      latest: { startPage: 1, pages: mastermatePages, report: latest.report || { stdout: latest.stdout, stderr: latest.stderr } },
      history: { startPage: cursorBefore.nextPage, pages: mastermateHistoryPages, report: history.report || { stdout: history.stdout, stderr: history.stderr } },
      cursorAfter
    }, null, 2));
  }
  const sources = await loadSources();
  const startedAt = new Date().toISOString();
  const results = [];
  const attempted = new Set();
  let batchStopReason = null;
  async function runProgramme(plan) {
    const result = await runChild(plan.programmeId);
    const after = readCoverage(plan.programmeId);
    const delta = coverageDelta(plan.coverage || {}, after);
    return {
      programmeId: plan.programmeId,
      before: plan.coverage,
      childExitCode: result.code,
      after,
      delta,
      progressed: delta.approved2021 > 0 || delta.total > 0,
      approvedProgressed: delta.approved2021 > 0,
      quality: delta.approved2021 > 0
        ? "new-approved-2021"
        : delta.total > 0
          ? "new-cases-not-approved"
          : delta.rejected > 0
            ? "only-rejected-or-old-cases"
            : "no-database-change",
      timedOut: Boolean(result.timedOut),
      stopReason: result.report?.stopReason || (result.timedOut ? "child-timeout" : null),
      pagesAttempted: result.report?.pagesAttempted || 0,
      errors: result.report?.errors || 0,
      report: result.report || { stdout: result.stdout, stderr: result.stderr }
    };
  }

  while (results.length < limit) {
    const db = openCaseStore();
    let plans;
    try {
      // The planner sorts and slices its result. A small fixed limit makes the
      // carpet sweep terminate after the first page of programmes because all
      // returned plans are added to `attempted`. Read the full eligible pool
      // here, then filter already-tried programmes before selecting the next
      // concurrent batch.
      const plannerLimit = Math.max(2000, attempted.size + concurrency * 4);
      const candidates = buildLowCoverageProgrammePlans({ db, sources, targetApproved, limit: plannerLimit, institutionIds: effectiveInstitutionIds, programmeIds, programmeScope, focusTags })
        .filter(candidate => !attempted.has(candidate.programmeId));
      // A project whose only recent records are already pending cannot produce
      // approved coverage until a human resolves that queue. Keep the carpet
      // sweep moving through projects that can still make automatic progress;
      // fall back to pending projects only after that runnable pool is empty.
      const runnable = candidates.filter(candidate => Number(candidate.coverage?.pending2021 || 0) === 0);
      plans = (runnable.length ? runnable : candidates)
        .slice(0, Math.min(concurrency, limit - results.length));
    } finally {
      db.close();
    }
    if (!plans.length) break;
    plans.forEach(plan => attempted.add(plan.programmeId));
    const batch = await Promise.all(plans.map(runProgramme));
    for (const result of batch) {
      results.push(result);
      console.log(JSON.stringify({ index: results.length, programmeId: result.programmeId, before: result.before, after: result.after, delta: result.delta, progressed: result.progressed, approvedProgressed: result.approvedProgressed, quality: result.quality, timedOut: result.timedOut, stopReason: result.stopReason, pagesAttempted: result.pagesAttempted, errors: result.errors }, null, 2));
    }
    if (stopAfterApproved && batch.some(result => result.approvedProgressed)) {
      batchStopReason = "first-approved";
      break;
    }
  }

  const finishedAt = new Date().toISOString();
  const outputPath = resolve(collectorDataDir, `expansion-agent-${startedAt.slice(0, 10)}-${Date.now()}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ startedAt, finishedAt, targetApproved, programmeScope, limit, concurrency, maxPages, maxDetailPages, maxApiCalls, maxErrors, searchSources, searchRequests, childTimeoutMs, mastermatePages, mastermateHistoryPages, importMastermate, skipMastermate, strictSearchOnly, genericSources, skipIndex: Boolean(skipIndex), skipSearch: Boolean(skipSearch), recheckEmpty, stopAfterApproved, batchStopReason, institutionIds, programmeIds, focusTags, sourceImport, results }, null, 2), "utf8");
  console.log(JSON.stringify({ outputPath, sourceImport: sourceImport.report || sourceImport, projectsAttempted: results.length, progressedProjects: results.filter(result => result.progressed).length, approvedProgressedProjects: results.filter(result => result.approvedProgressed).length, timedOutProjects: results.filter(result => result.timedOut).length, batchStopReason, results: results.map(result => ({ programmeId: result.programmeId, before: result.before, after: result.after, delta: result.delta, progressed: result.progressed, approvedProgressed: result.approvedProgressed, quality: result.quality, timedOut: result.timedOut, stopReason: result.stopReason, pagesAttempted: result.pagesAttempted, errors: result.errors })) }, null, 2));
} finally {
  await releaseLock();
}
