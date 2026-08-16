// ponytail: two broad no-progress runs are enough to stop spending time on a
// project; loosen this only if a source is known to publish cases irregularly.
const MIN_NO_PROGRESS_RUNS = 2;
const MIN_SEARCHED_SOURCE_PAGES = 12;
const MIN_SEARCHED_SOURCE_HOSTS = 3;

export const TARGET_INSTITUTION_IDS = [
  "cityu-hk", "cuhk", "hku", "hkust", "polyu-hk", "hkbu", "lingnan-hk", "eduhk", "ntu", "nus"
];
export const DEFAULT_APPROVED_TARGET = 10;

function reportMadeApprovedProgress(report) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  return steps
    .filter(step => step.action === "extract-validate-store")
    .some(step => Number(step.detail?.approved2021 || 0) > 0);
}

function reportHasNoApprovedProgress(report) {
  if (!report || Number(report.errors || 0) !== 0 || reportMadeApprovedProgress(report)) return false;
  return Number(report.pagesAttempted || 0) > 0 || report.stopReason === "sources-exhausted";
}

export function recentNoProgressRunCount(db, programmeId) {
  try {
    const rows = db.prepare(`SELECT report_json
      FROM agent_runs
      WHERE json_extract(goal_json, '$.programmeId')=?
      ORDER BY started_at DESC
      LIMIT ?`).all(programmeId, MIN_NO_PROGRESS_RUNS);
    let count = 0;
    for (const row of rows) {
      let report;
      try { report = JSON.parse(row.report_json || "null"); } catch { report = null; }
      if (!reportHasNoApprovedProgress(report)) break;
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

export function programmeSearchEvidence(db, programmeId) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT source_url, status, scoped_count
      FROM crawl_source_scopes WHERE programme_id=?`).all(programmeId);
  } catch {
    rows = [];
  }
  const hosts = new Set();
  for (const row of rows) {
    try { hosts.add(new URL(row.source_url).hostname.toLowerCase()); } catch {}
  }
  const consecutiveNoProgressRuns = recentNoProgressRunCount(db, programmeId);
  return {
    searchedSourcePages: rows.length,
    searchedSourceHosts: hosts.size,
    sourceHosts: [...hosts].sort(),
    positiveSourcePages: rows.filter(row => Number(row.scoped_count || 0) > 0).length,
    consecutiveNoProgressRuns,
    thresholds: {
      noProgressRuns: MIN_NO_PROGRESS_RUNS,
      sourcePages: MIN_SEARCHED_SOURCE_PAGES,
      sourceHosts: MIN_SEARCHED_SOURCE_HOSTS
    }
  };
}

export function programmeCollectionEligibility({ scope = null, status = null, coverage = null, searchEvidence = null, targetApproved = DEFAULT_APPROVED_TARGET } = {}) {
  const scopeValue = scope?.scope || null;
  const statusValue = status?.status || null;
  if (["catalog-only", "needs-review"].includes(scopeValue)) {
    return { eligible: false, exclusion: "scope-review", reason: scope?.reason || scopeValue };
  }
  if (statusValue === "confirmed-new") {
    return { eligible: false, exclusion: "new-programme", reason: status?.reason || "官方确认新项目" };
  }
  const evidence = searchEvidence || {};
  const approved = Number(coverage?.approved2021 ?? coverage?.approved ?? 0);
  const pending = Number(coverage?.pending2021 ?? coverage?.pending ?? 0);
  const unfindable = approved < targetApproved
    && pending === 0
    && Number(evidence.consecutiveNoProgressRuns || 0) >= MIN_NO_PROGRESS_RUNS
    && Number(evidence.searchedSourcePages || 0) >= MIN_SEARCHED_SOURCE_PAGES
    && Number(evidence.searchedSourceHosts || 0) >= MIN_SEARCHED_SOURCE_HOSTS;
  if (unfindable) {
    return {
      eligible: false,
      exclusion: "no-case-source",
      reason: "最近连续两轮未新增2021+ approved，且已检查至少12个页面、3个来源站",
      searchEvidence: evidence
    };
  }
  return { eligible: true, exclusion: null, reason: null, searchEvidence: evidence };
}
