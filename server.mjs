import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { knowledgeStatus } from "./knowledge-base.mjs";
import { buildAnalysisContext, buildProgrammeScreeningContext, buildProgrammeScreeningProjects, ensureProgrammeScreeningRecall, limitProgrammeScreening, mergeProgrammeScreening, normalizeProgrammeScreening, selectAssessmentEvidence } from "./analysis-service.mjs";
import { normalizeAssessment } from "./assessment-contract.mjs";
import { searchInstitutions } from "./collector/reference-store.mjs";
import { completeAnalysisRecord, createAnalysisRecord, listAgentRuns, listAnalysisRecords, listCasesByStatus, listCaseEmbeddings, listMasterData, openCaseStore, getProgrammeScope, getProgrammeStatus, reviewCase, saveAnalysisFeedback, storeStatus, updateCaseFields } from "./collector/store.mjs";
import { triageRows } from "./collector/review-engine.mjs";
import { isCorroboratedReview, normalizeReviewDecision, reviewInput } from "./collector/review-agent.mjs";
import { DEFAULT_APPROVED_TARGET, programmeCollectionEligibility, programmeSearchEvidence } from "./collector/programme-eligibility.mjs";
import { institutionMaster, programmeMaster, resolveInstitution } from "./master-data.mjs";
import { majorMaster } from "./major-master.mjs";
import { buildProfileEmbeddingText, requestEmbeddings, resolveEmbeddingSettings } from "./collector/vector-search.mjs";
import { standardizeGpa } from "./case-analysis.mjs";
import { extractLanguageAssessment, parseModelJson } from "./miniprogram/cloudfunctions/admissionApi/agent/runtime.mjs";

try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const root = process.env.ADMISSION_APP_ROOT || process.cwd();
const desktopToken = process.env.ADMISSION_DESKTOP_TOKEN || "";
const isDesktop = Boolean(desktopToken);
const aiUrl = process.env.AI_API_URL || process.env.COLLECTOR_AI_API_URL;
const aiKey = process.env.AI_API_KEY || process.env.COLLECTOR_AI_API_KEY;
const aiModel = process.env.AI_MODEL || process.env.COLLECTOR_AI_MODEL;
const embeddingSettings = resolveEmbeddingSettings();
const vectorSearchConfigured = embeddingSettings.enabled && Boolean(embeddingSettings.apiUrl && embeddingSettings.apiKey && embeddingSettings.model);
const minimumApprovedCases = Math.max(0, Number(process.env.MIN_APPROVED_CASES || 0));
const assessmentMaxConcurrency = Math.max(1, Number(process.env.ASSESSMENT_MAX_CONCURRENCY || 6));
const screeningTimeoutMs = Math.max(5000, Number(process.env.PROJECT_SCREENING_AI_TIMEOUT_MS || process.env.SCREENING_AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 45000));
const screeningRetries = Math.min(3, Math.max(1, Number(process.env.PROJECT_SCREENING_AI_RETRIES || 2)));
const screeningMaximumCandidates = Math.max(8, Math.min(24, Number(process.env.PROJECT_SCREENING_MAX_CANDIDATES || 16)));
const screeningRecoveryChunkSize = Math.max(4, Math.min(8, Number(process.env.PROJECT_SCREENING_RECOVERY_CHUNK_SIZE || 8)));
const assessmentTimeoutMs = Math.max(1000, Number(process.env.ASSESSMENT_AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 300000));
const assessmentThinking = process.env.ASSESSMENT_AI_THINKING || process.env.AI_THINKING || "disabled";
const assessmentMaxCenterRange = Math.max(0, Number(process.env.ASSESSMENT_MAX_CENTER_RANGE || 10));
const assessmentMinStableEvidence = Math.max(1, Number(process.env.ASSESSMENT_MIN_STABLE_EVIDENCE || 2));
const assessmentCaseEvidenceCap = Math.max(1, Number(process.env.ASSESSMENT_CASE_EVIDENCE_CAP || 6));
const assessmentRequireFullEvidenceConsensus = process.env.ASSESSMENT_REQUIRE_FULL_EVIDENCE_CONSENSUS !== "false";
const assessmentPrompt = readFileSync(join(root, "prompts", "assessment-system.txt"), "utf8").trim();
const screeningPrompt = readFileSync(join(root, "prompts", "project-screening-system.txt"), "utf8").trim();
const reviewPrompt = readFileSync(join(root, "prompts", "review-system.txt"), "utf8").trim();
const reviewDb = openCaseStore();
const adminPassword = String(process.env.ADMIN_PASSWORD || "");
const adminSessionTtlMs = Math.max(15 * 60 * 1000, Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000));
const adminSessions = new Map();
const requestLimits = new Map();
let collectorController = null;
const hksgInstitutionIds = new Set(["cityu-hk", "cuhk", "hku", "hkust", "polyu-hk", "hkbu", "lingnan-hk", "eduhk", "ntu", "nus"]);
const hksgSchoolNames = new Map(institutionMaster
  .filter(institution => hksgInstitutionIds.has(institution.id))
  .map(institution => [institution.id, institution.nameZh || institution.nameEn || institution.id]));

function searchMajors(query, limit = 20) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return [];
  return majorMaster
    .filter(item => [item.code, item.name, item.categoryName, item.className, ...(item.aliases || [])]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle))
    .sort((left, right) => {
      const score = item => {
        const name = item.name.toLocaleLowerCase();
        if (name === needle) return 0;
        if (name.startsWith(needle)) return 1;
        if (name.includes(needle)) return 2;
        if ((item.aliases || []).some(alias => String(alias).toLocaleLowerCase().startsWith(needle))) return 3;
        return 4;
      };
      return score(left) - score(right) || left.name.localeCompare(right.name, 'zh-CN');
    })
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
    .map(item => ({
      code: item.code,
      name: item.name,
      categoryName: item.categoryName,
      className: item.className,
      field: item.field,
      aliases: item.aliases || []
    }));
}
const collectorDirectionLabels = new Map([
  ["ai", "人工智能"], ["automation", "自动化"], ["biomedical", "生物医学"], ["business", "商业/管理"],
  ["chemical", "化学工程"], ["civil", "土木工程"], ["cloud", "云计算"], ["communication", "通信"],
  ["computer", "计算机"], ["control", "控制工程"], ["data", "数据科学"], ["electrical", "电气工程"],
  ["electronic", "电子工程"], ["energy", "能源"], ["environmental", "环境"], ["finance", "金融"],
  ["healthcare", "健康/医疗"], ["instrumentation", "仪器仪表"], ["integrated-circuit", "集成电路"],
  ["iot", "物联网"], ["manufacturing", "智能制造"], ["mechanical", "机械工程"], ["network", "网络"],
  ["optoelectronics", "光电"], ["physics", "物理"], ["power", "电力"], ["railway", "轨道交通"],
  ["robotics", "机器人"], ["semiconductor", "半导体"], ["signal", "信号处理"], ["software", "软件工程"]
]);
const collectorOptions = {
  countries: [...new Set(institutionMaster
    .filter(institution => hksgInstitutionIds.has(institution.id))
    .map(institution => institution.countryRegion)
    .filter(Boolean))]
    .map(id => ({ id, name: id })),
  schools: institutionMaster
    .filter(institution => hksgInstitutionIds.has(institution.id))
    .map(institution => ({
      id: institution.id,
      name: institution.nameZh || institution.nameEn || institution.id,
      nameEn: institution.nameEn || "",
      country: institution.countryRegion || ""
    })),
  programmes: programmeMaster
    .filter(programme => programme.active !== false && hksgInstitutionIds.has(programme.institutionId))
    .map(programme => ({
      id: programme.id,
      name: programme.nameZh || programme.nameEn || programme.id,
      nameEn: programme.nameEn || "",
      institutionId: programme.institutionId,
      school: hksgSchoolNames.get(programme.institutionId) || programme.institutionId,
      schoolEn: institutionMaster.find(institution => institution.id === programme.institutionId)?.nameEn || ""
    })),
  directions: [...new Set(programmeMaster
    .filter(programme => hksgInstitutionIds.has(programme.institutionId))
    .flatMap(programme => programme.focusTags || []))]
    .sort()
    .map(id => ({
      id,
      name: collectorDirectionLabels.get(id) || id,
      programmeCount: programmeMaster.filter(programme => hksgInstitutionIds.has(programme.institutionId)
        && (programme.focusTags || []).includes(id)).length
    }))
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
const publicAssets = new Set([
  "/", "/index.html", "/styles.css", "/favicon.svg", "/robots.txt",
  "/app.mjs", "/comparison.mjs", "/data.mjs", "/case-analysis.mjs", "/display-evidence.mjs", "/major-master.mjs",
  "/admin.html", "/admin.mjs"
]);
const adminAssets = new Set(["/review.html", "/review.mjs", "/review.css", "/analytics.html", "/analytics.mjs", "/analytics.css"]);
const desktopReviewAssets = new Set(["/review.html", "/review.mjs", "/review.css"]);

function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (isProduction) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function requireRateLimit(request, response, scope, maximum, windowMs) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(request)}`;
  const current = requestLimits.get(key);
  const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  entry.count += 1;
  requestLimits.set(key, entry);
  if (entry.count <= maximum) return true;
  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  sendJson(response, 429, { message: "请求过于频繁，请稍后再试", code: "rate-limited" }, { "Retry-After": retryAfter });
  return false;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map(item => item.trim().split("=")).filter(item => item.length >= 2));
}

function isAdminAuthenticated(request) {
  const token = parseCookies(request).admission_admin;
  const expiresAt = token ? adminSessions.get(token) : null;
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(request, response) {
  if (isDesktop) return true;
  if (isAdminAuthenticated(request)) return true;
  sendJson(response, 401, { message: "需要管理员登录", code: "admin-auth-required" });
  return false;
}

function requireAdminPage(request, response, pathname) {
  if (isDesktop && desktopReviewAssets.has(pathname)) return true;
  if (isAdminAuthenticated(request)) return true;
  response.writeHead(302, { Location: `/admin.html?next=${encodeURIComponent(pathname)}` });
  response.end();
  return false;
}

function passwordMatches(candidate) {
  if (!adminPassword || typeof candidate !== "string") return false;
  const expected = Buffer.from(adminPassword);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function adminCookie(token, maxAge) {
  return `admission_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isProduction ? "; Secure" : ""}`;
}

function collectorOutput(line) {
  if (!collectorController) return;
  collectorController.output.push(String(line));
  if (collectorController.output.length > 120) collectorController.output.splice(0, collectorController.output.length - 120);
}

function collectorStatus() {
  const active = Boolean(collectorController?.running);
  return {
    active,
    pid: active ? collectorController.child.pid : null,
    startedAt: collectorController?.startedAt || null,
    finishedAt: collectorController?.finishedAt || null,
    exitCode: collectorController?.exitCode ?? null,
    scope: collectorController?.scope || null,
    output: collectorController?.output || [],
    latestRuns: listAgentRuns(reviewDb, 5)
  };
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function selectedStrings(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).map(item => item.trim()).filter(Boolean))] : [];
}

function startCollector(input = {}) {
  if (collectorController?.running) throw new Error("案例采集 Agent 已经在运行");
  const requestedProgrammes = selectedStrings(input.programmeIds);
  const validProgrammeIds = new Set(collectorOptions.programmes.map(programme => programme.id));
  if (requestedProgrammes.some(id => !validProgrammeIds.has(id))) throw new Error("所选项目不在当前项目目录中，请刷新页面后重选");
  const requestedCountries = requestedProgrammes.length ? [] : selectedStrings(input.countries);
  const requestedInstitutions = requestedProgrammes.length ? [] : selectedStrings(input.institutions).filter(id => hksgInstitutionIds.has(id));
  const requestedDirections = (requestedProgrammes.length ? [] : selectedStrings(input.focusTags || input.directions))
    .filter(id => collectorOptions.directions.some(direction => direction.id === id));
  if (requestedProgrammes.length && input.importMastermate === true) throw new Error("指定具体项目时不能同时导入全站索引");
  const countryInstitutions = new Set(collectorOptions.schools
    .filter(school => !requestedCountries.length || requestedCountries.includes(school.country))
    .map(school => school.id));
  const institutionIds = (requestedInstitutions.length ? requestedInstitutions : [...countryInstitutions])
    .filter(id => countryInstitutions.has(id));
  if ((requestedCountries.length || requestedInstitutions.length) && !institutionIds.length) {
    throw new Error("国家/地区与学校筛选没有交集，请重新选择");
  }
  const args = [
    join(root, "collector", "expansion-agent.mjs"),
    `--limit=${requestedProgrammes.length || boundedNumber(input.limit, 2000, 1, 2000)}`,
    `--concurrency=${boundedNumber(input.concurrency, 3, 1, 6)}`,
    `--target-approved=${boundedNumber(input.targetApproved, DEFAULT_APPROVED_TARGET, 1, 50)}`,
    `--max-pages=${boundedNumber(input.maxPages, 8, 1, 30)}`,
    `--max-detail-pages=${boundedNumber(input.maxDetailPages, 12, 1, 40)}`,
    `--max-api-calls=${boundedNumber(input.maxApiCalls, 3, 1, 10)}`,
    `--max-errors=${boundedNumber(input.maxErrors, 3, 1, 10)}`,
    `--search-sources=${boundedNumber(input.searchSources, 14, 1, 14)}`,
    `--search-requests=${boundedNumber(input.searchRequests, 36, 1, 100)}`
  ];
  if (institutionIds.length && (requestedCountries.length || requestedInstitutions.length)) {
    if (!requestedProgrammes.length) args.push(`--institutions=${institutionIds.join(",")}`);
  }
  if (requestedProgrammes.length) args.push(`--programmes=${requestedProgrammes.join(",")}`);
  else if (requestedDirections.length) args.push(`--focus-tags=${requestedDirections.join(",")}`);
  if (input.importMastermate === true) args.push("--import-mastermate");
  if (input.recheckEmpty === true) args.push("--recheck-empty");
  if (input.stopAfterApproved === true) args.push("--stop-after-approved");
  if (input.stopOnPending !== true) args.push("--allow-pending");
  const child = spawn(process.execPath, args, {
    cwd: isDesktop ? process.cwd() : root,
    env: isDesktop ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  collectorController = {
    child,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    scope: {
      countries: requestedCountries,
      institutions: institutionIds,
      focusTags: requestedDirections,
      programmeIds: requestedProgrammes
    },
    output: []
  };
  child.stdout.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(collectorOutput));
  child.stderr.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => collectorOutput(`[stderr] ${line}`)));
  child.on("error", error => collectorOutput(`[process-error] ${error.message}`));
  child.on("close", code => {
    if (!collectorController || collectorController.child !== child) return;
    collectorController.running = false;
    collectorController.finishedAt = new Date().toISOString();
    collectorController.exitCode = code;
    collectorOutput(`[process-exit] code=${code}`);
  });
  return collectorStatus();
}

function stopCollector() {
  const controller = collectorController;
  if (!controller?.running) return collectorStatus();
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(controller.child.pid), "/t", "/f"], { windowsHide: true });
  } else {
    controller.child.kill("SIGTERM");
  }
  collectorOutput("[process-stop] 已发送停止请求");
  return collectorStatus();
}
export const stopLocalCollector = stopCollector;

let activeAssessmentCalls = 0;
const assessmentWaiters = [];
async function withAssessmentSlot(task) {
  if (activeAssessmentCalls >= assessmentMaxConcurrency) {
    await new Promise(resolve => assessmentWaiters.push(resolve));
  }
  activeAssessmentCalls += 1;
  try {
    return await task();
  } finally {
    activeAssessmentCalls -= 1;
    assessmentWaiters.shift()?.();
  }
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求内容过大");
  }
  return JSON.parse(raw || "{}");
}

function reviewRow(row) {
  return {
    fingerprint: row.fingerprint,
    reviewStatus: row.reviewStatus,
    targetProgrammeId: row.targetProgrammeId,
    targetUniversity: row.targetUniversity,
    targetProgramme: row.targetProgramme,
    targetProgrammeEnRaw: row.targetProgrammeEnRaw,
    offerYear: row.offerYear,
    sourcePublishedAt: row.sourcePublishedAt,
    undergraduateUniversity: row.undergraduateUniversity,
    undergraduateMajor: row.undergraduateMajor,
    gpaRaw: row.gpaRaw,
    gpaScale: row.gpaScale,
    languageTest: row.languageTest,
    languageScore: row.languageScore,
    internships: row.internships,
    research: row.research,
    competitions: row.competitions,
    sourceUrl: row.sourceUrl,
    sourceRefs: row.sourceRefs,
    sourceEvidence: row.sourceEvidence,
    issues: row.issues
  };
}

function getReviewRows(requestUrl) {
  const statuses = new Set((requestUrl.searchParams.get("status") || "needs-review,pending")
    .split(",").map(value => value.trim()).filter(Boolean));
  const limit = Math.min(500, Math.max(1, Number(requestUrl.searchParams.get("limit") || 100)));
  const rows = listCasesByStatus(reviewDb, statuses, Math.min(500, limit * 5));
  return rows
    .filter(row => hksgInstitutionIds.has(resolveInstitution(row.targetUniversity)?.id || row.targetInstitutionId))
    .slice(0, limit)
    .map(reviewRow);
}

function getReviewCoverage() {
  const rows = reviewDb.prepare(`
    SELECT target_programme_id AS programmeId,
      SUM(CASE WHEN review_status = 'approved' AND offer_year >= 2021 THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN review_status = 'needs-review' AND offer_year >= 2021 THEN 1 ELSE 0 END) AS needsReview,
      SUM(CASE WHEN review_status = 'pending' AND offer_year >= 2021 THEN 1 ELSE 0 END) AS pending
    FROM cases
    GROUP BY target_programme_id
  `).all();
  const counts = new Map(rows.map(row => [row.programmeId, row]));
  const target = DEFAULT_APPROVED_TARGET;
  const allProjects = programmeMaster
    .filter(programme => programme.active !== false && hksgInstitutionIds.has(programme.institutionId))
    .map(programme => {
      const row = counts.get(programme.id) || {};
      const approved = Number(row.approved || 0);
      const needsReview = Number(row.needsReview || 0);
      const pending = Number(row.pending || 0);
      const scope = getProgrammeScope(reviewDb, programme.id);
      const status = getProgrammeStatus(reviewDb, programme.id);
      const searchEvidence = programmeSearchEvidence(reviewDb, programme.id);
      const eligibility = programmeCollectionEligibility({
        scope,
        status,
        coverage: { approved2021: approved, pending2021: needsReview + pending },
        searchEvidence,
        targetApproved: target
      });
      return {
        id: programme.id,
        university: hksgSchoolNames.get(programme.institutionId) || programme.institutionId || "",
        name: programme.nameZh || programme.nameEn || "",
        nameEn: programme.nameEn || "",
        institutionId: programme.institutionId,
        approved,
        needsReview,
        pending,
        target,
        gap: eligibility.eligible ? Math.max(0, target - approved) : 0,
        reached: eligibility.eligible && approved >= target,
        eligible: eligibility.eligible,
        scope: scope?.scope || null,
        programmeStatus: status?.status || null,
        statusReason: status?.reason || null,
        exclusion: eligibility.exclusion,
        exclusionReason: eligibility.reason,
        searchEvidence
      };
    });
  const projects = allProjects.filter(project => project.eligible);
  const excludedProjects = allProjects.filter(project => !project.eligible);
  const excludedBy = key => excludedProjects.filter(project => project.exclusion === key);
  return {
    target,
    yearFrom: 2021,
    scope: "港八新二全部有效授课型硕士",
    generatedAt: new Date().toISOString(),
    totalMasterProgrammes: allProjects.length,
    eligibleProjects: projects.length,
    reachedProjects: projects.filter(project => project.reached).length,
    gapProjects: projects.filter(project => !project.reached).length,
    excluded: {
      newProgrammes: excludedBy("new-programme").length,
      noCaseSource: excludedBy("no-case-source").length,
      scopeReview: excludedBy("scope-review").length
    },
    projects,
    excludedProjects
  };
}

async function reviewAction(request, response, pathname) {
  const fingerprint = decodeURIComponent(pathname.slice("/api/review/case/".length));
  const input = await readJson(request);
  const status = String(input.status || "");
  sendJson(response, 200, reviewRow(reviewCase(reviewDb, fingerprint, status, { reviewer: "manual", reason: "review-ui" })));
}

async function editReviewCase(request, response, pathname) {
  const fingerprint = decodeURIComponent(pathname.slice("/api/review/edit/".length));
  const input = await readJson(request);
  sendJson(response, 200, reviewRow(updateCaseFields(reviewDb, fingerprint, input)));
}

async function autoTriage(request, response) {
  const input = await readJson(request);
  const apply = input.apply === true;
  const limit = Math.min(500, Math.max(1, Number(input.limit || 100)));
  {
    const rows = listCasesByStatus(reviewDb, ["pending", "needs-review"], limit);
    const decisions = triageRows(rows);
    const applied = [];
    if (apply) {
      for (const item of decisions) {
        if (item.decision.status !== "approved") continue;
        applied.push(reviewCase(reviewDb, item.row.fingerprint, "approved", { reviewer: "local-rules", decision: item.decision }));
      }
    }
    sendJson(response, 200, {
      dryRun: !apply,
      scanned: decisions.length,
      suggestedApproved: decisions.filter(item => item.decision.status === "approved").length,
      remainingNeedsReview: decisions.filter(item => item.decision.status !== "approved").length,
      applied: applied.map(reviewRow),
      decisions: decisions.map(item => ({ ...reviewRow(item.row), decision: item.decision }))
    });
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60000);
}

async function fetchReviewSource(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("来源网址不是 HTTP(S)");
  const upstream = await fetch(parsed, {
    signal: AbortSignal.timeout(Number(process.env.REVIEW_FETCH_TIMEOUT_MS || 30000)),
    headers: { "User-Agent": "admission-reference-review/1.0" }
  });
  if (!upstream.ok) throw new Error(`来源网页请求失败：HTTP ${upstream.status}`);
  return htmlToText(await upstream.text());
}

async function generateReviewDecision(row, sourceText) {
  if (!aiUrl || !aiKey || !aiModel) throw new Error("审核模型尚未配置");
  const requestBody = {
    model: aiModel,
    temperature: 0,
    messages: [
      { role: "system", content: reviewPrompt },
      { role: "user", content: JSON.stringify(reviewInput(row, sourceText)) }
    ],
    response_format: { type: "json_object" }
  };
  const upstream = await fetch(aiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS || 90000)),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiKey}` },
    body: JSON.stringify(requestBody)
  });
  const payload = await upstream.json();
  if (!upstream.ok) throw new Error(payload?.error?.message || "审核模型调用失败");
  return normalizeReviewDecision(parseModelJson(payload?.choices?.[0]?.message?.content, payload?.choices?.[0]?.finish_reason));
}

async function llmTriage(request, response) {
  const input = await readJson(request);
  const apply = input.apply === true;
  const limit = Math.min(20, Math.max(1, Number(input.limit || 5)));
  {
    const rows = listCasesByStatus(reviewDb, ["pending", "needs-review"], limit);
    const sourceCache = new Map();
    const decisions = [];
    for (const row of rows) {
      try {
        if (!sourceCache.has(row.sourceUrl)) sourceCache.set(row.sourceUrl, fetchReviewSource(row.sourceUrl));
        const sourceText = await sourceCache.get(row.sourceUrl);
        const decision = await generateReviewDecision(row, sourceText);
        decisions.push({ row, decision });
      } catch (error) {
        decisions.push({ row, decision: { decision: "pending", confidence: "low", reason: error.message, evidence: [], issues: [error.message] } });
      }
    }
    const applied = [];
    if (apply) {
      for (const item of decisions) {
        const corroborated = isCorroboratedReview(item.row.sourceEvidence?.reviewAudit, item.decision);
        const nextStatus = corroborated ? item.decision.decision : item.row.reviewStatus;
        const reviewed = reviewCase(reviewDb, item.row.fingerprint, nextStatus, {
          reviewer: "llm", model: aiModel, decision: item.decision
        });
        if (nextStatus !== item.row.reviewStatus) applied.push(reviewed);
      }
    }
    sendJson(response, 200, {
      dryRun: !apply,
      scanned: decisions.length,
      suggestedApproved: decisions.filter(item => item.decision.decision === "approved").length,
      suggestedRejected: decisions.filter(item => item.decision.decision === "rejected").length,
      applied: applied.map(reviewRow),
      decisions: decisions.map(item => ({ ...reviewRow(item.row), decision: item.decision }))
    });
  }
}

function validateProgrammeScreeningResult(value, input) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  const selected = Array.isArray(value?.selectedProgrammeIds) ? value.selectedProgrammeIds.map(String) : [];
  const decisions = value?.programmeDecisions && typeof value.programmeDecisions === "object" ? value.programmeDecisions : {};
  const ids = new Set(projects.map(project => project.id));
  if (selected.length > 8 || selected.some(id => !ids.has(id))) throw new Error("项目筛选结果包含无效候选或超过8个项目");
  if (projects.some(project => !decisions[project.id])) throw new Error("项目筛选结果没有覆盖全部项目");
  for (const id of selected) {
    const decision = decisions[id];
    if (!["include", "uncertain"].includes(String(decision?.decision || "").toLowerCase())) throw new Error("项目筛选结果把非纳入项目放进候选");
    if (String(decision?.directionFit || "").toLowerCase() !== "direct") throw new Error("项目筛选结果包含非直接匹配方向");
  }
  return value;
}

async function generateProgrammeScreeningOnce(input, retries = screeningRetries) {
  if (!aiUrl || !aiKey || !aiModel) {
    return { selectedProgrammeIds: [], programmeDecisions: {}, configured: false };
  }
  const requestBody = {
    model: aiModel,
    temperature: Number.isFinite(Number(process.env.AI_TEMPERATURE)) ? Number(process.env.AI_TEMPERATURE) : 0,
    max_tokens: Math.min(4000, Math.max(2000, Number(process.env.AI_MAX_TOKENS || 4000))),
    messages: [
      { role: "system", content: screeningPrompt },
      { role: "user", content: JSON.stringify(input) }
    ],
    response_format: { type: "json_object" }
  };
  const screeningThinking = process.env.PROJECT_SCREENING_AI_THINKING || "disabled";
  if (["enabled", "disabled"].includes(screeningThinking)) requestBody.thinking = { type: screeningThinking };
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const upstream = await fetch(aiUrl, {
        method: "POST",
        signal: AbortSignal.timeout(screeningTimeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiKey}` },
        body: JSON.stringify(requestBody)
      });
      const payload = await upstream.json();
      if (!upstream.ok) throw new Error(payload?.error?.message || "项目筛选模型调用失败");
      const parsed = validateProgrammeScreeningResult(parseModelJson(payload?.choices?.[0]?.message?.content, payload?.choices?.[0]?.finish_reason), input);
      return { ...parsed, configured: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`项目筛选模型调用失败（${screeningRetries}次）：${lastError?.message || "unknown error"}`);
}

async function generateProgrammeScreening(input) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  if (input?.screeningStage !== "card" || projects.length <= screeningRecoveryChunkSize) {
    return generateProgrammeScreeningOnce(input);
  }
  const chunks = [];
  for (let index = 0; index < projects.length; index += screeningRecoveryChunkSize) {
    chunks.push(projects.slice(index, index + screeningRecoveryChunkSize));
  }
  const settled = await Promise.allSettled(chunks.map(projectChunk => generateProgrammeScreeningOnce({
    ...input,
    screeningStage: "card-chunk",
    projects: projectChunk
  }, screeningRetries)));
  const failures = settled.filter(result => result.status === "rejected");
  if (failures.length) {
    throw new Error(`项目筛选模型分块调用失败：${failures.map(item => item.reason?.message || "unknown error").join("；")}`);
  }
  const chunkResults = settled.map(result => result.value);
  return {
    selectedProgrammeIds: [...new Set(chunkResults.flatMap(result => result.selectedProgrammeIds || []))],
    programmeDecisions: Object.assign({}, ...chunkResults.map(result => result.programmeDecisions || {})),
    configured: true,
    attempts: chunkResults.reduce((sum, result) => sum + Number(result.attempts || 1), 0),
    recovery: "llm-card-chunks",
    chunkCount: chunks.length
  };
}

function fallbackProgrammeScreening(entries, maximum = 8) {
  const candidates = entries
    .filter(entry => entry.retrieval.eligible)
    .sort((a, b) => Number(b.retrieval.majorMatch) - Number(a.retrieval.majorMatch)
      || (b.retrieval.matchedFields?.length || 0) - (a.retrieval.matchedFields?.length || 0)
      || b.retrieval.score - a.retrieval.score
      || a.programme.id.localeCompare(b.programme.id))
    .slice(0, maximum);
  return {
    selectedProgrammeIds: candidates.map(entry => entry.programme.id),
    programmeDecisions: Object.fromEntries(candidates.map(entry => [entry.programme.id, {
      decision: "include",
      directionFit: "direct",
      reason: "模型筛选不可用，按申请地区、方向、本科专业贴合度和课程标签进行本地候选兜底"
    }])),
    configured: false,
    fallback: true
  };
}

async function generateAssessments(input) {
  if (!aiUrl || !aiKey || !aiModel) {
    return { assessments: {}, configured: false };
  }
  const requestBody = {
    model: aiModel,
    temperature: Number.isFinite(Number(process.env.AI_TEMPERATURE)) ? Number(process.env.AI_TEMPERATURE) : 0,
    messages: [
      { role: "system", content: assessmentPrompt },
      { role: "user", content: JSON.stringify(input) }
    ],
    response_format: { type: "json_object" }
  };
  if (["enabled", "disabled"].includes(assessmentThinking)) {
    requestBody.thinking = { type: assessmentThinking };
  }
  return withAssessmentSlot(async () => {
    const upstream = await fetch(aiUrl, {
      method: "POST",
      signal: AbortSignal.timeout(assessmentTimeoutMs),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify(requestBody)
    });
  const payload = await upstream.json();
  if (!upstream.ok) throw new Error(payload?.error?.message || "上游模型调用失败");
    return { ...parseModelJson(payload?.choices?.[0]?.message?.content, payload?.choices?.[0]?.finish_reason), configured: true };
  });
}

async function generateAssessmentsInParallel(input) {
  const comparisonProgrammes = input.programmes.map(programme => ({
    id: programme.id,
    name: programme.name,
    nameEn: programme.nameEn,
    officialRequirements: programme.officialRequirements,
    languageAssessment: programme.languageAssessment,
    positioning: programme.positioning,
    caseDistribution: programme.caseDistribution
  }));
  const settled = await Promise.allSettled(input.programmes.map(programme =>
    generateAssessments({ ...input, programmes: [programme], comparisonProgrammes })
  ));
  const assessments = {};
  const errors = [];
  for (const [index, result] of settled.entries()) {
    const programmeId = input.programmes[index].id;
    if (result.status === "fulfilled" && result.value.assessments?.[programmeId]) {
      assessments[programmeId] = result.value.assessments[programmeId];
    } else {
      errors.push(`${programmeId}:${result.status === "rejected"
        ? result.reason?.message || "项目分析模型调用失败"
        : "模型未返回合法分析结果"}`);
    }
  }
  return { assessments, configured: true, errors };
}

const medianNumber = values => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function aggregateAssessmentCandidates(candidates, programmeId, evidenceOrder) {
  const valid = candidates.filter(value => value && [value.center, value.low, value.high].every(Number.isFinite));
  if (!valid.length) return null;
  const center = Math.round(medianNumber(valid.map(value => value.center)));
  const centerRange = Math.max(...valid.map(value => Number(value.center))) - Math.min(...valid.map(value => Number(value.center)));
  if (centerRange > assessmentMaxCenterRange) return null;
  const low = Math.round(Math.min(center, ...valid.map(value => Number(value.low))));
  const high = Math.round(Math.max(center, ...valid.map(value => Number(value.high))));

  const evidenceCounts = new Map();
  const evidenceById = new Map();
  for (const value of valid) {
    for (const item of Array.isArray(value.evidenceUsed) ? value.evidenceUsed : []) {
      const id = String(item?.documentId || "");
      if (!id) continue;
      evidenceCounts.set(id, (evidenceCounts.get(id) || 0) + 1);
      if (!evidenceById.has(id)) evidenceById.set(id, item);
    }
  }
  // Evidence is accepted only when every completed repeat selected it. A
  // majority vote can hide one divergent call and falsely label the result
  // stable, especially when a retry or timeout reduces the sample size.
  const threshold = valid.length;
  const consensusIds = evidenceOrder.filter(id => (evidenceCounts.get(id) || 0) >= threshold);
  if (consensusIds.length < assessmentMinStableEvidence) return null;
  if (assessmentRequireFullEvidenceConsensus && consensusIds.length !== evidenceOrder.length) return null;
  const evidenceUsed = consensusIds.map(id => evidenceById.get(id)).filter(Boolean);
  const reasoning = [...new Set(valid.flatMap(value => Array.isArray(value.reasoning) ? value.reasoning.map(String) : []))]
    .filter(reason => consensusIds.some(id => reason.includes(`[${id}]`))).slice(0, 8);
  if (!reasoning.length) return null;
  const uncertainties = [...new Set(valid.flatMap(value => Array.isArray(value.uncertainties) ? value.uncertainties.map(String) : []))].sort();
  const representative = [...valid].sort((a, b) => {
    const aDistance = Math.abs(Number(a.center) - center);
    const bDistance = Math.abs(Number(b.center) - center);
    return aDistance - bDistance;
  })[0];
  return {
    ...representative,
    center,
    low,
    high,
    evidenceUsed,
    reasoning,
    uncertainties
  };
}

async function generateRepeatedAssessments(input) {
  const repeatCount = Math.min(5, Math.max(1, Number(process.env.ASSESSMENT_REPEATS || 1)));
  const jobs = Array.from({ length: repeatCount }, () => generateAssessments(input));
  const settled = await Promise.allSettled(jobs);
  const callsCompleted = settled.filter(result => result.status === "fulfilled").length;
  const callsFailed = settled.filter(result => result.status === "rejected").length;
  const candidates = settled
    .filter(result => result.status === "fulfilled")
    .flatMap(result => {
      const programmeId = input.programmes[0]?.id;
      const value = result.value.assessments?.[programmeId];
      return value ? [value] : [];
    });
  const errors = settled.filter(result => result.status === "rejected")
    .map(result => result.reason?.message || "项目分析模型调用失败");
  const programme = input.programmes[0];
  let aggregated = null;
  if (callsCompleted !== repeatCount || candidates.length !== repeatCount) {
    errors.push("重复调用未全部生成合法结果，不能判定稳定");
  } else if (repeatCount === 1) {
    aggregated = candidates[0];
  } else {
    aggregated = aggregateAssessmentCandidates(candidates, programme?.id, programme?.evidenceSelection || []);
    if (!aggregated) errors.push("重复调用未通过数值、标签或证据稳定性门槛");
  }
  return {
    assessments: aggregated && programme?.id ? { [programme.id]: aggregated } : {},
    callsStarted: repeatCount,
    callsCompleted,
    callsFailed,
    errors
  };
}

async function analyze(request, response) {
  let analysisId = null;
  try {
    const input = await readJson(request);
    if (input.consent !== true) throw new Error("请先同意保存申请信息、分析结果和问卷反馈");
    analysisId = randomBytes(16).toString("hex");
    createAnalysisRecord(reviewDb, {
      id: analysisId,
      applicant: {
        profile: input.profile || {},
        profileText: String(input.profileText || ""),
        regions: selectedStrings(input.regions),
        targetSchools: selectedStrings(input.targetSchools),
        fields: selectedStrings(input.fields),
        consentVersion: "2026-08-16"
      }
    });
    if (process.env.ADMISSION_AGENT_MODE === "legacy-two-stage") {
      const { analyzeWithLegacyAgent } = await import("./desktop/legacy-analysis.mjs");
      const body = await analyzeWithLegacyAgent(input);
      completeAnalysisRecord(reviewDb, analysisId, { status: "completed", result: body });
      sendJson(response, 200, { ...body, analysisId });
      return;
    }
    const profileText = String(input.profileText || "");
    const impliedFields = /集成电路|微电子|IC设计|integrated[- ]circuit|microelectronics|semiconductor/i.test(profileText)
      ? ["integrated-circuit"]
      : [];
    const requestedFields = [...new Set([...(input.fields || []), ...impliedFields])];
    const institution = resolveInstitution(input.profile?.university);
    if (institution?.scoreTier != null) input.profile = {
      ...input.profile,
      schoolTier: institution.scoreTier,
      schoolClassification: institution.classification || input.profile?.schoolClassification || null
    };
    input.profile = { ...(input.profile || {}), gpaStandardization: standardizeGpa(input.profile || {}) };
    const modelProfile = { structured: input.profile || {}, narrative: input.profileText || null };
    const screeningContext = buildProgrammeScreeningContext(input, {
      db: reviewDb,
      includeOfficialDocuments: false,
      requestedFields,
      maximumCandidates: screeningMaximumCandidates
    });
    const screeningInput = {
      screeningStage: "card",
      profile: modelProfile,
      requestedRegions: input.regions || [],
      requestedFields,
      projects: buildProgrammeScreeningProjects(screeningContext.retrieved)
    };
    let screeningGenerated = { selectedProgrammeIds: [], programmeDecisions: {}, configured: false };
    let screeningError = "";
    const screeningConfigured = Boolean(aiUrl && aiKey && aiModel);
    if (screeningConfigured && !screeningInput.projects.length) {
      screeningError = "第一层候选项目卡片为空，无法进行模型筛选";
      screeningGenerated = { selectedProgrammeIds: [], programmeDecisions: {}, configured: true, modelFailed: true };
    } else if (screeningInput.projects.length) {
      try {
        screeningGenerated = await generateProgrammeScreening(screeningInput);
      } catch (error) {
        screeningError = error.message || "项目筛选模型调用失败";
      }
    }
    if (screeningConfigured && screeningError) screeningGenerated = { selectedProgrammeIds: [], programmeDecisions: {}, configured: true, modelFailed: true };
    let preliminaryScreening = limitProgrammeScreening(
      { ...normalizeProgrammeScreening(screeningGenerated, screeningContext.retrieved), profileMajor: input.profile?.major },
      screeningContext.retrieved,
      8,
      { targetSchools: input.targetSchools || [] }
    );
    if (!screeningConfigured && (!preliminaryScreening.applied || !preliminaryScreening.selectedProgrammeIds.length)) {
      screeningGenerated = fallbackProgrammeScreening(screeningContext.retrieved);
      preliminaryScreening = limitProgrammeScreening(
        { ...normalizeProgrammeScreening(screeningGenerated, screeningContext.retrieved), profileMajor: input.profile?.major },
        screeningContext.retrieved,
        8,
        { targetSchools: input.targetSchools || [] }
      );
    }
    const uncertainIds = Object.entries(screeningGenerated.programmeDecisions || {})
      .filter(([, value]) => String(value?.decision || value || "").toLowerCase() === "uncertain")
      .map(([id]) => id)
      .filter(id => preliminaryScreening.selectedProgrammeIds.includes(id));
    let fullScreeningGenerated = { selectedProgrammeIds: [], programmeDecisions: {}, configured: false };
    let fullScreeningError = "";
    if (uncertainIds.length && aiUrl && aiKey && aiModel) {
      try {
        const fullScreeningContext = buildProgrammeScreeningContext(input, {
          db: reviewDb,
          includeOfficialDocuments: true,
          requestedFields,
          maximumCandidates: screeningMaximumCandidates
        });
        fullScreeningGenerated = await generateProgrammeScreening({
          screeningStage: "full-review",
          profile: modelProfile,
          requestedRegions: input.regions || [],
          requestedFields,
          projects: buildProgrammeScreeningProjects(fullScreeningContext.retrieved, { fullEvidence: true, programmeIds: uncertainIds })
        });
      } catch (error) {
        fullScreeningError = error.message || "椤圭洰璇︾粏璧勬枡澶嶆牳妯″瀷璋冪敤澶辫触";
      }
    }
    const limitedScreening = limitProgrammeScreening(
      { ...mergeProgrammeScreening(screeningGenerated, fullScreeningGenerated, screeningContext.retrieved), profileMajor: input.profile?.major },
      screeningContext.retrieved,
      8,
      { targetSchools: input.targetSchools || [] }
    );
    const screening = ensureProgrammeScreeningRecall(limitedScreening, screeningContext.retrieved, {
      profileMajor: input.profile?.major,
      requestedFields,
      maximum: 8
    });
    // A configured model failure is a hard stop for the two-stage pipeline.
    // Do not turn the local recall guard into an invisible replacement model.
    const effectiveScreening = screeningConfigured && screeningGenerated.modelFailed
      ? { ...screening, selectedProgrammeIds: [], applied: true, modelFailed: true }
      : screening;
    if (screeningConfigured && screeningGenerated.modelFailed) {
      const error = screeningError || "项目筛选模型调用失败";
      const body = {
        results: [],
        insights: {},
        message: `第一层项目筛选失败：${error}。本次不进入第二层分析，也不使用本地备用筛选。`,
        mode: "screening-failed",
        screening: {
          configured: true,
          applied: true,
          screenedProgrammeCount: screeningContext.retrieved.length,
          cardProjectCount: screeningInput.projects.length,
          fullReviewProjectCount: 0,
          selectedProgrammeIds: [],
          decisions: {},
          recovery: screeningGenerated.recovery || null,
          modelFailed: true,
          error
        },
        assessmentExecution: {
          strategy: "blocked-by-screening-failure",
          repeats: 1,
          maxConcurrency: assessmentMaxConcurrency,
          thinking: assessmentThinking,
          stabilityThresholds: {
            maxCenterRange: assessmentMaxCenterRange,
            minStableEvidence: assessmentMinStableEvidence,
            caseEvidenceCap: assessmentCaseEvidenceCap,
            requireFullEvidenceConsensus: assessmentRequireFullEvidenceConsensus
          },
          requested: 0,
          started: 0,
          completed: 0,
          failed: 0,
          callsStarted: 0,
          callsCompleted: 0,
          callsFailed: 0,
          errors: [error]
        },
        evidencePolicy: { minimumApprovedCases, approvedCaseCount: 0, retrievedDocuments: 0, allApprovedCaseDetails: false },
        retrieval: []
      };
      completeAnalysisRecord(reviewDb, analysisId, { status: "completed", result: body });
      sendJson(response, 200, { ...body, analysisId });
      return;
    }
    let queryEmbedding = null;
    let vectorSearchError = null;
    const indexedVectorCount = vectorSearchConfigured ? listCaseEmbeddings(reviewDb).length : 0;
    if (vectorSearchConfigured && indexedVectorCount > 0) {
      try {
        queryEmbedding = (await requestEmbeddings([
          buildProfileEmbeddingText(input.profile || {}, input.profileText, { regions: input.regions, fields: requestedFields })
        ], embeddingSettings))[0];
      } catch (error) {
        vectorSearchError = error.message || "申请人向量生成失败";
      }
    }
    const { retrieved, comparisons, retrievalById } = buildAnalysisContext(input, {
      programmeIds: effectiveScreening.selectedProgrammeIds,
      restrictToProgrammeIds: effectiveScreening.applied,
      includeIneligible: true,
      queryEmbedding,
      vectorSearchConfigured,
      db: reviewDb
    });
    const assessableComparisons = comparisons.filter(({ programme }) => programme.cases.length >= minimumApprovedCases);
    const assessmentEvidenceByProgramme = Object.fromEntries(assessableComparisons.map(({ programme, result }) => {
      const allDocuments = retrievalById[programme.id]?.documents || [];
      const orderedDocuments = selectAssessmentEvidence({ documents: allDocuments }, result);
      const officialDocuments = orderedDocuments.filter(document => document.provenance !== "public-case");
      const caseDocuments = orderedDocuments.filter(document => document.provenance === "public-case");
      return [programme.id, {
        allDocuments,
        evidenceSelection: [...officialDocuments, ...caseDocuments.slice(0, assessmentCaseEvidenceCap)]
      }];
    }));
    const modelInput = {
      profile: modelProfile,
      evidencePolicy: {
        minimumApprovedCases,
        successCasesOnly: true,
        allApprovedCaseDetails: false,
        lowCaseAllowed: true,
        instruction: "全部 approved 案例已经由本地程序汇总进 caseDistribution；只阅读固定代表案例正文。公开成功案例不能解释为真实录取率。案例不足不阻断判断，必须回到官方项目资料和申请人背景独立分析，并扩大不确定区间。"
      },
      programmes: assessableComparisons.map(({ programme, result }) => ({
        id: programme.id,
        name: `${programme.university} ${programme.nameZh}`,
        nameEn: programme.nameEn,
        officialCode: programme.officialCode,
        officialUrl: programme.officialUrl,
        officialRequirements: programme.officialNote,
        languageAssessment: extractLanguageAssessment(programme, input.profile?.structured || input.profile || {},
          assessmentEvidenceByProgramme[programme.id].allDocuments),
        positioning: programme.overview,
        curriculum: programme.courseOrientation,
        retrievedEvidence: assessmentEvidenceByProgramme[programme.id].evidenceSelection,
        evidenceSelection: assessmentEvidenceByProgramme[programme.id].evidenceSelection.map(document => document.id),
        caseDistribution: result.evidence
      }))
    };
    let generated = { assessments: {}, configured: Boolean(aiUrl && aiKey && aiModel), skipped: !modelInput.programmes.length };
    let modelError = "";
    const assessmentExecution = {
      strategy: "parallel-per-programme-with-shared-comparison",
      repeats: 1,
      maxConcurrency: assessmentMaxConcurrency,
      thinking: assessmentThinking,
      stabilityThresholds: {
        maxCenterRange: assessmentMaxCenterRange,
        minStableEvidence: assessmentMinStableEvidence,
        caseEvidenceCap: assessmentCaseEvidenceCap,
        requireFullEvidenceConsensus: assessmentRequireFullEvidenceConsensus
      },
      requested: modelInput.programmes.length,
      started: 0,
      completed: 0,
      failed: 0,
      callsStarted: 0,
      callsCompleted: 0,
      callsFailed: 0,
      errors: []
    };
    if (modelInput.programmes.length) {
      if (aiUrl && aiKey && aiModel) {
        assessmentExecution.started = modelInput.programmes.length;
        assessmentExecution.callsStarted = modelInput.programmes.length;
        try {
          generated = await generateAssessmentsInParallel(modelInput);
          assessmentExecution.callsCompleted = assessmentExecution.callsStarted - (generated.errors?.length || 0);
          assessmentExecution.completed = modelInput.programmes.filter(programme => generated.assessments?.[programme.id]).length;
          assessmentExecution.failed = modelInput.programmes.length - assessmentExecution.completed;
          assessmentExecution.errors.push(...(generated.errors || []));
        } catch (error) {
          assessmentExecution.callsFailed = modelInput.programmes.length;
          assessmentExecution.failed = modelInput.programmes.length;
          assessmentExecution.errors.push(error.message || "项目分析模型调用失败");
          generated = { assessments: {}, configured: true, skipped: false };
        }
        modelError = assessmentExecution.errors.join("；");
      }
    }
    const assessments = Object.fromEntries(Object.entries(generated.assessments || {})
      .map(([programmeId, value]) => {
        const evidenceSelection = assessmentEvidenceByProgramme[programmeId]?.evidenceSelection || [];
        const evidenceOrder = evidenceSelection.map(document => document.id);
        const allowedIds = new Set(evidenceOrder);
        const comparison = comparisons.find(item => item.programme.id === programmeId)?.result;
        return [programmeId, normalizeAssessment(value, allowedIds, comparison, evidenceOrder)];
      })
      .filter(([, value]) => value));
    const results = comparisons.map(({ programme, result }) => ({
      programme,
      result: { ...result, ...(assessments[programme.id] || {}) }
    })).sort((a, b) => {
      if (a.result.assessmentAvailable !== b.result.assessmentAvailable) return a.result.assessmentAvailable ? -1 : 1;
      return (b.result.center ?? 0) - (a.result.center ?? 0);
    });
    const insights = Object.fromEntries(Object.entries(assessments).map(([programmeId, value]) => [programmeId, {
      fit: value.fit, psCv: value.psCv, reasoning: value.reasoning,
      evidenceUsed: value.evidenceUsed, uncertainties: value.uncertainties
    }]));
    const retrievedDocuments = retrieved.reduce((total, entry) => total + entry.documents.length, 0);
    const approvedCaseCount = comparisons.reduce((sum, item) => sum + item.programme.cases.length, 0);
    const noAssessmentReason = minimumApprovedCases > 0
      ? `尚无项目达到至少${minimumApprovedCases}条审核案例的分析门槛`
      : "模型未返回满足证据格式要求的项目判断";
    const message = assessments && Object.keys(assessments).length
      ? `已完成项目筛选，保留${retrieved.length}个候选项目，读取${approvedCaseCount}条审核案例，并由第二层AI生成有证据边界的参考判断。`
      : `已完成项目筛选，保留${retrieved.length}个候选项目，读取${approvedCaseCount}条审核案例；${screeningError || modelError || noAssessmentReason}，因此不生成概率。`;
    const body = {
      results,
      insights,
      message,
      mode: Object.keys(assessments).length ? "two-stage-rag-ai-assessment" : "evidence-only",
      screening: {
        configured: screening.configured,
        applied: effectiveScreening.applied,
        screenedProgrammeCount: screeningContext.retrieved.length,
        cardProjectCount: screeningInput.projects.length,
        fullReviewProjectCount: uncertainIds.length,
        selectedProgrammeIds: effectiveScreening.selectedProgrammeIds,
        decisions: effectiveScreening.decisions,
        recovery: screeningGenerated.recovery || null,
        modelFailed: Boolean(screeningGenerated.modelFailed),
        error: screeningError || fullScreeningError || null
      },
      assessmentExecution,
        evidencePolicy: {
          minimumApprovedCases,
          approvedCaseCount,
          retrievedDocuments,
          allApprovedCaseDetails: false,
          vectorSearch: { configured: vectorSearchConfigured, indexAvailable: indexedVectorCount > 0, indexedCaseCount: indexedVectorCount, queryEmbedded: Boolean(queryEmbedding), error: vectorSearchError }
        },
        retrieval: retrieved.map(entry => ({
          programmeId: entry.programme.id,
          score: entry.retrieval.score,
          matchedFields: entry.retrieval.matchedFields,
          vectorSearch: entry.retrieval.vectorSearch,
          indexedCaseCount: entry.retrieval.indexedCaseCount,
          documentIds: entry.documents.map(document => document.id)
        }))
    };
    completeAnalysisRecord(reviewDb, analysisId, { status: "completed", result: body });
    sendJson(response, 200, { ...body, analysisId });
  } catch (error) {
    if (analysisId) completeAnalysisRecord(reviewDb, analysisId, { status: "failed", error: error.message || "分析请求失败" });
    sendJson(response, 400, { message: error.message || "分析请求失败", analysisId });
  }
}

async function submitFeedback(request, response) {
  const input = await readJson(request);
  const analysisId = String(input.analysisId || "");
  const usefulness = String(input.usefulness || "");
  const valuable = String(input.valuable || "");
  const clarity = String(input.clarity || "");
  if (!/^[a-f0-9]{32}$/.test(analysisId)
    || !["very", "some", "none"].includes(usefulness)
    || !["boundaries", "probability", "cases", "programme", "gaps"].includes(valuable)
    || !["clear", "average", "unclear"].includes(clarity)) {
    sendJson(response, 400, { message: "问卷内容不完整或分析记录无效" });
    return;
  }
  const saved = saveAnalysisFeedback(reviewDb, analysisId, {
    usefulness,
    valuable,
    clarity,
    comment: String(input.comment || "").trim().slice(0, 2000)
  });
  sendJson(response, saved ? 201 : 404, saved
    ? { saved: true, analysisId }
    : { message: "找不到对应的分析记录" });
}

export function clearLocalAnalysisData() {
  if (!desktopToken) throw new Error("仅桌面程序允许删除本机申请记录。");
  reviewDb.exec("PRAGMA secure_delete = ON");
  reviewDb.exec("BEGIN IMMEDIATE");
  try {
    reviewDb.exec("DELETE FROM analysis_feedback; DELETE FROM analysis_records;");
    reviewDb.exec("COMMIT");
  } catch (error) {
    reviewDb.exec("ROLLBACK");
    throw error;
  }
}

export function closeLocalDataStore() {
  reviewDb.close();
}

export const httpServer = createServer(async (request, response) => {
  applySecurityHeaders(response);
  if (desktopToken && request.headers["x-admission-desktop-token"] !== desktopToken) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Desktop access only");
    return;
  }
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  if (desktopToken && (pathname.startsWith("/api/admin/") || pathname === "/admin.html" || pathname === "/admin.mjs"
    || (adminAssets.has(pathname) && !desktopReviewAssets.has(pathname)))) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/admin/session") {
    sendJson(response, 200, { authenticated: isAdminAuthenticated(request), passwordConfigured: Boolean(adminPassword) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/login") {
    if (!requireRateLimit(request, response, "admin-login", Math.max(3, Number(process.env.ADMIN_LOGIN_LIMIT_PER_15_MIN || 10)), 15 * 60 * 1000)) return;
    const input = await readJson(request);
    if (!adminPassword) {
      sendJson(response, 503, { message: "管理员密码尚未配置，请在 .env 设置 ADMIN_PASSWORD 后重启服务" });
      return;
    }
    if (!passwordMatches(String(input.password || ""))) {
      sendJson(response, 401, { message: "管理员密码错误" });
      return;
    }
    const now = Date.now();
    for (const [token, expiresAt] of adminSessions.entries()) if (expiresAt <= now) adminSessions.delete(token);
    const token = randomBytes(32).toString("hex");
    adminSessions.set(token, now + adminSessionTtlMs);
    sendJson(response, 200, { authenticated: true }, { "Set-Cookie": adminCookie(token, Math.floor(adminSessionTtlMs / 1000)) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = parseCookies(request).admission_admin;
    if (token) adminSessions.delete(token);
    sendJson(response, 200, { authenticated: false }, { "Set-Cookie": adminCookie("", 0) });
    return;
  }
  if ((pathname.startsWith("/api/review/") || pathname.startsWith("/api/collector/") || pathname === "/api/admin/analysis-records") && !requireAdmin(request, response)) return;
  if (request.method === "GET" && pathname === "/api/admin/analysis-records") {
    const records = listAnalysisRecords(reviewDb, requestUrl.searchParams.get("limit") || 100);
    sendJson(response, 200, { count: records.length, records });
    return;
  }
  if (request.method === "GET" && pathname === "/api/collector/status") {
    sendJson(response, 200, { ...collectorStatus(), desktop: isDesktop });
    return;
  }
  if (request.method === "GET" && pathname === "/api/collector/options") {
    sendJson(response, 200, collectorOptions);
    return;
  }
  if (request.method === "POST" && pathname === "/api/collector/start") {
    try {
      sendJson(response, 202, startCollector(await readJson(request)));
    } catch (error) {
      sendJson(response, 409, { message: error.message || "无法启动案例采集 Agent" });
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/collector/stop") {
    sendJson(response, 200, stopCollector());
    return;
  }
  if (request.method === "GET" && pathname === "/api/review/summary") {
    sendJson(response, 200, storeStatus(reviewDb));
    return;
  }
  if (request.method === "GET" && pathname === "/api/review/coverage") {
    sendJson(response, 200, getReviewCoverage());
    return;
  }
  if (request.method === "GET" && pathname === "/api/review/cases") {
    sendJson(response, 200, { cases: getReviewRows(requestUrl) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/review/programmes") {
    sendJson(response, 200, { programmes: listMasterData(reviewDb).programmes });
    return;
  }
  if (request.method === "POST" && pathname === "/api/review/auto-triage") {
    await autoTriage(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/review/llm-triage") {
    await llmTriage(request, response);
    return;
  }
  if (request.method === "POST" && pathname.startsWith("/api/review/case/")) {
    await reviewAction(request, response, pathname);
    return;
  }
  if (request.method === "POST" && pathname.startsWith("/api/review/edit/")) {
    await editReviewCase(request, response, pathname);
    return;
  }
  if (request.method === "POST" && pathname === "/api/analyze") {
    if (!requireRateLimit(request, response, "analyze", Math.max(1, Number(process.env.ANALYZE_LIMIT_PER_HOUR || 20)), 60 * 60 * 1000)) return;
    await analyze(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/feedback") {
    if (!requireRateLimit(request, response, "feedback", 30, 60 * 60 * 1000)) return;
    await submitFeedback(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/api/knowledge/status") {
    sendJson(response, 200, knowledgeStatus({ vectorSearchConfigured }));
    return;
  }
  if (request.method === "GET" && pathname === "/api/institutions/search") {
    const query = requestUrl.searchParams.get("q") || "";
    sendJson(response, 200, { query, results: searchInstitutions(query, 8) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/majors/search") {
    const query = requestUrl.searchParams.get("q") || "";
    sendJson(response, 200, { query, results: searchMajors(query, 20) });
    return;
  }
  if (!["GET", "HEAD"].includes(request.method) || (!publicAssets.has(pathname) && !adminAssets.has(pathname))) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (adminAssets.has(pathname) && !requireAdminPage(request, response, pathname)) return;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(root, relative));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
});

httpServer.listen(port, host, () => {
  console.log(`录取参照 running at http://${host}:${port}`);
});
