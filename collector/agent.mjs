import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { institutionMaster, normalizeMasterName, programmeMaster, resolveInstitution, resolveProgramme, undergraduateInstitutionEvidence } from "../master-data.mjs";
import { resolveReferenceInstitution } from "./reference-store.mjs";
import { applyReviewPolicy } from "./review-engine.mjs";
import {
  appendAgentStep, caseCoverage, defaultDbPath, finishAgentRun, getCase, getCrawlSource, getCrawlSourceScope, getExtractionCache, getOcrCache,
  getProgrammeScope, getProgrammeStatus, insertCases, listAgentRuns, listCases, listMasterData, listProgrammeDocuments, listProgrammeScopes, listProgrammeStatuses,
  openCaseStore, recordCrawlSource, reassignCaseProgramme, reviewCase, saveExtractionCache, saveOcrCache, saveProgrammeScope, saveProgrammeStatus,
  startAgentRun, storeStatus
} from "./store.mjs";
import { DEFAULT_APPROVED_TARGET, programmeCollectionEligibility, programmeSearchEvidence, recentNoProgressRunCount as eligibilityRecentNoProgressRunCount, TARGET_INSTITUTION_IDS } from "./programme-eligibility.mjs";
import { classifyExperienceRecords } from "./experience-classifier.mjs";

const collectorRoot = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(collectorRoot, "..", ".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const defaultConfigPath = resolve(collectorRoot, "sources.json");
const defaultExtractionPromptPath = resolve(collectorRoot, "prompts", "extraction-system.txt");
const searchPlannerCachePath = resolve(collectorRoot, "data", "search-plans.json");
const compassIndexCachePath = resolve(collectorRoot, "data", "compass-index.json");
const programmeStatusOverridesPath = resolve(collectorRoot, "data", "programme-status-overrides.json");
const defaultRawLogPath = resolve(collectorRoot, "data", "raw-cases.jsonl");
const delayMs = Number(process.env.CRAWL_DELAY_MS || 2500);
const userAgent = process.env.CRAWLER_USER_AGENT || "AdmissionCaseResearchBot/0.1";
const httpTimeoutMs = Math.max(1000, Number(process.env.COLLECTOR_HTTP_TIMEOUT_MS || 8000));
const discoveryTimeoutMs = Math.max(5000, Number(process.env.COLLECTOR_DISCOVERY_TIMEOUT_MS || 60000));
const targetInstitutionIds = TARGET_INSTITUTION_IDS;
const programmeStatusesThatBlockCollection = new Set(["confirmed-new", "out-of-scope"]);
const programmeScopesThatBlockCollection = new Set(["catalog-only", "needs-review"]);
const robotsDecisionCache = new Map();
const officialPageCache = new Map();
const programmeStatusOverrides = (() => {
  try { return JSON.parse(readFileSync(programmeStatusOverridesPath, "utf8")); } catch { return {}; }
})();

const taughtMasterNamePattern = /(?:\bmsc\b|m\.sc\.?|master\s+of\s+science|\bma\b|master\s+of\s+arts|\bmeng\b|master\s+of\s+engineering|master\s+in\b|master\s+of\b|\bmba\b|\bllm\b|juris\s+doctor)/i;
const catalogOnlyNamePattern = /(?:executive|\bemba\b|graduate\s+diploma|postgraduate\s+diploma|\bpgd\b|\bpgdip\b|certificate|mainland\s+class|offered\s+in\s+shanghai)/i;
const needsReviewNamePattern = /(?:master\s+of\s+research|\bmres\b)/i;
const officialTaughtPagePattern = /(?:polyu\.edu\.hk\/study\/pg\/tpg\/|prog-crs\.hkust\.edu\.hk\/pgprog\/)/i;

export function classifyProgrammeScope(programme) {
  const name = `${programme?.nameEn || ""} ${programme?.nameZh || ""}`.replace(/\s+/g, " ").trim();
  const signals = {
    institutionId: programme?.institutionId || null,
    taughtMasterName: taughtMasterNamePattern.test(name),
    catalogOnlyName: catalogOnlyNamePattern.test(name),
    needsReviewName: needsReviewNamePattern.test(name),
    officialTaughtPage: officialTaughtPagePattern.test(programme?.officialUrl || ""),
    name
  };
  if (!targetInstitutionIds.includes(programme?.institutionId)) {
    return { programmeId: programme?.id || null, scope: "catalog-only", confidence: 0.99, reason: "outside-target-institution", signals };
  }
  if (signals.catalogOnlyName) {
    return { programmeId: programme.id, scope: "catalog-only", confidence: 0.97, reason: "executive-diploma-or-regional-variant", signals };
  }
  if (signals.needsReviewName) {
    return { programmeId: programme.id, scope: "needs-review", confidence: 0.86, reason: "research-or-joint-degree-needs-scope-review", signals };
  }
  if (!signals.taughtMasterName && !signals.officialTaughtPage) {
    return { programmeId: programme.id, scope: "needs-review", confidence: 0.82, reason: "degree-type-not-clear-from-name", signals };
  }
  return { programmeId: programme.id, scope: "target", confidence: signals.taughtMasterName ? 0.9 : 0.84, reason: signals.taughtMasterName ? "taught-master-name-match" : "official-taught-postgraduate-entry", signals };
}

export function programmeScopeAllowed(scope) {
  return !scope || !programmeScopesThatBlockCollection.has(scope.scope);
}

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
async function withDiscoveryTimeout(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${discoveryTimeoutMs}ms`)), discoveryTimeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const asArray = value => Array.isArray(value) ? value.filter(Boolean).map(String) : value ? [String(value)] : [];
const clean = value => value == null ? null : String(value).replace(/\s+/g, " ").trim() || null;
const experienceCategories = new Set(["internship", "work", "research", "paper", "competition", "award", "scholarship", "patent", "project", "course_design", "unknown"]);

const unique = values => [...new Set(values.filter(Boolean))];
const programmeFocusTermCache = new Map();

function competingProgrammeFocusTerms(programme) {
  if (!programme?.institutionId) return [];
  const key = programme.id || `${programme.institutionId}:${programme.nameEn || programme.nameZh || ""}`;
  if (programmeFocusTermCache.has(key)) return programmeFocusTermCache.get(key);
  const terms = unique(
    programmeMaster
      .filter(item => item.institutionId === programme.institutionId && item.id !== programme.id)
      .flatMap(item => item.discoveryTerms?.focus || [])
  );
  programmeFocusTermCache.set(key, terms);
  return terms;
}

const defaultSearchPlannerPrompt = `你是留学案例采集系统的搜索规划器。根据项目卡片生成用于搜索录取案例的关键词变体。
只输出 JSON：{"queryTerms":["..."]}。
要求：
1. 最多输出 12 个短语，只输出相对已有关键词真正有新增价值的变体；已有关键词已经覆盖时可以少输出。
2. 关键词只描述目标院校和目标硕士项目，不要输出 site:、URL、完整句子或虚构的案例链接。
3. 不要扩展到相邻项目；宁可少输出，也不要把 Computer Science、Robotics 等无关方向当成目标项目。
4. 关键词应适合拼接 offer、admission、case、录取、案例等搜索词。
5. 项目卡片中的官方名称优先，所有内容仅用于搜索，不判断录取概率。`;

let searchPlanCachePromise = null;

let activeAgentRun = null;
function abortActiveAgentRun(reason) {
  const active = activeAgentRun;
  if (!active) return;
  activeAgentRun = null;
  active.report.state = "aborted";
  active.report.stopReason = reason;
  active.report.finishedAt = new Date().toISOString();
  try {
    finishAgentRun(active.db, active.report.id, active.report);
    active.db.close();
  } finally {
    process.exit(143);
  }
}
process.on("SIGTERM", () => abortActiveAgentRun("process-terminated"));
process.on("SIGINT", () => abortActiveAgentRun("process-interrupted"));

function withHttpTimeout(init = {}, timeoutMs = httpTimeoutMs) {
  return { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) };
}

export function verifyCandidateAgainstText(candidate, pageText) {
  const searchable = String(pageText || "").normalize("NFKC").replace(/\s+/g, " ");
  const normalizeEvidenceValue = value => String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
  const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchedProgramme = candidate.targetProgrammeId
    ? programmeMaster.find(programme => programme.id === candidate.targetProgrammeId)
    : resolveProgramme({ universityName: candidate.targetUniversity, programmeName: candidate.targetProgramme, programmeEnglishName: candidate.targetProgrammeEnglishRaw });
  const fields = [
    ["targetUniversity", [candidate.targetUniversity]],
    ["targetProgramme", [candidate.targetProgramme, candidate.targetProgrammeEnglishRaw, matchedProgramme?.nameZh, matchedProgramme?.nameEn, ...(matchedProgramme?.aliases || [])]],
    ["undergraduateUniversity", [candidate.undergraduateUniversity]],
    ["undergraduateMajor", [candidate.undergraduateMajor]],
    ["gpaRaw", [candidate.gpaRaw]],
    ["offerYear", [candidate.offerYear]]
  ];
  const matched = {};
  const missing = [];
  for (const [field, values] of fields) {
    const normalizedValues = values.filter(Boolean).map(normalizeEvidenceValue);
    if (!normalizedValues.length) continue;
    const institutionEvidence = field === "targetUniversity"
      ? resolveInstitution(candidate.targetUniversity)
        && [resolveInstitution(candidate.targetUniversity).nameZh, resolveInstitution(candidate.targetUniversity).nameEn, ...resolveInstitution(candidate.targetUniversity).aliases]
          .filter(Boolean).map(normalizeEvidenceValue).some(value => searchable.includes(value))
      : false;
    const gpaEvidence = field === "gpaRaw"
      ? [...String(candidate.gpaRaw || "").matchAll(/\d+(?:\.\d+)?/g)].some(match => {
          const number = escapeRegExp(match[0]);
          return new RegExp(`(?:gpa|均分|平均分|绩点|学术成绩)[^\\d]{0,12}${number}`, "i").test(searchable);
        })
      : false;
    matched[field] = institutionEvidence || gpaEvidence || normalizedValues.some(value => searchable.includes(value));
    if (!matched[field]) missing.push(field);
  }
  return { matched, missing, checkedAt: new Date().toISOString() };
}

function normalizeExperiences(value) {
  if (!Array.isArray(value)) return [];
  return classifyExperienceRecords(value.flatMap(item => {
    const raw = clean(typeof item === "string" ? item : item?.raw);
    if (!raw) return [];
    const suppliedCategory = clean(typeof item === "object" ? item?.category : null)?.toLowerCase();
    return [{
      raw,
      category: experienceCategories.has(suppliedCategory) ? suppliedCategory : "unknown",
      result: clean(typeof item === "object" ? item?.result : null)
    }];
  }));
}

function normalizeAuxiliaryScores(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const test = clean(item?.test)?.toUpperCase();
    const scoreRaw = clean(item?.scoreRaw);
    return test && scoreRaw ? [{ test, scoreRaw }] : [];
  });
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function preparePageTextForSource(pageText, sourceId) {
  const text = String(pageText || "");
  if (sourceId === "hksg-public-cases") {
    return text.split(/\n\s*相关案例\s*\n/)[0].trim();
  }
  if (["thinkwithu-public-cases", "compassedu-public-cases"].includes(sourceId)) {
    const markers = [...text.matchAll(/\n\s*相关案例\s*\n/g)];
    if (markers.length) return text.slice(0, markers.at(-1).index).trim();
  }
  if (sourceId === "xdf-public-cases") {
    if (text.length > 5000) {
    const unicodeStart = text.search(/(?:^|\n)\s*\u80cc\u666f\u4ecb\u7ecd\s*\n/u);
    if (unicodeStart >= 0) {
      const body = text.slice(unicodeStart);
      const end = body.search(/\n\s*(?:\u9662\u6821\u89e3\u8bfb|\u76f8\u5173\u95ee\u7b54\u63a8\u8350)\s*\n/u);
      return text.slice(Math.max(0, unicodeStart - 3200), end >= 0 ? unicodeStart + end : unicodeStart + 12000).trim();
    }
    }

    const start = text.search(/\n\s*背景介绍\s*\n/u);
    if (start >= 0) {
      const focused = text.slice(Math.max(0, start - 1200));
      const end = focused.search(/\n\s*(?:院校解读|相关顾问推荐)\s*\n/u);
      return (end >= 0 ? focused.slice(0, end) : focused.slice(0, 12000)).trim();
    }
  }
  if (sourceId === "jjl-public-cases") {
    const start = text.search(/(?:学生背景|学生情况|本科院校|本科专业)\s*[:：]/u);
    if (start >= 0) {
      const focused = text.slice(Math.max(0, start - 1200));
      const end = focused.search(/\n\s*声明\s*[:：]/u);
      return (end >= 0 ? focused.slice(0, end) : focused.slice(0, 12000)).trim();
    }
  }
  return text;
}

export function inferSourcePublishedAt(pageText) {
  const text = String(pageText || "");
  const date = "(20\\d{2})[-年](0?[1-9]|1[0-2])[-月](0?[1-9]|[12]\\d|3[01])(?:日)?(?!\\d)";
  const labelled = text.match(new RegExp(`(?:发布时间|发布日期|发布于|发表于|更新于|更新时间|published(?:\\s+on)?|updated(?:\\s+on)?)\\s*[:：]?\\s*${date}`, "i"));
  if (labelled) return `${labelled[1]}-${String(labelled[2]).padStart(2, "0")}-${String(labelled[3]).padStart(2, "0")}`;
  // Do not treat an arbitrary historical date in navigation or boilerplate as
  // the article date. An unlabeled date is only trusted near the page header.
  const header = text.slice(0, 1800);
  const chinese = header.match(/\b(20\d{2})\u5e74(0?[1-9]|1[0-2])\u6708(0?[1-9]|[12]\d|3[01])\u65e5/);
  const iso = header.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T|\b)/);
  const match = !chinese || (iso && iso.index < chinese.index) ? iso : chinese;
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

export function resolveOfferYear(candidateYear, pageText, sourcePublishedAt) {
  const extractedYear = Number(candidateYear) || null;
  if (extractedYear && searchableEvidence(pageText).includes(String(extractedYear))) {
    return { value: extractedYear, inferred: null };
  }
  const pageOfferYear = inferOfferYear(pageText);
  if (pageOfferYear) {
    return {
      value: pageOfferYear,
      inferred: { value: pageOfferYear, confidence: "medium", basis: "page-offer-date" }
    };
  }
  const publishedYear = Number(String(sourcePublishedAt || "").slice(0, 4)) || null;
  return publishedYear
    ? { value: publishedYear, inferred: { value: publishedYear, confidence: "medium", basis: "source-publication-year-proxy" } }
    : { value: null, inferred: null };
}

function compassInstitutionLabel(header) {
  const text = String(header || "").replace(/\s+/g, " ").trim();
  const labels = institutionMaster.flatMap(institution => [
    institution.nameZh,
    institution.nameEn,
    ...(institution.aliases || [])
  ]).filter(Boolean).sort((a, b) => String(b).length - String(a).length);
  const label = labels.find(value => text.startsWith(String(value).trim()));
  if (label) return { university: text.slice(0, String(label).length).trim(), remainder: text.slice(String(label).length).trim() };
  const fallback = text.match(/^(.+?(?:大学|学院|University|College|Institute))\s*(.*)$/i);
  return fallback
    ? { university: fallback[1].trim(), remainder: fallback[2].trim() }
    : { university: null, remainder: text };
}

function parseCompassUndergraduateLine(line) {
  const withoutStatus = String(line || "")
    .replace(/(?:应届生|已毕业|毕业生|在读|其他)\s*[，,]?/u, " ")
    .split(/(?:GPA|均分|平均分|绩点|IELTS|雅思|TOEFL|托福)\s*[:：]?/i)[0]
    .replace(/[，,。；;]+\s*$/u, "")
    .trim();
  const knownUniversity = withoutStatus.match(/^(.+?(?:大学|学院|University|College|Institute)(?:\s*\([^)]*\))?)\s+(.+)$/i);
  if (knownUniversity) return { undergraduateUniversity: knownUniversity[1].trim(), undergraduateMajor: knownUniversity[2].trim() };
  const firstSpace = withoutStatus.search(/\s+/u);
  if (firstSpace > 0) {
    return {
      undergraduateUniversity: withoutStatus.slice(0, firstSpace).trim(),
      undergraduateMajor: withoutStatus.slice(firstSpace).trim()
    };
  }
  return { undergraduateUniversity: null, undergraduateMajor: null };
}

function parseCompassProfileLine(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  const gpaMatch = text.match(/(?:GPA|均分|平均分|绩点)\s*[:：]?\s*([0-9]+(?:\.\d+)?(?:\s*\/\s*[0-9]+(?:\.\d+)?)?)/i);
  const languageMatch = text.match(/(IELTS|雅思|TOEFL|托福)\s*[:：]?\s*([0-9]+(?:\.\d+)?)/i);
  return {
    ...parseCompassUndergraduateLine(text),
    gpaRaw: gpaMatch?.[1]?.trim() || null,
    languageTest: languageMatch?.[1] || null,
    languageScore: languageMatch ? Number(languageMatch[2]) : null
  };
}

function extractCompassCardCases(lines) {
  const headers = lines.map((line, index) => ({
    line,
    index,
    match: String(line).match(/^(.*?)(?:offer|Offer)\s*(?:一枚|一个)?\s*$/u)
  })).filter(item => item.match);
  if (!headers.length) return [];
  const sourcePublishedAt = inferSourcePublishedAt(lines.join("\n"));
  const offerYear = Number(sourcePublishedAt?.slice(0, 4)) || null;
  const cases = [];
  for (const [position, header] of headers.entries()) {
    const end = headers[position + 1]?.index ?? lines.length;
    const body = lines.slice(header.index + 1, end);
    const profileIndex = body.findIndex(line => /(?:GPA|均分|平均分|绩点|IELTS|雅思|TOEFL|托福)\s*[:：]?\s*[0-9]/i.test(line));
    if (profileIndex < 0) continue;
    const profile = parseCompassProfileLine(body[profileIndex]);
    if (!profile.undergraduateUniversity || !profile.undergraduateMajor || !profile.gpaRaw) continue;
    const headerParts = compassInstitutionLabel(header.match[1]);
    if (!headerParts.university || !headerParts.remainder) continue;
    const experienceLine = body.slice(profileIndex + 1).find(line => /^主要经历\s*[:：]/u.test(line));
    cases.push({
      targetUniversity: headerParts.university,
      targetProgramme: headerParts.remainder.replace(/研究生$/u, "").trim() || null,
      targetProgrammeEnglishRaw: null,
      offerYear,
      undergraduateUniversity: profile.undergraduateUniversity,
      undergraduateMajor: profile.undergraduateMajor,
      gpaRaw: profile.gpaRaw,
      gpaScale: "UNKNOWN",
      gpa100: null,
      languageTest: profile.languageTest,
      languageScale: null,
      languageScore: profile.languageScore,
      auxiliaryScores: [],
      experiences: experienceLine
        ? [{ raw: experienceLine.replace(/^主要经历\s*[:：]?\s*/u, "").trim(), category: "unknown", result: null }]
        : [],
      sourcePublishedAt
    });
  }
  return cases;
}

export function extractStructuredCasesForSource(pageText, sourceId) {
  const hksg = sourceId === "hksg-public-cases";
  const compass = sourceId === "compassedu-public-cases";
  if (!hksg && !compass) return [];
  const lines = String(pageText || "").split(/\n/).map(line => line.trim()).filter(Boolean);
  if (compass) {
    const cardCases = extractCompassCardCases(lines);
    if (cardCases.length) return cardCases;
  }
  const valueAfter = label => {
    const index = lines.findIndex(line => line === label || line.startsWith(`${label} `) || line.startsWith(`${label}:`) || line.startsWith(`${label}\uFF1A`));
    if (index < 0) return null;
    const inline = lines[index].slice(label.length).replace(/^\s*[:\uFF1A]\s*/, "").trim();
    return inline || lines[index + 1] || null;
  };
  const targetUniversity = valueAfter("\u5F55\u53D6\u5B66\u6821");
  const targetProgramme = valueAfter("\u5F55\u53D6\u4E13\u4E1A");
  const undergraduateUniversity = valueAfter("\u6BD5\u4E1A\u5B66\u6821");
  const undergraduateMajor = valueAfter("\u672C\u79D1\u4E13\u4E1A");
  const background = valueAfter("\u57FA\u672C\u80CC\u666F") || "";
  if (!targetUniversity || !targetProgramme || !undergraduateUniversity || !undergraduateMajor) return [];
  const gpaRaw = (compass
    ? background.match(/GPA\s*[:\uFF1A]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)/i)?.[1]
    : background.match(/GPA\s*[:\uFF1A]?\s*([^/]+?)(?=\s*\/|$)/i)?.[1])?.trim() || null;
  const languageMatch = background.match(/(IELTS|TOEFL|\u96C5\u601D|\u6258\u798F)\s*[:\uFF1A]?\s*(\d+(?:\.\d+)?)/i);
  const sourcePublishedAt = inferSourcePublishedAt(pageText);
  const offerDate = valueAfter("offer\u53D1\u653E\u65F6\u95F4") || valueAfter("Offer\u53D1\u653E\u65F6\u95F4");
  const offerYear = Number(offerDate?.match(/20\d{2}/)?.[0]) || Number(sourcePublishedAt?.slice(0, 4)) || null;
  const experienceStart = lines.indexOf(compass ? "\u4E3B\u8981\u7ECF\u5386" : "\u8F6F\u6027\u80CC\u666F");
  const experienceEnd = lines.findIndex((line, index) => index > experienceStart && (compass ? /\u80CC\u666F\u63D0\u5347/i : /\u7533\u8BF7Timeline/i).test(line));
  const experiences = experienceStart >= 0
    ? lines.slice(experienceStart + 1, experienceEnd > experienceStart ? experienceEnd : experienceStart + 8).map(raw => ({ raw, category: "unknown", result: null }))
    : [];
  return [{
    targetUniversity,
    targetProgramme,
    targetProgrammeEnglishRaw: null,
    offerYear,
    undergraduateUniversity,
    undergraduateMajor,
    gpaRaw,
    gpaScale: "UNKNOWN",
    gpa100: null,
    languageTest: languageMatch?.[1] || null,
    languageScale: null,
    languageScore: languageMatch ? Number(languageMatch[2]) : null,
    auxiliaryScores: [],
    experiences,
    sourcePublishedAt
  }];
}

function normalizePageSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeCandidateUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:fromrecommandation|fromclass|utm_[^]+|spm|ref)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return String(value || "");
  }
}

function pageHeadingText(html) {
  const source = String(html || "");
  const matches = [
    source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    ...[...source.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .slice(0, 6).map(match => match[1])
  ].filter(Boolean);
  return stripHtml(matches.join(" "));
}

function academicYearTokens(value) {
  const text = String(value || "");
  const years = new Set();
  for (const match of text.matchAll(/\b(20\d{2})(?:\s*[-/]\s*(20?\d{2,4}))?\b/g)) {
    const start = match[1];
    years.add(match[2] ? `${start}-${match[2]}` : start);
  }
  return [...years];
}

function historicalAcademicYears(values) {
  return unique(values.flatMap(value => academicYearTokens(value))).filter(value => /20\d{2}/.test(value));
}

function explicitNewProgrammeSignal(text) {
  return String(text || "").match(/(?:new(?:ly)?\s+(?:introduced|launched|established)|new\s+(?:master'?s?|degree)\s+(?:degree\s+)?programme|new\s+for\s+20\d{2}|(?:will|to)\s+launch|first\s+intake|首次招生|新开(?:设|的)|新项目|新设)/iu);
}

function sameOfficialHost(expectedUrl, actualUrl) {
  try {
    const expected = new URL(expectedUrl).hostname.toLowerCase();
    const actual = new URL(actualUrl).hostname.toLowerCase();
    return actual === expected || actual.endsWith(`.${expected}`) || expected.endsWith(`.${actual}`);
  } catch {
    return false;
  }
}

export function programmeCollectionAllowed(status) {
  return !status || !programmeStatusesThatBlockCollection.has(status.status);
}

export function classifyProgrammeStatus({ programme, officialUrl = null, finalUrl = null, httpStatus = null, html = "", documents = [] } = {}) {
  const text = stripHtml(`${pageHeadingText(html)} ${officialUrl || ""} ${html}`);
  const searchable = normalizePageSearchText(text);
  const programmeHits = searchTermHit(searchable, specificProgrammeSearchTerms(programme));
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionHits = searchTermHit(searchable, unique([
    institution?.nameEn, institution?.nameZh, ...(institution?.aliases || [])
  ]));
  const nameMatch = programmeHits.length > 0 || Boolean(programme?.officialCode && searchable.includes(normalizePageSearchText(programme.officialCode)));
  const historyYears = historicalAcademicYears([
    text,
    ...documents.flatMap(document => asArray(document.academicYears))
  ]);
  const newSignal = explicitNewProgrammeSignal(text);
  const explicitNew = Boolean(newSignal);
  const pageReachable = Number(httpStatus) >= 200 && Number(httpStatus) < 400;
  const hostMatch = !officialUrl || !finalUrl || sameOfficialHost(officialUrl, finalUrl);
  let status = "current-history-unknown";
  let reason = "官网页面可访问，项目名称匹配，但缺少明确的历史招生证据";
  let confidence = 0.72;
  if (!officialUrl) {
    status = "unverified";
    reason = "项目没有官方URL";
    confidence = 0.98;
  } else if (!pageReachable) {
    status = [404, 410].includes(Number(httpStatus)) ? "unverified" : "verification-error";
    reason = [404, 410].includes(Number(httpStatus))
      ? `官方页面返回${httpStatus}，当前链接未找到项目页面`
      : `官方页面访问受限或服务异常：${httpStatus ?? "unknown"}`;
    confidence = 0.82;
  } else if (!hostMatch) {
    status = "unverified";
    reason = "官方链接跳转到未确认的域名";
    confidence = 0.94;
  } else if (!nameMatch) {
    status = "unverified";
    reason = "官网页面可访问，但未匹配到项目名称";
    confidence = 0.9;
  } else if (explicitNew) {
    status = "confirmed-new";
    reason = "官方页面出现新项目或首次招生的明确表述";
    confidence = 0.94;
  } else if (historyYears.length >= 2) {
    status = "confirmed-current";
    reason = "官网页面或官方项目资料包含至少两个学年/年份证据";
    confidence = 0.88;
  }
  return {
    programmeId: programme?.id || null,
    status,
    confidence,
    officialUrl,
    finalUrl,
    httpStatus: httpStatus == null ? null : Number(httpStatus),
    officialNameMatch: nameMatch,
    historyYears,
    reason,
    evidence: {
      programmeHits: programmeHits.slice(0, 12),
      institutionHits: institutionHits.slice(0, 8),
      explicitNew,
      newSignal: newSignal?.[0] || null,
      hostMatch,
      pageReachable,
      pageHeading: pageHeadingText(html).slice(0, 500)
    }
  };
}

function applyProgrammeStatusOverride(programme, result) {
  const override = programmeStatusOverrides[programme?.id];
  if (!override || !result.officialNameMatch || !(Number(result.httpStatus) >= 200 && Number(result.httpStatus) < 400)) return result;
  return {
    ...result,
    status: override.status || result.status,
    confidence: Number(override.confidence || result.confidence),
    reason: override.reason || result.reason,
    evidence: {
      ...result.evidence,
      override: { evidenceUrl: override.evidenceUrl || null, reason: override.reason || null }
    }
  };
}

export async function verifyProgrammeStatus(programme, { fetchImpl = fetch, documents = [], checkRobots = true } = {}) {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  if (!targetInstitutionIds.includes(programme?.institutionId)
    && !["香港", "新加坡"].includes(institution?.countryRegion)) {
    return {
      programmeId: programme?.id || null,
      status: "out-of-scope",
      confidence: 0.99,
      officialUrl: programme?.officialUrl || null,
      finalUrl: null,
      httpStatus: null,
      officialNameMatch: false,
      historyYears: [],
      reason: "项目所属院校不在港新目标范围",
      evidence: {}
    };
  }
  const override = programmeStatusOverrides[programme?.id] || {};
  const officialUrl = override.currentUrl || programme?.officialUrl || null;
  if (!officialUrl) return applyProgrammeStatusOverride(programme, classifyProgrammeStatus({ programme, officialUrl, documents }));
  try {
    if (checkRobots && !await robotsAllows(officialUrl, fetchImpl)) {
      return {
        ...classifyProgrammeStatus({ programme, officialUrl, httpStatus: 403, documents }),
        status: "verification-error",
        confidence: 0.8,
        reason: "robots.txt不允许核验官方页面，不能据此判断项目不存在"
      };
    }
    const { response, html } = await fetchOfficialPage(officialUrl, fetchImpl);
    return applyProgrammeStatusOverride(programme, classifyProgrammeStatus({ programme, officialUrl, finalUrl: response.url || officialUrl, httpStatus: response.status, html, documents }));
  } catch (error) {
    return {
      programmeId: programme.id,
      status: "verification-error",
      confidence: 0.8,
      officialUrl,
      finalUrl: null,
      httpStatus: null,
      officialNameMatch: false,
      historyYears: [],
      reason: `官方页面访问失败，不能据此判断项目不存在：${error.message}`,
      evidence: { error: error.message }
    };
  }
}

export async function verifyProgrammeStatuses({ db: suppliedDb = null, programmeIds = [], institutionIds = targetInstitutionIds, limit = Infinity, concurrency = 4, force = false, fetchImpl = fetch, checkRobots = true } = {}) {
  const db = suppliedDb || openCaseStore();
  const ownDb = !suppliedDb;
  try {
    const allowedInstitutions = new Set(institutionIds.filter(Boolean));
    const requestedIds = new Set(programmeIds.filter(Boolean));
    const programmes = programmeMaster
      .filter(programme => programme.active !== false)
      .filter(programme => !allowedInstitutions.size || allowedInstitutions.has(programme.institutionId))
      .filter(programme => !requestedIds.size || requestedIds.has(programme.id))
      .slice(0, Math.max(0, Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER));
    const queue = [...programmes];
    const results = [];
    const worker = async () => {
      for (;;) {
        const programme = queue.shift();
        if (!programme) return;
        const existing = getProgrammeStatus(db, programme.id);
        if (existing && !force) {
          results.push({ ...existing, skipped: true });
          continue;
        }
        const documents = listProgrammeDocuments(db, [programme.id]);
        const result = await verifyProgrammeStatus(programme, { fetchImpl, documents, checkRobots });
        results.push(saveProgrammeStatus(db, result));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, programmes.length || 1)) }, worker));
    const counts = Object.fromEntries([...new Set(results.map(result => result.status))].map(status => [status, results.filter(result => result.status === status).length]));
    return { checked: results.filter(result => !result.skipped).length, skipped: results.filter(result => result.skipped).length, counts, results };
  } finally {
    if (ownDb) db.close();
  }
}

export function classifyProgrammeScopes({ db: suppliedDb = null, programmeIds = [], institutionIds = targetInstitutionIds, limit = Infinity } = {}) {
  const db = suppliedDb || openCaseStore();
  const ownDb = !suppliedDb;
  try {
    const allowedInstitutions = new Set(institutionIds.filter(Boolean));
    const requestedIds = new Set(programmeIds.filter(Boolean));
    const programmes = programmeMaster
      .filter(programme => programme.active !== false)
      .filter(programme => !allowedInstitutions.size || allowedInstitutions.has(programme.institutionId))
      .filter(programme => !requestedIds.size || requestedIds.has(programme.id))
      .slice(0, Math.max(0, Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER));
    const results = programmes.map(programme => saveProgrammeScope(db, classifyProgrammeScope(programme)));
    const counts = Object.fromEntries([...new Set(results.map(result => result.scope))].map(scope => [scope, results.filter(result => result.scope === scope).length]));
    return { classified: results.length, counts, results };
  } finally {
    if (ownDb) db.close();
  }
}

export function fallbackTargetHeadingHits(headingText, programme) {
  return searchTermHit(normalizePageSearchText(headingText), programmeSearchTerms(programme))
    .filter(term => !/^(?:理学硕士|理學碩士|工学硕士|工學碩士|硕士|碩士|master|msc|ma|ms|mba)$/i.test(normalizePageSearchText(term).replace(/\s+/g, "")));
}

function searchTermHit(searchable, terms) {
  const compactSearchable = searchable.replace(/\s+/g, "");
  return terms.filter(term => {
    const normalized = normalizePageSearchText(term);
    return normalized && (searchable.includes(normalized) || compactSearchable.includes(normalized.replace(/\s+/g, "")));
  });
}

function programmeSearchTerms(programme) {
  if (!programme) return [];
  const rawTerms = unique([
    ...(programme.strictMatchTerms || []),
    programme.nameEn,
    programme.nameZh,
    ...(programme.aliases || [])
  ]);
  const simplified = rawTerms.flatMap(term => {
    const value = String(term || "").normalize("NFKC");
    const english = value
      .replace(/\b(?:master\s+of\s+science|master|msc(?:\s*\(eng\))?|m\.sc\.?|msceng)\b/gi, " ")
      .replace(/\bin\b/gi, " ")
      .replace(/\b(?:programme|program|degree)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const chinese = value
      .replace(/(?:理学)?硕士(?:学位)?/g, "")
      .replace(/(?:项目|课程)$/g, "")
      .trim();
    return [english, chinese, english.replace(/\s+/g, "")];
  });
  return unique([...rawTerms, ...simplified]).filter(term => normalizePageSearchText(term).length >= 4);
}

function isGenericProgrammeSearchTerm(term) {
  return /^(?:\u7406\u5b66\u7855\u58eb|\u7406\u5b78\u78a9\u58eb|\u5de5\u5b66\u7855\u58eb|\u5de5\u5b78\u78a9\u58eb|\u7855\u58eb|\u78a9\u58eb|master|msc|ma|ms|mba)$/i
    .test(normalizePageSearchText(term).replace(/\s+/g, ""));
}

function specificProgrammeSearchTerms(programme) {
  return programmeSearchTerms(programme).filter(term => !isGenericProgrammeSearchTerm(term));
}

function competingProgrammeIds(programme, text) {
  const searchable = normalizePageSearchText(text);
  if (!searchable || !programme?.institutionId) return [];
  return programmeMaster
    .filter(item => item.institutionId === programme.institutionId && item.id !== programme.id)
    .filter(item => searchTermHit(searchable, specificProgrammeSearchTerms(item)).length > 0)
    .map(item => item.id);
}

const directionKeywords = {
  automation: ["automation", "control", "robotics", "robot", "自动化", "控制", "机器人"],
  electronic: ["electronic", "electronics", "microelectronics", "semiconductor", "电子", "微电子", "半导体"],
  electrical: ["electrical", "power engineering", "power system", "电气", "电机", "电力"],
  communication: ["communication", "communications", "wireless", "telecom", "5g", "通信", "无线"],
  computer: ["computer", "computing", "software", "information engineering", "计算机", "软件", "信息工程"],
  data: ["data", "artificial intelligence", "machine learning", "ai", "数据", "人工智能", "机器学习"]
};

export function scorePageForExtraction({ url, html = "", pageText = "", programmeId = null, allowDirectionOnly = false, allowSparseDetail = false } = {}) {
  const programme = programmeMaster.find(item => item.id === programmeId) || null;
  const institution = programme
    ? institutionMaster.find(item => item.id === programme.institutionId)
    : null;
  const heading = normalizePageSearchText(pageHeadingText(html));
  const urlText = normalizePageSearchText(url);
  const normalizedVisible = normalizePageSearchText(pageText);
  const visible = normalizedVisible.slice(0, 16000);
  const mainVisible = normalizedVisible.split(/(?:相关推荐|相关案例|推荐案例|相关阅读|猜你喜欢|你可能还喜欢)/i)[0];
  const focused = `${heading} ${urlText} ${mainVisible.slice(0, 6000)}`;
  const searchable = `${heading} ${urlText} ${visible}`;
  const programmeTerms = unique([
    ...programmeSearchTerms(programme),
    ...(new URL(url, "https://example.com").hostname.endsWith("hksg.org")
      ? (hksgProgrammeAliases[programme?.id] || [])
      : [])
  ]);
  const institutionTerms = institution
    ? unique([institution.nameEn, institution.nameZh, ...(institution.aliases || [])])
    : [];
  const programmeHits = searchTermHit(focused, programmeTerms);
  const specificProgrammeHits = programmeHits.filter(term => !isGenericProgrammeSearchTerm(term));
  const moreSpecificProgrammeIds = programme
    ? programmeMaster
      .filter(item => item.institutionId === programme.institutionId && item.id !== programme.id)
      .filter(item => {
        const targetTerms = specificProgrammeSearchTerms(programme).map(term => normalizePageSearchText(term)).filter(Boolean);
        const siblingTerms = specificProgrammeSearchTerms(item).map(term => normalizePageSearchText(term)).filter(Boolean);
        return siblingTerms.some(siblingTerm => targetTerms.some(targetTerm => siblingTerm.length > targetTerm.length && siblingTerm.includes(targetTerm)
          && searchTermHit(focused, [siblingTerm]).length > 0));
      })
      .map(item => item.id)
    : [];
  const institutionHits = searchTermHit(focused, institutionTerms);
  const headingInstitutionHits = searchTermHit(`${heading} ${urlText}`, institutionTerms);
  const directionHits = Object.fromEntries(Object.entries(directionKeywords)
    .map(([tag, terms]) => [tag, searchTermHit(focused, terms).slice(0, 5)])
    .filter(([, hits]) => hits.length));
  const directionGroups = Object.keys(directionHits);
  const signalGroups = [
    ["result", /(?:offer|admission|accepted|acceptance|录取|录用|获录|申请成功)/i],
    ["profile", /(?:gpa|ielts|toefl|本科|均分|雅思|托福|成绩单)/i],
    ["background", /(?:internship|research|project|competition|实习|科研|项目|竞赛|论文)/i],
    ["case", /(?:case|student|applicant|申请人|学生|背景)/i]
  ].filter(([, pattern]) => pattern.test(searchable)).map(([name]) => name);
  const evidenceText = String(pageText || "").normalize("NFKC").slice(0, 16000);
  const sourcePublishedAt = inferSourcePublishedAt(evidenceText);
  const sourcePublishedYear = Number(String(sourcePublishedAt || "").slice(0, 4)) || null;
  const sourceBefore2021 = Boolean(sourcePublishedYear && sourcePublishedYear < 2021);
  const fieldSignalGroups = [
    ["undergraduate", /(?:(?:本科院校|就读院校|毕业学校|毕业院校|毕业\s*\/??\s*在读学校|背景院校|本科背景)\s*[:：|]?\s*(?!(?:国内)?本科\b)[^\n，。；|]{0,50}(?:大学|学院|985|211|双一流|双非|海本|海外本科|university|college|institute)|(?:本科就读于|本科毕业于|就读于|毕业于)[^\n，。；]{0,50}(?:大学|学院|985|211|双一流|双非|海本|海外本科|university|college|institute)|(?:985|211|双一流|双非|海本|海外本科)(?:院校|高校|大学)?)/iu],
    ["major", /(?:(?:本科专业|就读专业|专业背景|所学专业|主修|专业)\s*[:：|]?\s*[^\n，。；|]{2,50}|(?:本科毕业于|本科就读于|就读于|毕业于)\s*[^\n，。；]{0,50}(?:大学|学院)(?:\([^)]*\))?\s*[^\n，。；]{2,40}(?:专业)?|(?:985|211|双一流|双非|海本|海外本科)(?:一本|二本|本科)?(?:院校|高校|大学)?[，,\s]+[^\n，。；]{2,40}专业|(?:就读院校|毕业学校|毕业院校|毕业\/在读学校)\s*[:：|]?\s*[^\n]{0,50}(?:大学|学院)\s+[^\n，。；]{2,40})/iu],
    ["gpa", /(?:gpa|均分|平均分|在校均分|绩点|学术成绩)\s*[:：]?\s*(?:约|为)?\s*\d/i],
    ["year", /(?:20\d{2}\s*(?:fall|spring|申请季|入学|年)|20\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01]))/i],
    ["language", /(?:ielts|toefl|雅思|托福|六级|英语成绩)/i]
  ].filter(([, pattern]) => pattern.test(evidenceText)).map(([name]) => name);
  const chineseOfferMatch = /(?:录取院校(?:及专业)?|录取专业)/i.exec(evidenceText);
  const englishOfferMatch = /(?:offer(?:院校|专业)?|admitted\s+(?:to|programme|program))/i.exec(evidenceText);
  // Prefer the structured Chinese field over an earlier title containing the
  // generic word "offer".
  const offerMatch = chineseOfferMatch || englishOfferMatch;
  const offerMarkerIndex = offerMatch?.index ?? -1;
  // On PECCN pages the first non-empty lines after this marker are the actual
  // offer field. A character window drifts into the consultant's strategy
  // text, where rejected alternatives can mention the target direction.
  const offerTail = offerMarkerIndex >= 0 ? evidenceText.slice(offerMarkerIndex) : "";
  const offerLines = offerTail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const advisorLineIndex = offerLines.findIndex(line => /留学顾问|顾问老师|advisor/i.test(line));
  const offerLineLimit = /录取院校及专业/i.test(offerLines[0] || "")
    ? 2
    : advisorLineIndex > 0 ? advisorLineIndex : 4;
  const offerSection = offerLines.slice(0, offerLineLimit).join("\n");
  const offerProgrammeHits = offerSection ? searchTermHit(offerSection, programmeTerms) : [];
  const offerDirectionGroups = offerSection
    ? Object.entries(directionKeywords)
      .filter(([, terms]) => searchTermHit(offerSection, terms).length)
      .map(([tag]) => tag)
    : [];
  const isPeccnPage = /(?:^|\.)peccn\.com$/i.test(new URL(url, "https://example.com").hostname);
  const offerHasCompatibleDirection = offerDirectionGroups.some(group => {
    const tags = new Set(programme?.majorTags || []);
    if (tags.has(group)) return true;
    if (group === "electronic" && (tags.has("integrated-circuit") || tags.has("semiconductor"))) return true;
    if (group === "computer" && (tags.has("cybersecurity") || tags.has("network"))) return true;
    if (group === "communication" && (tags.has("signal") || tags.has("network"))) return true;
    return false;
  });
  const peccnOfferEvidence = !isPeccnPage || offerMarkerIndex < 0 || offerProgrammeHits.length > 0 || offerHasCompatibleDirection;
  const detailUrl = /(?:offer|case|admission|cgal|posts|article|newst|study\s+case|h-nd-\d+|blog)/i.test(urlText)
    || /(?:\/c\/\d+\.shtml|\/case_\d+\.shtml|\/webwyjbinfo\/\d+|\/h-nd-\d+\.html|\/20\d{2}(?:\d{2})?\/\d{1,2}\/\d+\.html?)/i.test(String(url));
  const imageCount = (String(html).match(/<img\b/gi) || []).length;
  const hasCaseSignals = signalGroups.length >= 2;
  const sparseTrustedDetail = Boolean(allowSparseDetail && detailUrl && hasCaseSignals && imageCount > 0 && evidenceText.length >= 500);
  const multiCaseDetail = !programme
    && detailUrl
    && hasCaseSignals
    && /(?:\u5f55\u53d6\u9662\u6821|\u5f55\u53d6\u4e13\u4e1a|admitted\s+(?:to|for)|offer\s+(?:from|for))/i.test(evidenceText)
    && /(?:gpa|\u5747\u5206|\u5b66\u672f\u6210\u7ee9)/i.test(evidenceText);
  const requiredFieldSignalGroups = ["undergraduate", "major", "gpa", "year"];
  const enoughAdmissionFields = requiredFieldSignalGroups.every(field => fieldSignalGroups.includes(field));
  const targetFound = programme ? specificProgrammeHits.length > 0 && moreSpecificProgrammeIds.length === 0 : true;
  const multiProgrammeSummary = !targetFound && /(?:admission|offer|case|\u6848\u4f8b|\u5f55\u53d6).{0,24}(?:[:\uff1a]|,|\u3001|\/|\band\b|\u4e0e)/i.test(heading);
  const institutionMarkerGroups = [
    ["ntu", "nanyang technological university"],
    ["nus", "national university of singapore"],
    ["cuhk", "the chinese university of hong kong"],
    ["hku", "university of hong kong"],
    ["hkust", "hong kong university of science and technology"],
    ["cityu", "city university of hong kong"],
    ["polyu", "hong kong polytechnic university"]
  ];
  const institutionMarkerCount = institutionMarkerGroups
    .filter(group => searchTermHit(heading, group).length > 0).length;
  const multiInstitutionSummary = institutionMarkerCount > 1;
  const domesticOnlyBackground = /(?:国内(?:本科|双非)|domestic\s+undergraduate)/i.test(evidenceText)
    && !/(?:大学|学院|university|college|institute|985|211|双一流|海外本科)/i.test(evidenceText);
  const explicitTargetMatch = specificProgrammeHits.length > 0 && moreSpecificProgrammeIds.length === 0;
  const directionMatchesProgramme = directionGroups.some(group => {
    const tags = new Set(programme?.majorTags || []);
    if (tags.has(group)) return true;
    if (group === "electronic" && (tags.has("integrated-circuit") || tags.has("semiconductor"))) return true;
    if (group === "computer" && (tags.has("cybersecurity") || tags.has("network"))) return true;
    if (group === "communication" && (tags.has("signal") || tags.has("network"))) return true;
    return false;
  });
  const conflictingProgrammeHits = programme && specificProgrammeHits.length === 0
    ? programmeMaster
      .filter(item => item.institutionId === programme.institutionId && item.id !== programme.id)
      .map(item => ({ id: item.id, hits: searchTermHit(heading, programmeSearchTerms(item)) }))
      .filter(item => item.hits.length)
    : [];
  const hasExplicitProgrammeConflict = conflictingProgrammeHits.length > 0 || moreSpecificProgrammeIds.length > 0;
  const directedTarget = Boolean(
    programme
    && !hasExplicitProgrammeConflict
    && institutionHits.length > 0
    && directionMatchesProgramme
    && peccnOfferEvidence
    && !multiInstitutionSummary
    && !domesticOnlyBackground
    && (detailUrl || signalGroups.length >= 2)
  );
  // A direction-only match is useful as a diagnostic signal, but it is not
  // sufficient evidence for a programme-scoped extraction. Otherwise a page
  // that only says "PolyU robotics" can spend model tokens and later be
  // mistaken for a specific MSc. Keep the signal in the report, but require
  // an explicit programme match before entering extraction.
  const directionOnlyTarget = Boolean(
    allowDirectionOnly
    && programme
    && !hasExplicitProgrammeConflict
    && headingInstitutionHits.length > 0
    && directionMatchesProgramme
    && enoughAdmissionFields
    && hasCaseSignals
    && detailUrl
    && peccnOfferEvidence
    && !multiProgrammeSummary
    && !multiInstitutionSummary
    && !domesticOnlyBackground
  );
  const conflictWithTargetDirection = Boolean(
    programme
    && moreSpecificProgrammeIds.length === 0
    && hasExplicitProgrammeConflict
    && !explicitTargetMatch
    && institutionHits.length > 0
    && directionMatchesProgramme
    && enoughAdmissionFields
    && hasCaseSignals
    && detailUrl
    && !domesticOnlyBackground
  );
  const likelyCasePage = Boolean(
    (!sourceBefore2021 && programme && targetFound && ((enoughAdmissionFields && (hasCaseSignals || detailUrl || imageCount > 0))
       || (detailUrl && imageCount > 0 && hasCaseSignals)))
    || (!sourceBefore2021 && programme && explicitTargetMatch && !domesticOnlyBackground && hasCaseSignals && (detailUrl || imageCount > 0))
    // Programme-scoped collection requires the page itself to name the
    // requested programme (or a configured trusted source to bypass this
    // prefilter). School + direction alone is never enough.
    || (!sourceBefore2021 && !programme && (multiCaseDetail || sparseTrustedDetail || (enoughAdmissionFields && (hasCaseSignals || (detailUrl && signalGroups.length >= 1)))))
  );
  const score = specificProgrammeHits.length * 5 + institutionHits.length * 3
    + signalGroups.length * 2 + (detailUrl ? 1 : 0) + (imageCount ? 1 : 0);
  return {
    decision: likelyCasePage ? "pass" : "skip",
    score,
    programmeId,
    programmeHits: specificProgrammeHits.slice(0, 5),
    genericProgrammeHits: programmeHits.filter(term => isGenericProgrammeSearchTerm(term)).slice(0, 5),
    competingProgrammeIds: moreSpecificProgrammeIds,
    institutionHits: institutionHits.slice(0, 5),
    headingInstitutionHits: headingInstitutionHits.slice(0, 5),
    directionHits,
    directionGroups,
    fieldSignalGroups,
    requiredFieldSignalGroups,
    enoughAdmissionFields,
    signalGroups,
    detailUrl,
    sparseTrustedDetail,
    imageCount,
    focusedTextLength: Math.min(mainVisible.length, 6000),
    textLength: String(pageText || "").length,
    reasons: [
      programmeHits.length ? "target-programme-found" : null,
      institutionHits.length ? "target-institution-found" : null,
      directionGroups.length ? `direction-found:${directionGroups.join(",")}` : null,
      ...signalGroups.map(name => `case-signal:${name}`),
      detailUrl ? "case-like-url" : null,
      sourceBefore2021 ? `source-before-2021:${sourcePublishedYear}` : null,
      domesticOnlyBackground ? "domestic-background-without-school" : null,
      hasExplicitProgrammeConflict ? `explicit-programme-conflict:${conflictingProgrammeHits.map(item => item.id).join(",")}` : null,
      !likelyCasePage ? "insufficient-local-evidence" : "enough-local-evidence",
      programme && !explicitTargetMatch && directedTarget ? "direction-only-match" : null,
      directionOnlyTarget ? "low-coverage-direction-only-match" : null,
      conflictWithTargetDirection ? "conflicting-programme-with-target-direction" : null,
      multiProgrammeSummary ? "multi-programme-summary" : null,
      multiCaseDetail ? "multi-case-detail" : null,
      isPeccnPage && offerMarkerIndex >= 0 && !peccnOfferEvidence ? "peccn-offer-section-mismatch" : null
    ].filter(Boolean)
  };
}

export function mergeProgrammeJobs(jobs = []) {
  const grouped = new Map();
  for (const job of jobs) {
    const url = clean(job?.url);
    if (!url) continue;
    const row = grouped.get(url) || { url, programmeIds: [] };
    if (job.programmeId && !row.programmeIds.includes(job.programmeId)) row.programmeIds.push(job.programmeId);
    grouped.set(url, row);
  }
  return [...grouped.values()].map(row => ({
    url: row.url,
    programmeId: row.programmeIds.length === 1 ? row.programmeIds[0] : null,
    requestedProgrammeIds: row.programmeIds
  }));
}

export function extractImageUrls(html, baseUrl, maxImages = Number(process.env.COLLECTOR_OCR_MAX_IMAGES || 8)) {
  const candidates = [];
  const tagPattern = /<img\b[^>]*>/gi;
  const attrPattern = /\b(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["']/i;
  const noisePattern = /(?:logo|icon|avatar|qrcode|qr-code|gongzhonghao|zixun|zaixian|phone|pinggu|vip|wydy|wywb|wywx|wyxhs|indeximg\/hzhb)/i;
  const contentPattern = /(?:\/file\/|upload|content|ugc|article|case|offer|post|mdpic)/i;
  for (const [index, tag] of [...String(html || "").matchAll(tagPattern)].entries()) {
    const match = tag[0].match(attrPattern);
    if (!match) continue;
    try {
      const imageUrl = new URL(match[1], baseUrl);
      if (!/^https?:$/.test(imageUrl.protocol)) continue;
      imageUrl.hash = "";
      if (candidates.some(candidate => candidate.url === imageUrl.href)) continue;
      const searchable = `${imageUrl.pathname} ${tag[0]}`;
      const score = (contentPattern.test(searchable) ? 100 : 0) - (noisePattern.test(searchable) ? 200 : 0);
      candidates.push({ url: imageUrl.href, score, index });
    } catch {}
  }
  return candidates
    .filter(candidate => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxImages)
    .map(candidate => candidate.url);
}

function selectOcrImageUrls(imageUrls, source) {
  const patterns = asArray(source?.ocrImagePatterns);
  if (!patterns.length) return imageUrls;
  const matched = imageUrls.filter(url => patterns.some(pattern => {
    try { return new RegExp(pattern, "i").test(url); } catch { return false; }
  }));
  return matched.length ? matched : imageUrls;
}

function chatCompletionsUrl(value) {
  const url = clean(value);
  if (!url) return null;
  return /\/chat\/completions\/?$/i.test(url)
    ? url
    : `${url.replace(/\/+$/, "")}/chat/completions`;
}

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(item => typeof item === "string" ? item : item?.text || "").join("\n");
}

export function recoverGpaFromSourceText(candidate, pageText, sourceId) {
  if (sourceId !== "xdf-public-cases" || clean(candidate?.gpaRaw)) return candidate;
  const text = String(pageText || "").normalize("NFKC").replace(/\s+/g, " ");
  const matches = [...text.matchAll(/(?:GPA|\u5747\u5206|\u5e73\u5747\u5206|\u7ee9\u70b9)\s*[:\uff1a]?\s*(\d{1,3}(?:\.\d+)?(?:\s*\/\s*\d{1,3}(?:\.\d+)?)?)/giu)]
    .map(match => match[1].trim())
    .filter(value => Number.isFinite(Number(value.match(/\d+(?:\.\d+)?/)?.[0])));
  return matches.length ? { ...candidate, gpaRaw: matches[0] } : candidate;
}

function normalizeGpa(candidate) {
  const supplied = Number(candidate.gpa100);
  const raw = clean(candidate.gpaRaw);
  if (!raw) return null;
  const ratio = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*100\b/);
  if (ratio) return Math.min(100, Number(ratio[1]));
  const percent = raw.match(/(?:均分|平均分)\s*[:：]?\s*(\d{2}(?:\.\d+)?)\s*(?:分|%|[；;，,。]|$)/i)
    || raw.match(/(?:均分|平均分)?\s*(\d{2}(?:\.\d+)?)\s*(?:分|%)/i);
  if (percent) return Math.min(100, Number(percent[1]));
  return normalizeGpaScale(candidate) === "PERCENT_100" && Number.isFinite(supplied) && supplied > 0
    ? Math.min(100, supplied) : null;
}

function normalizeGpaScale(candidate) {
  const supplied = clean(candidate.gpaScale)?.toUpperCase();
  if (supplied && supplied !== "UNKNOWN") return supplied;
  const raw = clean(candidate.gpaRaw) || "";
  if (/\/\s*100\b|%|百分制/.test(raw)) return "PERCENT_100";
  if (/\/\s*5(?:\.0)?\b/.test(raw)) return "GPA_5";
  if (/\/\s*4(?:\.0)?\b/.test(raw)) return "GPA_4";
  return "UNKNOWN";
}

function normalizeLanguage(candidate) {
  const rawLanguageTest = clean(candidate.languageTest || candidate.languageType)?.toUpperCase() || null;
  const languageTest = rawLanguageTest?.includes("雅思") ? "IELTS"
    : rawLanguageTest?.includes("托福") ? "TOEFL"
      : rawLanguageTest;
  const languageScore = Number(candidate.languageScore);
  let languageScale = clean(candidate.languageScale)?.toUpperCase() || null;
  if (languageTest === "IELTS" && Number.isFinite(languageScore) && languageScore <= 9) {
    languageScale = "IELTS_9";
  }
  if (languageTest === "TOEFL" && Number.isFinite(languageScore) && (!languageScale
    || (languageScale === "TOEFL_IBT_6" && languageScore > 6)
    || (languageScale === "TOEFL_IBT_120" && languageScore <= 6))) {
    languageScale = languageScore <= 6 ? "TOEFL_IBT_6" : "TOEFL_IBT_120";
  }
  return {
    languageTest,
    languageScale,
    languageScore: Number.isFinite(languageScore) && languageScore > 0 ? languageScore : null
  };
}

export function inferOfferYear(pageText) {
  const text = String(pageText || "").normalize("NFKC");
  const patterns = [
    /(?:\u5f55\u53d6\u65f6\u95f4|\u5f55\u53d6\u65e5\u671f|offer\s*(?:date|time)|admission\s*(?:date|time))[：:\s]*[^\d]{0,12}(20\d{2})/i,
    /(?:commencement of (?:the )?study|program(?:me)? admission|program(?:me)? period)[^\n]{0,80}?\b(20\d{2})\b/i,
    /(20\d{2})\s*(?:\u5e74)?(?:\u7533\u8bf7\u5b63|\u5f55\u53d6\u5b63|\u5165\u5b66)/,
    /(?:\u7533\u8bf7\u5b63|\u5f55\u53d6\u5b63)[^\d]{0,6}(20\d{2})/,
    /(?:fall|autumn)\s*(20\d{2})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function inferCriticalOfferYear(verificationText, currentYear = new Date().getUTCFullYear()) {
  const contextual = inferOfferYear(verificationText);
  if (contextual) return contextual;
  const years = [...String(verificationText || "").normalize("NFKC").matchAll(/\b(20\d{2})\b/g)]
    .map(match => Number(match[1]))
    .filter(year => year >= currentYear - 4 && year <= currentYear + 1);
  const uniqueYears = [...new Set(years)];
  return uniqueYears.length === 1 ? uniqueYears[0] : null;
}

function isRecentOfferYear(value, currentYear = new Date().getUTCFullYear()) {
  const year = Number(value);
  return Number.isInteger(year) && year >= currentYear - 4 && year <= currentYear + 1;
}

export function criticalVerificationReasons(candidate, currentYear = new Date().getUTCFullYear()) {
  const reasons = [];
  const year = Number(candidate?.offerYear) || null;
  const language = normalizeLanguage(candidate || {});
  if (!year) reasons.push("offerYear-missing");
  if (!clean(candidate?.gpaRaw)) reasons.push("gpaRaw-missing");
  if (!language.languageTest || !language.languageScale || language.languageScore == null) {
    reasons.push("language-missing-or-invalid");
  }
  return reasons;
}

function searchableEvidence(text) {
  return String(text || "").normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

export function applyCriticalVerification(candidate, verificationText, metadata = {}) {
  const primaryYear = Number(candidate?.offerYear) || null;
  const secondaryYear = inferCriticalOfferYear(verificationText);
  const reasons = criticalVerificationReasons(candidate);
  const normalizedText = searchableEvidence(verificationText);
  const gpaRaw = clean(candidate?.gpaRaw);
  const language = normalizeLanguage(candidate || {});
  const evidenceNumbers = [...normalizedText.matchAll(/\d+(?:\s*\.\s*\d+)?/g)]
    .map(match => Number(match[0].replace(/\s+/g, "")));
  const gpaNumbers = [...String(gpaRaw || "").matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  const gpaSupported = !gpaRaw
    || normalizedText.includes(gpaRaw.normalize("NFKC").toLowerCase())
    || (gpaNumbers.length > 0 && evidenceNumbers.some(value => value === gpaNumbers[0]));
  const languageSupported = !language.languageScore
    || evidenceNumbers.some(value => value === Number(language.languageScore));
  let offerYear = primaryYear;
  let yearStatus = "not-checked";
  if (reasons.includes("offerYear-missing")) {
    if (isRecentOfferYear(secondaryYear)) {
      offerYear = secondaryYear;
      yearStatus = primaryYear === secondaryYear ? "verified" : "corrected";
    } else {
      yearStatus = secondaryYear === primaryYear ? "verified-outlier" : "conflict";
    }
  }
  const unresolved = [];
  if (reasons.includes("offerYear-missing") && !isRecentOfferYear(offerYear)) unresolved.push("offerYear");
  if (!gpaSupported) unresolved.push("gpaRaw");
  if (!languageSupported) unresolved.push("languageScore");
  const status = unresolved.length ? "conflict" : (yearStatus === "corrected" ? "corrected" : "verified");
  return {
    candidate: { ...candidate, offerYear },
    verification: {
      status,
      reasons,
      unresolved,
      model: metadata.model || null,
      checkedAt: new Date().toISOString(),
      evidenceExcerpt: String(verificationText || "").slice(0, 1200),
      fields: {
        offerYear: { primary: primaryYear, secondary: secondaryYear, resolved: offerYear, status: yearStatus },
        gpaRaw: { value: gpaRaw, supported: gpaSupported },
        languageScore: { value: language.languageScore, supported: languageSupported }
      }
    }
  };
}

export function inferGpaScale(candidate) {
  const explicit = normalizeGpaScale(candidate);
  if (explicit !== "UNKNOWN") return { value: explicit, confidence: "high", basis: "explicit-scale" };
  const raw = clean(candidate.gpaRaw) || "";
  const score = Number(raw.match(/\d+(?:\.\d+)?/)?.[0]);
  if (Number.isFinite(score) && score >= 60 && score <= 100) {
    return { value: "PERCENT_100", confidence: "medium", basis: "score-range-only" };
  }
  return null;
}

export function normalizeCandidate(candidate, sourceUrl) {
  const language = normalizeLanguage(candidate);
  const legacyExperienceInputs = [
    ["internship", candidate.internships], ["work", candidate.workExperience], ["research", candidate.research],
    ["competition", candidate.competitions], ["award", candidate.awards], ["patent", candidate.patents],
    ["project", candidate.projects]
  ].flatMap(([category, values]) => asArray(values).map(raw => ({ raw, category, result: null })));
  const experiences = normalizeExperiences([...(Array.isArray(candidate.experiences) ? candidate.experiences : []), ...legacyExperienceInputs])
    .filter((item, index, rows) => rows.findIndex(candidateItem => candidateItem.raw === item.raw && candidateItem.category === item.category) === index);
  const experienceText = (...categories) => experiences.filter(item => categories.includes(item.category)).map(item => item.raw);
  const targetInstitution = candidate.targetInstitutionId
    ? institutionMaster.find(item => item.id === candidate.targetInstitutionId) || resolveInstitution(candidate.targetUniversity)
    : resolveInstitution(candidate.targetUniversity);
  const targetProgramme = candidate.targetProgrammeId
    ? programmeMaster.find(item => item.id === candidate.targetProgrammeId) || resolveProgramme({
      universityName: candidate.targetUniversity,
      programmeName: candidate.targetProgramme,
      programmeEnglishName: candidate.targetProgrammeEnglishRaw
    })
    : resolveProgramme({
      universityName: candidate.targetUniversity,
      programmeName: candidate.targetProgramme,
      programmeEnglishName: candidate.targetProgrammeEnglishRaw
    });
  const undergraduateInstitution = resolveInstitution(candidate.undergraduateUniversity)
    || resolveReferenceInstitution(candidate.undergraduateUniversity);
  const rawSourceEvidence = candidate.sourceEvidence && typeof candidate.sourceEvidence === "object"
    ? candidate.sourceEvidence : {};
  const gpaScaleInference = inferGpaScale(candidate);
  const sourceEvidence = gpaScaleInference && normalizeGpaScale(candidate) === "UNKNOWN"
    ? { ...rawSourceEvidence, inferred: { ...rawSourceEvidence.inferred, gpaScale: gpaScaleInference } }
    : rawSourceEvidence;
  const normalized = {
    targetInstitutionId: targetInstitution?.id || null,
    targetProgrammeId: targetProgramme?.id || null,
    undergraduateInstitutionId: undergraduateInstitution?.id || null,
    undergraduateInstitutionSource: undergraduateInstitution?.source || (undergraduateInstitution ? "master" : null),
    targetUniversity: clean(candidate.targetUniversity),
    targetProgramme: clean(candidate.targetProgramme),
    targetProgrammeEnglishRaw: clean(candidate.targetProgrammeEnglishRaw),
    offerYear: Number(candidate.offerYear) || null,
    undergraduateUniversity: clean(candidate.undergraduateUniversity),
    undergraduateMajor: clean(candidate.undergraduateMajor),
    gpaRaw: clean(candidate.gpaRaw),
    gpaScale: normalizeGpaScale(candidate),
    gpa100: normalizeGpa(candidate),
    ...language,
    internships: unique([...asArray(candidate.internships), ...experienceText("internship")]),
    workExperience: unique([...asArray(candidate.workExperience), ...experienceText("work")]),
    research: unique([...asArray(candidate.research), ...experienceText("research", "paper")]),
    competitions: unique([...asArray(candidate.competitions), ...experienceText("competition")]),
    awards: unique([...asArray(candidate.awards), ...experienceText("award", "scholarship")]),
    patents: unique([...asArray(candidate.patents), ...experienceText("patent")]),
    projects: unique([...asArray(candidate.projects), ...experienceText("project", "course_design")]),
    experiences,
    auxiliaryScores: normalizeAuxiliaryScores(candidate.auxiliaryScores),
    sourceEvidence,
    sourcePublishedAt: clean(candidate.sourcePublishedAt),
    sourceUrl,
    collectedAt: new Date().toISOString()
  };
  normalized.fingerprint = candidateFingerprint(normalized);
  const review = validateCandidate(normalized);
  return { ...normalized, ...review };
}

export function filterCandidatesForProgrammes(candidates, programmeIds = []) {
  const allowed = new Set(asArray(programmeIds));
  if (!allowed.size) return candidates;
  return candidates.filter(candidate => allowed.has(candidate.targetProgrammeId));
}

export function filterCandidatesForProgramme(candidates, programmeId) {
  return filterCandidatesForProgrammes(candidates, programmeId ? [programmeId] : []);
}

export function cachedCasesMatchProgrammes(cases, programmeIds = []) {
  const allowed = new Set(asArray(programmeIds));
  if (!allowed.size || !Array.isArray(cases)) return false;
  return cases.some(candidate => {
    const resolved = candidate?.targetProgrammeId
      ? programmeMaster.find(programme => programme.id === candidate.targetProgrammeId)
      : resolveProgramme({
          universityName: candidate?.targetUniversity,
          programmeName: candidate?.targetProgramme,
          programmeEnglishName: candidate?.targetProgrammeEnglishRaw
        });
    return Boolean(resolved?.id && allowed.has(resolved.id));
  });
}

export function shouldSkipPagePrefilter(prefilter, options = {}) {
  if (prefilter?.decision !== "skip") return false;
  const staleReason = (prefilter.reasons || []).some(reason => String(reason).startsWith("source-before-2021:"));
  if (options.allowProgrammeInference
    && !staleReason
    && prefilter.headingInstitutionHits?.length
    && prefilter.directionGroups?.length
    && prefilter.enoughAdmissionFields
    && prefilter.detailUrl
    && !(prefilter.reasons || []).some(reason => String(reason).startsWith("explicit-programme-conflict:"))
    && !prefilter.reasons?.includes("peccn-offer-section-mismatch")) return false;
  return !options.trustedProgrammeId || staleReason;
}

export function candidatesForQueue(candidates, programmeIds = []) {
  const allowedProgrammes = new Set(asArray(programmeIds));
  if (!allowedProgrammes.size) return candidates;
  const allowedInstitutions = new Set(programmeMaster
    .filter(programme => allowedProgrammes.has(programme.id))
    .map(programme => programme.institutionId));
  return candidates.filter(candidate => allowedProgrammes.has(candidate.targetProgrammeId)
    || (!candidate.targetProgrammeId && allowedInstitutions.has(candidate.targetInstitutionId)));
}

function programmeTextMatchScore(programme, text) {
  const terms = unique([
    ...programmeSearchTerms(programme),
    ...(hksgProgrammeAliases[programme?.id] || [])
  ])
    .map(term => normalizePageSearchText(term))
    .filter(term => term.length >= 4);
  const hits = searchTermHit(normalizePageSearchText(text), terms);
  return hits.reduce((score, term) => Math.max(score, normalizePageSearchText(term).length), 0);
}

export function anchoredProgrammeId(candidate, requestedProgrammeIds, prefilter, sourceId) {
  if (sourceId !== "hksg-public-cases" || requestedProgrammeIds.length !== 1 || prefilter?.decision !== "pass") return null;
  const programme = programmeMaster.find(item => item.id === requestedProgrammeIds[0]);
  const institution = resolveInstitution(candidate?.targetUniversity);
  if (!programme || institution?.id !== programme.institutionId) return null;
  if (candidate?.targetProgrammeId && candidate.targetProgrammeId !== programme.id) return null;

  // A single-target HKSg crawl may contain a known programme title that is
  // more specific than the requested one (for example, "Signal Processing &
  // Machine Learning" also contains "Signal Processing"). Never let the
  // institution-only fallback overwrite that explicit programme evidence.
  const targetProgrammeText = [candidate?.targetProgramme, candidate?.targetProgrammeEnglishRaw]
    .filter(Boolean).join(" ");
  if (!targetProgrammeText.trim()) return programme.id;
  const sameInstitution = programmeMaster.filter(item => item.institutionId === programme.institutionId);
  const scored = sameInstitution
    .map(item => ({ id: item.id, score: programmeTextMatchScore(item, targetProgrammeText) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const bestScore = scored[0].score;
  const best = scored.filter(item => item.score === bestScore);
  return best.length === 1 && best[0].id === programme.id ? programme.id : null;
}

export function assessBatchQuality(report) {
  const pages = Array.isArray(report?.pages) ? report.pages : [];
  const completed = pages.filter(page => page.status === "completed");
  const failedPages = pages.filter(page => page.status === "failed").length;
  const modelPages = completed.filter(page => page.modelCalled);
  const structuredPages = completed.filter(page => page.extractionMethod === "structured-source");
  const sum = field => pages.reduce((total, page) => total + Number(page[field] || 0), 0);
  const extractedCases = sum("extracted");
  const scopedCases = sum("scoped");
  const preservedUnmatchedCases = sum("preservedUnmatched");
  const actionableExtractedCases = Math.max(scopedCases, extractedCases - preservedUnmatchedCases);
  const queuedCases = sum("queued");
  const duplicateCases = sum("duplicates");
  const candidates = pages.flatMap(page => {
    const rows = Array.isArray(page.candidates) ? page.candidates : [];
    const requested = Array.isArray(page.requestedProgrammeIds) ? page.requestedProgrammeIds.filter(Boolean) : [];
    return requested.length ? rows.filter(candidate => requested.includes(candidate.targetProgrammeId)) : rows;
  });
  const candidatesWithIssues = candidates.filter(candidate => (candidate.issues || []).length > 0).length;
  const totalTokens = Object.values(report?.usage || {}).reduce((total, usage) => total + Number(usage?.totalTokens || 0), 0);
  const targetMatchRate = actionableExtractedCases ? scopedCases / actionableExtractedCases : null;
  const duplicateRate = scopedCases ? duplicateCases / scopedCases : null;
  const issueRate = candidates.length ? candidatesWithIssues / candidates.length : null;
  const checks = [];
  const add = (code, status, detail) => checks.push({ code, status, detail });

  if (failedPages) add("page-failures", "review", `${failedPages} pages failed before completion`);
  if (!completed.length) add("no-completed-pages", "fail", "No page completed");
  if (structuredPages.length) add("structured-extraction", "pass", `${structuredPages.length} pages used deterministic source parsing without model tokens`);
  if (completed.length && !modelPages.length && !structuredPages.length) add("no-extraction-calls", "review", "All completed pages were skipped by the prefilter");
  if (targetMatchRate != null && targetMatchRate < 0.5) {
    add("target-match-rate", "fail", `Only ${(targetMatchRate * 100).toFixed(1)}% of extracted cases matched the requested programme`);
  } else if (targetMatchRate != null && targetMatchRate < 0.8) {
    add("target-match-rate", "review", `Only ${(targetMatchRate * 100).toFixed(1)}% of extracted cases matched the requested programme`);
  } else if (targetMatchRate != null) {
    add("target-match-rate", "pass", `${(targetMatchRate * 100).toFixed(1)}% of extracted cases matched the requested programme`);
  }
  if (issueRate != null && issueRate > 0) {
    add("candidate-issues", "review", `${candidatesWithIssues}/${candidates.length} new candidates require review`);
  } else if (candidates.length) {
    add("candidate-issues", "pass", "New candidates have no structural issues");
  }
  if (duplicateRate != null && duplicateRate > 0.75) {
    add("duplicate-rate", "review", `${(duplicateRate * 100).toFixed(1)}% of scoped cases were duplicates`);
  } else if (duplicateRate != null) {
    add("duplicate-rate", "pass", `${(duplicateRate * 100).toFixed(1)}% of scoped cases were duplicates`);
  }

  const status = checks.some(check => check.status === "fail")
    ? "fail"
    : checks.some(check => check.status === "review")
      ? "review"
      : "pass";
  return {
    status,
    recommendation: status === "pass"
      ? "可以继续下一批"
      : status === "review"
        ? "先人工查看本批报告，再决定是否继续"
        : "暂停扩张，先修复筛选或来源问题",
    metrics: {
      attemptedPages: pages.length,
      completedPages: completed.length,
      failedPages,
      skippedPages: completed.filter(page => page.skipped).length,
      modelCalls: modelPages.length,
      structuredPages: structuredPages.length,
      extractedCases,
      preservedUnmatchedCases,
      actionableExtractedCases,
      scopedCases,
      outOfScopeCases: extractedCases - scopedCases,
      queuedCases,
      duplicateCases,
      targetMatchRate,
      duplicateRate,
      candidatesWithIssues,
      issueRate,
      totalTokens,
      tokensPerModelCall: modelPages.length ? Math.round(totalTokens / modelPages.length) : 0
    },
    checks
  };
}

export function candidateFingerprint(candidate) {
  const normalizeIdentity = value => String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/gpa/gi, "")
    .replace(/[\s·•・,，.。()（）\-_/\\'’]/g, "");
  const normalizeGpa = value => {
    const match = String(value || "").match(/[-+]?\d+(?:\.\d+)?/);
    return match ? Number(match[0]).toFixed(4) : normalizeIdentity(value);
  };
  const identity = [
    candidate.targetUniversity,
    candidate.targetProgramme,
    candidate.offerYear,
    candidate.undergraduateUniversity,
    candidate.undergraduateMajor,
    candidate.gpa100 !== null && candidate.gpa100 !== undefined ? candidate.gpa100 : normalizeGpa(candidate.gpaRaw),
    candidate.languageTest,
    candidate.languageScale,
    candidate.languageScore
  ].map(normalizeIdentity).join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function validateCandidate(candidate) {
  const issues = [];
  const currentYear = new Date().getFullYear();
  if (!candidate.targetUniversity && !candidate.targetProgramme) issues.push("缺少录取项目");
  if (!candidate.targetProgrammeId) issues.push("项目未匹配主表");
  if (!candidate.undergraduateUniversity) issues.push("缺少本科院校");
  if (!candidate.undergraduateInstitutionId) issues.push("本科院校未匹配主表");
  if (!candidate.gpaRaw && candidate.gpa100 == null) issues.push("缺少GPA");
  if (candidate.gpa100 != null && (candidate.gpa100 < 50 || candidate.gpa100 > 100)) issues.push("GPA换算值异常");
  if (!candidate.languageTest || !candidate.languageScale || candidate.languageScore == null) {
    issues.push("缺少语言考试类型、分制或成绩");
  } else {
    const languageRanges = {
      IELTS_9: [0, 9],
      TOEFL_IBT_120: [0, 120],
      TOEFL_IBT_6: [0, 6],
      TOEFL_PBT_677: [310, 677]
    };
    const range = languageRanges[candidate.languageScale];
    if (!["IELTS", "TOEFL"].includes(candidate.languageTest)) issues.push("语言考试类型无法识别");
    if (!range || candidate.languageScore < range[0] || candidate.languageScore > range[1]) issues.push("语言成绩与分制不一致");
  }
  if (!candidate.offerYear) issues.push("缺少录取年份");
  else if (candidate.offerYear < 2000 || candidate.offerYear > currentYear + 1) issues.push("录取年份异常");
  const criticalVerification = candidate.sourceEvidence?.criticalVerification;
  if (["conflict", "unavailable"].includes(criticalVerification?.status)) {
    issues.push(`关键字段二次OCR未通过：${(criticalVerification.unresolved || criticalVerification.reasons || []).join(", ") || criticalVerification.status}`);
  }
  for (const field of candidate.sourceEvidence?.missing || []) issues.push(`网页正文无法定位字段：${field}`);
  const completeness = [candidate.targetUniversity || candidate.targetProgramme, candidate.undergraduateUniversity, candidate.gpaRaw || candidate.gpa100, candidate.languageScore, candidate.offerYear].filter(Boolean).length;
  return {
    completenessScore: Math.round(completeness / 5 * 100),
    reviewStatus: issues.length ? "needs-review" : "pending",
    issues
  };
}

export function discoverLinks(html, baseUrl, source) {
  const urls = new Set();
  const linkPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = linkPattern.exec(html))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!source.hosts.includes(url.hostname)) continue;
      if (!(source.detailRegexes || []).some(pattern => new RegExp(pattern).test(url.pathname))) continue;
      urls.add(canonicalizeCandidateUrl(url.href));
    } catch {}
  }
  return [...urls];
}

export function discoverEntryLinks(html, baseUrl, source) {
  const urls = new Set();
  const linkPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = linkPattern.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!source?.hosts?.includes(url.hostname)) continue;
      if (![...(source.entryRegexes || []), ...(source.paginationRegexes || [])].some(pattern => new RegExp(pattern).test(url.pathname))) continue;
      urls.add(canonicalizeCandidateUrl(url.href));
    } catch {}
  }
  return [...urls];
}

export function parseCompassDetailCandidates(html, baseUrl, source, programme) {
  const candidates = [];
  const linkPattern = /href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!source?.hosts?.includes(url.hostname)) continue;
      if (!(source.detailRegexes || []).some(pattern => new RegExp(pattern).test(url.pathname))) continue;
      url.href = canonicalizeCandidateUrl(url.href);
      const anchorText = stripHtml(match[2]).replace(/\s+/g, " ").trim();
      const scored = scoreSearchCandidate({ url: url.href, kind: "detail", anchorText }, programme, source);
      candidates.push({ ...scored, anchorText });
    } catch {}
  }
  return [...new Map(candidates
    .sort((a, b) => {
      const aTarget = a.institutionHits?.length && a.programmeHits?.length ? 1 : 0;
      const bTarget = b.institutionHits?.length && b.programmeHits?.length ? 1 : 0;
      return bTarget - aTarget || b.score - a.score || a.url.localeCompare(b.url);
    })
    .map(candidate => [candidate.url, candidate])).values()];
}

export async function loadSources(path = defaultConfigPath) {
  const config = JSON.parse(await readFile(path, "utf8"));
  return config.sources.filter(source => source.enabled);
}

function sourceForUrl(url, sources) {
  const hostname = new URL(url).hostname;
  return sources.find(source => (source.hosts || []).includes(hostname));
}

function eicProgrammeTerms(programme) {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  return unique([
    programme?.nameEn,
    ...(programme?.aliases || []),
    programme?.nameZh,
    institution?.nameEn,
    ...(institution?.aliases || []),
    institution?.nameZh
  ]).filter(term => normalizePageSearchText(term).length >= 3);
}

export function scoreIndexedCaseForProgramme(record, programme) {
  const programmeTerms = programmeSearchTerms(programme);
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const programmeText = normalizePageSearchText([
    record?.caseName, record?.majorName, record?.majorNameCn
  ].filter(Boolean).join(" "));
  const institutionText = normalizePageSearchText([
    record?.schoolNameCn, record?.schoolNameEn, record?.country
  ].filter(Boolean).join(" "));
  const programmeHits = searchTermHit(programmeText, programmeTerms);
  const institutionHits = searchTermHit(institutionText, unique([
    institution?.nameZh, institution?.nameEn, ...(institution?.aliases || [])
  ]));
  const majorType = normalizePageSearchText(record?.majorType);
  const isMaster = /硕士|master|msc|m\.sc\.?/i.test(`${record?.courseTypeName || ""} ${record?.majorName || ""}`);
  const hasUndergraduate = Boolean(record?.graduateSchool && record?.graduateMajor);
  const hasGpa = Boolean(record?.averageScore);
  const score = programmeHits.length * 5 + institutionHits.length * 4
    + (isMaster ? 2 : 0) + (hasUndergraduate ? 2 : 0) + (hasGpa ? 2 : 0)
    + (/工科|理科|computer|engineering|science|technology/i.test(majorType) ? 1 : 0);
  return {
    decision: programmeHits.length && institutionHits.length && isMaster ? "pass" : "skip",
    score,
    programmeHits,
    institutionHits,
    isMaster,
    hasUndergraduate,
    hasGpa
  };
}

export function normalizeEicIndexedCase(record, programme, detailPath) {
  const sourceUrl = `${detailPath.replace(/\/$/, "")}/${record.id}`;
  const sourcePublishedAt = record.offerUploadDate || record.passDate || null;
  const offerYear = Number(String(sourcePublishedAt || record.passDate || "").slice(0, 4)) || null;
  const gpaRaw = record.averageScore || null;
  const gpaScale = /\/\s*4(?:\.0)?\b/i.test(gpaRaw || "") ? "GPA_4"
    : /\/\s*5(?:\.0)?\b/i.test(gpaRaw || "") ? "GPA_5"
      : /\/\s*100\b|%|百分制/i.test(gpaRaw || "") || /^\d+(?:\.\d+)?$/.test(gpaRaw || "") ? "PERCENT_100" : "UNKNOWN";
  return {
    sourceUrl,
    targetUniversity: record.schoolNameCn || record.schoolNameEn || null,
    targetProgramme: record.majorNameCn || record.majorName || null,
    targetProgrammeEnglishRaw: record.majorName || null,
    offerYear,
    undergraduateUniversity: record.graduateSchool || null,
    undergraduateMajor: record.graduateMajor || null,
    gpaRaw,
    gpaScale,
    gpa100: gpaScale === "PERCENT_100" ? Number(gpaRaw?.match(/\d+(?:\.\d+)?/)?.[0]) || null : null,
    languageTest: null,
    languageScale: null,
    languageScore: null,
    experiences: (Array.isArray(record.backgrounds) ? record.backgrounds : []).map(item => ({
      raw: item?.name || item,
      category: /research|科研/i.test(`${item?.type || ""} ${item?.typeName || ""}`) ? "research"
        : /award|奖项|scholarship|奖学金/i.test(`${item?.type || ""} ${item?.typeName || ""}`) ? "award"
          : /work|工作|intern/i.test(`${item?.type || ""} ${item?.typeName || ""}`) ? "work" : "unknown",
      result: null
    })),
    auxiliaryScores: [{ test: "SCHOOL_TIER", scoreRaw: asArray(record.graduateSchoolTag).join("/") }]
      .filter(item => item.scoreRaw),
    sourcePublishedAt,
    targetProgrammeId: programme?.id || null,
    targetInstitutionId: programme?.institutionId || null,
    sourceEvidence: {
      matched: {
        targetUniversity: true,
        targetProgramme: true,
        undergraduateUniversity: Boolean(record.graduateSchool),
        undergraduateMajor: Boolean(record.graduateMajor),
        gpaRaw: Boolean(gpaRaw),
        offerYear: Boolean(offerYear)
      },
      missing: [],
      indexed: true,
      indexRecordId: String(record.id)
    }
  };
}

async function fetchEicJson(url, body = null) {
  const response = await fetch(url, withHttpTimeout({
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json", Origin: "https://www.eic.org.cn", Referer: "https://www.eic.org.cn/case?page=1" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  }));
  if (!response.ok) throw new Error(`EIC API 请求失败 ${response.status}`);
  return response.json();
}

export async function discoverEicCaseRecords(programme, source, { pageNo = 1, pageSize = 10, fetchJson = fetchEicJson } = {}) {
  const api = source?.api;
  if (api?.kind !== "eic-case-library") return { records: [], total: 0, pageNo, pageSize };
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const schoolName = institution?.nameEn || institution?.nameZh || "";
  const payload = await fetchJson(`${api.baseUrl}${api.listPath}`, { schoolName, pageNo, pageSize });
  const data = payload?.data || {};
  const records = Array.isArray(data.records) ? data.records : [];
  const scored = records.map(record => ({ record, match: scoreIndexedCaseForProgramme(record, programme) }))
    .filter(item => item.match.decision === "pass");
  return { records: scored, total: Number(data.total || 0), pageNo, pageSize };
}

function hksgSearchTerms(programme) {
  const chinese = unique([
    programme?.nameZh,
    ...(programme?.aliases || []),
    ...(hksgProgrammeAliases[programme?.id] || [])
  ])
    .filter(value => /[\u3400-\u9fff]/u.test(String(value)))
    .map(value => String(value)
      .replace(/(?:理学|工学)?硕士(?:学位)?/g, "")
      .replace(/(?:项目|课程)$/g, "")
      .trim())
    .filter(value => value.length >= 2);
  const focusTerms = unique((programme?.focusTags || []).flatMap(tag => ({
    computer: ["计算机科学"],
    software: ["软件工程"],
    cybersecurity: ["网络安全"],
    electronic: ["电子工程", "电子信息"],
    "integrated-circuit": ["集成电路设计", "集成电路"],
    communication: ["通信工程"],
    signal: ["信号处理"],
    data: ["数据科学"],
    ai: ["人工智能"],
    robotics: ["机器人"],
    automation: ["自动化"],
    mechanical: ["机械工程", "机械"],
    manufacturing: ["智能制造", "制造工程", "制造"]
  }[tag] || [])));
  return unique([...chinese, ...focusTerms]).filter(value => value.length >= 2).slice(0, 6);
}

const hksgInstitutionAliases = {
  ntu: ["南洋理工大学", "南洋理工大學", "Nanyang Technological University", "NTU"],
  nus: ["新加坡国立大学", "新加坡國立大學", "National University of Singapore", "NUS"],
  hku: ["香港大学", "香港大學", "The University of Hong Kong", "University of Hong Kong", "HKU"],
  cuhk: ["香港中文大学", "香港中文大學", "The Chinese University of Hong Kong", "CUHK"],
  hkust: ["香港科技大学", "香港科技大學", "The Hong Kong University of Science and Technology", "HKUST"],
  "cityu-hk": ["香港城市大学", "香港城市大學", "City University of Hong Kong", "CityU"],
  "polyu-hk": ["香港理工大学", "香港理工大學", "The Hong Kong Polytechnic University", "PolyU"]
};

const hksgProgrammeAliases = {
  "ntu-communications": ["通信工程", "通讯工程", "通信工程理学硕士", "通讯工程理学硕士", "MSc in Communications Engineering", "MSc in Communication Engineering", "Communications Engineering", "Communication Engineering"],
  "ntu-electronics": ["电子学", "电子学硕士", "电子学理学硕士", "集成电路与微电子", "集成电路与微电子学", "MSc in Electronics", "MSc in Integrated Circuits and Microelectronics"],
  "ntu-master-of-science-integrated-circuit-design": ["集成电路设计", "集成电路设计理学硕士", "Master of Science (Integrated Circuit Design)"],
  "ntu-master-of-science-cyber-security": ["网络安全", "网络安全理学硕士", "网络安全硕士", "Cyber Security", "Cybersecurity"],
  "ntu-master-of-science-signal-processing": ["信号处理", "信号处理理学硕士", "Signal Processing"],
  "ntu-master-of-science-signal-processing-machine-learning": ["信号处理与机器学习", "信号处理和机器学习", "Signal Processing & Machine Learning", "Signal Processing and Machine Learning"],
  "nus-master-of-computing": ["Master of Computing", "计算机硕士", "计算机理学硕士"],
  "hku-master-of-science-in-computer-science-cyber-security-stream": ["网络安全", "计算机科学网络安全", "Cyber Security", "Cybersecurity"],
  "ntu-master-of-science-information-systems": ["信息系统", "Information Systems", "Information System"],
  "ntu-master-of-science-applied-materials-analytics": ["应用材料分析", "材料分析", "Applied Materials Analytics", "Materials Analytics"],
  "nus-master-of-science-artificial-intelligence-innovation": ["人工智能创新", "AI Innovation", "Artificial Intelligence Innovation"],
  "nus-master-of-science-artificial-intelligence-for-science": ["人工智能与科学", "人工智能和科学", "Artificial Intelligence for Science"],
  "nus-master-of-technology-in-artificial-intelligence-systems": ["人工智能系统技术", "人工智能系统", "Artificial Intelligence Systems"],
  "nus-master-of-science-in-applied-data-science": ["应用数据科学", "Applied Data Science"],
  "polyu-hk-artificial-intelligence-and-big-data-computing": ["人工智能与大数据计算", "人工智能和大数据计算", "Artificial Intelligence and Big Data Computing"],
  "polyu-hk-cybersecurity": ["网络安全", "Cybersecurity", "Cyber Security"],
  "polyu-hk-mathematics-for-artificial-intelligence-technology": ["人工智能技术数学", "人工智能技术的数学", "Mathematics for Artificial Intelligence Technology"],
  "cityu-hk-msc-cybersecurity": ["网络安全", "信息安全", "MSc Cybersecurity", "Cyber Security", "Cybersecurity"],
  "cityu-hk-msc-artificial-intelligence-for-sciences": ["人工智能与科学", "人工智能和科学", "Artificial Intelligence for Sciences"],
  "cityu-hk-msc-data-science": ["数据科学", "Data Science"]
};

// The alias-mapping job writes high-confidence HKSg names to this file. Load
// them into the runtime matcher so the mapping work actually improves source
// recall; lower-confidence rows stay out of strict matching.
try {
  const generated = JSON.parse(readFileSync(resolve(collectorRoot, "data", "programme-alias-map.json"), "utf8"));
  for (const mapping of generated.mappings || []) {
    if (mapping.confidence !== "high" || !mapping.programmeId || !mapping.sourceName) continue;
    hksgProgrammeAliases[mapping.programmeId] = unique([
      ...(hksgProgrammeAliases[mapping.programmeId] || []),
      mapping.sourceName
    ]);
  }
} catch {}

function hksgProgrammeTerms(programme) {
  return unique([
    ...(hksgProgrammeAliases[programme?.id] || []),
    ...(programme?.strictMatchTerms || []),
    programme?.nameEn,
    programme?.nameZh,
    ...(programme?.aliases || [])
  ]).filter(term => normalizePageSearchText(term).length >= 4);
}

export function scoreHksgIndexedCaseForProgramme(record, programme, { allowDirectionOnly = false } = {}) {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionText = normalizePageSearchText(record?.university_name);
  const majorText = normalizePageSearchText(record?.major_name);
  const titleText = normalizePageSearchText(record?.title);
  const institutionHits = searchTermHit(institutionText, unique([
    institution?.nameZh,
    institution?.nameEn,
    ...(institution?.aliases || []),
    ...(hksgInstitutionAliases[programme?.institutionId] || [])
  ]));
  const programmeTerms = hksgProgrammeTerms(programme);
  const majorHits = searchTermHit(majorText, programmeTerms);
  const titleHits = searchTermHit(titleText, programmeTerms);
  const genericMajor = !majorText
    || /^(?:硕士|理学硕士|master|msc|研究生)$/i.test(majorText)
    || /^计算机科学硕士\s*通用方向$/i.test(majorText)
    || /^computer science\s*master$/i.test(majorText);
  const excludedTerms = programme?.id === "ntu-master-of-science-signal-processing"
    ? ["机器学习", "machine learning"]
    : [];
  const excludedHits = searchTermHit(normalizePageSearchText(`${record?.major_name || ""} ${record?.title || ""}`), excludedTerms);
  const programmeHits = majorHits.length ? majorHits : (genericMajor ? titleHits : []);
  const resolvedProgramme = resolveHksgIndexedProgramme(record);
  const genericMajorLabel = /\u901a\u7528\u65b9\u5411|general\s*(?:stream|track)|generic/i.test(String(record?.major_name || ""));
  const effectiveResolvedProgramme = genericMajorLabel && titleHits.length > 0 ? null : resolvedProgramme;
  const competingProgrammeIdsFound = effectiveResolvedProgramme?.id === programme?.id
    ? []
    : competingProgrammeIds(programme, `${record?.major_name || ""} ${record?.title || ""}`);
  const exactResolution = institutionHits.length > 0
    && programmeHits.length > 0
    && excludedHits.length === 0
    && (!effectiveResolvedProgramme || effectiveResolvedProgramme.id === programme?.id)
    && competingProgrammeIdsFound.length === 0;
  const directionHits = searchTermHit(`${majorText} ${titleText}`, unique([
    ...(programme?.discoveryTerms?.short || []),
    ...(programme?.discoveryTerms?.focus || []),
    ...(programme?.focusTags || []).flatMap(tag => directionKeywords[tag] || [])
  ]));
  const directionOnly = allowDirectionOnly && institutionHits.length > 0 && directionHits.length > 0
    && excludedHits.length === 0 && !effectiveResolvedProgramme && competingProgrammeIdsFound.length === 0
    && /offer|admission|\u5f55\u53d6|\u6848\u4f8b/i.test(`${titleText} ${record?.enroll || ""}`);
  return {
    decision: exactResolution ? "pass" : directionOnly ? "direction-only" : "skip",
    exactResolution,
    institutionHits,
    programmeHits,
    majorHits,
    titleHits,
    directionHits,
    resolvedProgrammeId: effectiveResolvedProgramme?.id || null,
    competingProgrammeIds: competingProgrammeIdsFound,
    genericMajor,
    excludedHits
  };
}

export function scoreMastermateIndexedCaseForProgramme(record, programme, { allowDirectionOnly = false } = {}) {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionText = normalizePageSearchText(record?.university?.name || record?.university_name);
  const resolvedProgramme = resolveProgramme({
    universityName: record?.university?.name || record?.university_name,
    programmeName: record?.major_name,
    programmeEnglishName: record?.major_ename
  });
  const programmeText = normalizePageSearchText([
    record?.major_name,
    record?.major_ename
  ].filter(Boolean).join(" "));
  const institutionHits = searchTermHit(institutionText, unique([
    institution?.nameZh,
    institution?.nameEn,
    ...(institution?.aliases || [])
  ]));
  const programmeHits = searchTermHit(programmeText, unique([
    programme?.nameZh,
    programme?.nameEn,
    ...(programme?.aliases || []),
    ...(programme?.strictMatchTerms || [])
  ]));
  const directionHits = searchTermHit(programmeText, unique([
    ...(programme?.discoveryTerms?.short || []),
    ...(programme?.discoveryTerms?.focus || []),
    ...(programme?.focusTags || []).flatMap(tag => directionKeywords[tag] || [])
  ]));
  const isOffer = /\u5f55\u53d6|offer|admission/i.test(String(record?.enroll || ""));
  const resolutionConflict = Boolean(resolvedProgramme && resolvedProgramme.id !== programme?.id);
  const competingProgrammeIdsFound = competingProgrammeIds(programme, programmeText);
  const directionOnly = allowDirectionOnly && institutionHits.length > 0 && directionHits.length > 0
    && isOffer && !resolutionConflict && competingProgrammeIdsFound.length === 0;
  return {
    decision: institutionHits.length > 0 && programmeHits.length > 0 && isOffer
      && !resolutionConflict && competingProgrammeIdsFound.length === 0
      ? "pass" : directionOnly ? "direction-only" : "skip",
    institutionHits,
    programmeHits,
    directionHits,
    isOffer,
    resolvedProgrammeId: resolvedProgramme?.id || null,
    resolutionConflict,
    competingProgrammeIds: competingProgrammeIdsFound
  };
}

export async function discoverMastermateCaseCandidates(programme, source, { fetchImpl = fetch, maxResults = 20, maxRequests = 4, searchPlan = null, allowDirectionOnly = false } = {}) {
  const search = source?.search;
  if (search?.kind !== "mastermate-api") return { urls: [], entryUrls: [], attempts: [], requestCount: 0, maxRequests };
  const baseUrl = search.baseUrl || "https://www.mastermate.cn";
  const homeUrl = new URL(search.admissionPath || "/admission", baseUrl).href;
  const headers = { "User-Agent": userAgent, Accept: "text/html" };
  const home = await fetchImpl(homeUrl, withHttpTimeout({ headers }));
  if (!home.ok) throw new Error(`Mastermate home request failed ${home.status}`);
  const html = await home.text();
  const token = String(html).match(/name=["']csrf-token["'] content=["']([^"']+)/i)?.[1];
  if (!token) throw new Error("Mastermate CSRF token unavailable");
  const cookie = (home.headers?.getSetCookie?.() || []).map(value => value.split(";")[0]).join("; ");
  const deterministicTerms = unique([
    programme?.nameZh,
    programme?.nameEn,
    ...(programme?.aliases || []),
    ...(programme?.sourceSearchTerms?.[source.id]?.exact || []),
    ...(programme?.discoveryTerms?.exact || []),
    ...(programme?.discoveryTerms?.short || []),
    ...(programme?.discoveryTerms?.focus || [])
  ]).filter(term => String(term).length >= 2);
  const plannerTerms = cleanSearchPlannerTerms(searchPlan?.queryTerms || []);
  const chineseTerms = terms => terms.filter(term => /[^\x00-\x7F]/.test(term));
  // Mastermate indexes Chinese titles most reliably, but English-only master
  // data still needs a fallback query when the planner is unavailable.
  // The planner is useful for aliases, but its exact phrases often return no
  // rows on this API. Spend the small request budget on deterministic short
  // programme terms first, then use planner variants as fallback.
  const terms = unique([
    ...chineseTerms(deterministicTerms),
    ...deterministicTerms,
    ...chineseTerms(plannerTerms),
    ...plannerTerms
  ]);
  const chinese = terms.filter(term => /[^\x00-\x7F]/.test(term));
  const english = terms.filter(term => !/[^\x00-\x7F]/.test(term));
  const interleavedTerms = [];
  for (let index = 0; index < Math.max(chinese.length, english.length); index += 1) {
    if (chinese[index]) interleavedTerms.push(chinese[index]);
    if (english[index]) interleavedTerms.push(english[index]);
  }
  const districts = asArray(search.districtIds?.length ? search.districtIds : [1, 4]);
  const attempts = [];
  const urls = new Set();
  let requestCount = 0;
  const seenRows = new Set();
  const maxPagesPerQuery = Math.max(1, Number(search.maxPagesPerQuery || 2));
  const districtPattern = districts.length === 2 ? [0, 1, 1, 0] : districts.map((_, index) => index);
  const primaryQueries = interleavedTerms.map((term, index) => ({
    term,
    districtId: districts[districtPattern[index % districtPattern.length]],
    page: 1
  }));
  const secondaryQueries = interleavedTerms.flatMap((term, index) => districts
    .filter((_, districtIndex) => districtIndex !== districtPattern[index % districtPattern.length])
    .map(districtId => ({ term, districtId, page: 1 })));
  const pendingQueries = [...primaryQueries, ...secondaryQueries];
  while (pendingQueries.length && requestCount < Math.max(1, maxRequests)) {
      const { term, districtId, page } = pendingQueries.shift();
      const apiUrl = new URL(search.apiPath || "/mm_api/admission", baseUrl);
      apiUrl.searchParams.set("page", String(page));
      try {
        requestCount += 1;
        const response = await fetchImpl(apiUrl.href, withHttpTimeout({
          method: "POST",
          headers: {
            ...headers,
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": token,
            Cookie: cookie,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ words: term, district_id: Number(districtId), rank_id: 0 })
        }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const matched = rows.filter(row => {
          if (!row?.id || seenRows.has(String(row.id))) return false;
          seenRows.add(String(row.id));
          const scored = scoreMastermateIndexedCaseForProgramme(row, programme, { allowDirectionOnly });
          return scored.decision === "pass" || scored.decision === "direction-only";
        });
        for (const row of matched) urls.add(`${baseUrl.replace(/\/$/, "")}/admission/${row.id}`);
        attempts.push({ kind: "api", term, districtId, page, found: rows.length, matched: matched.length });
        if (rows.length > 0 && payload?.next_page_url && page < maxPagesPerQuery) {
          pendingQueries.unshift({ term, districtId, page: page + 1 });
        }
      } catch (error) {
        attempts.push({ kind: "api", term, districtId, page, error: error.message });
      }
  }
  return { urls: [...urls].slice(0, maxResults), entryUrls: [], attempts, requestCount, maxRequests };
}

function scoreCompassIndexLinks(links, source, programme, searchPlan = null) {
  const candidates = [];
  const plannerTerms = cleanSearchPlannerTerms(searchPlan?.queryTerms || []);
  for (const link of links) {
    try {
      const url = new URL(canonicalizeCandidateUrl(link.url));
      if (!source?.hosts?.includes(url.hostname)) continue;
      const isEntry = (source.entryRegexes || []).some(regex => new RegExp(regex).test(url.pathname));
      if (!isEntry) continue;
      const scored = scoreSearchCandidate({
        url: url.href,
        kind: "seed",
        anchorText: link.anchorText
      }, programme, source);
      const plannerHits = searchTermHit(
        normalizePageSearchText(`${url.href} ${link.anchorText}`),
        plannerTerms
      );
      // The global Compass index contains many same-school categories. A
      // generic institution/case score is insufficient here; the category
      // title must explicitly contain a target-programme term.
      const accepted = !scored.conflictProgrammeIds.length
        && scored.institutionHits.length > 0
        && (scored.programmeHits.length > 0 || plannerHits.length > 0);
      if (accepted) candidates.push({ ...scored, accepted: true, plannerHits });
    } catch {}
  }
  return [...new Map(candidates
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .map(candidate => [candidate.url, candidate])).values()];
}

export function parseCompassIndexCandidates(html, baseUrl, source, programme, searchPlan = null) {
  return scoreCompassIndexLinks(extractCompassIndexLinks(html, baseUrl, source), source, programme, searchPlan);
}

function extractCompassIndexLinks(html, baseUrl, source) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!source?.hosts?.includes(url.hostname)) continue;
      links.push({ url: url.href, anchorText: stripHtml(match[2]) });
    } catch {}
  }
  return links;
}

async function readCompassIndexCache(expectedIndexPath) {
  try {
    const cached = JSON.parse(await readFile(compassIndexCachePath, "utf8"));
    const maxAgeMs = Math.max(1, Number(process.env.COLLECTOR_COMPASS_INDEX_CACHE_DAYS || 7)) * 24 * 60 * 60 * 1000;
    return cached.indexPath === expectedIndexPath
      && Date.now() - Date.parse(cached.updatedAt || 0) <= maxAgeMs
      && Array.isArray(cached.links)
      ? cached
      : null;
  } catch {
    return null;
  }
}

export async function discoverCompassCaseCandidates(programme, source, { fetchImpl = fetch, maxResults = 20, maxRequests = 1, searchPlan = null } = {}) {
  const search = source?.search;
  if (search?.kind !== "compass-index" || maxRequests < 1) return { urls: [], entryUrls: [], attempts: [], requestCount: 0, maxRequests };
  const baseUrl = search.baseUrl || "https://www.compassedu.hk";
  const indexPath = search.indexPath || "/offers";
  const cached = await readCompassIndexCache(indexPath);
  if (cached) {
    const candidates = scoreCompassIndexLinks(cached.links, source, programme, searchPlan).slice(0, maxResults);
    return {
      urls: [],
      entryUrls: candidates.map(candidate => candidate.url),
      attempts: [{ kind: "compass-index-cache", url: cached.indexUrl || null, found: candidates.length, cachedLinks: cached.links.length, candidates }],
      requestCount: 0,
      maxRequests
    };
  }
  const pageCount = Math.max(1, Number(search.maxPages || maxRequests || 1));
  const pageParam = search.pageParam || "page";
  const pageUrls = Array.from({ length: pageCount }, (_, index) => {
    const url = new URL(indexPath, baseUrl);
    if (pageCount > 1) url.searchParams.set(pageParam, String(index + 1));
    return url.href;
  });
  try {
    const pages = await Promise.all(pageUrls.map(async url => {
      const response = await fetchImpl(url, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "text/html" } }));
      if (!response.ok) throw new Error(`Compass index request failed ${response.status}`);
      const html = await response.text();
      return extractCompassIndexLinks(html, url, source);
    }));
    const links = [...new Map(pages.flatMap(page => page.map(candidate => ({ url: candidate.url, anchorText: candidate.anchorText || "" }))).map(link => [link.url, link])).values()];
    await mkdir(dirname(compassIndexCachePath), { recursive: true });
    await writeFile(compassIndexCachePath, JSON.stringify({ indexPath, updatedAt: new Date().toISOString(), links }, null, 2), "utf8");
    const candidates = scoreCompassIndexLinks(links, source, programme, searchPlan).slice(0, maxResults);
    return {
      urls: [],
      entryUrls: candidates.map(candidate => candidate.url),
      attempts: [{ kind: "compass-index", url: indexPath, found: candidates.length, indexedLinks: links.length, pages: pageCount, candidates }],
      requestCount: pageCount,
      maxRequests
    };
  } catch (error) {
    return { urls: [], entryUrls: [], attempts: [{ kind: "compass-index", url: indexPath, pages: pageCount, error: error.message }], requestCount: pageCount, maxRequests };
  }
}

export function resolveHksgIndexedProgramme(record, programmeList = programmeMaster) {
  const institution = resolveInstitution(record?.university_name);
  if (!institution) return null;
  const rawMajor = String(record?.major_name || "").trim();
  if (!rawMajor) return null;
  const normalizedMajor = normalizeMasterName(rawMajor);
  const candidates = programmeList.filter(programme => programme.institutionId === institution.id);
  const exact = candidates.find(programme => [
    programme.nameZh,
    programme.nameEn,
    ...(programme.aliases || []),
    ...(hksgProgrammeAliases[programme.id] || [])
  ]
    .filter(Boolean).map(normalizeMasterName).includes(normalizedMajor));
  if (exact) return exact;
  const stripped = normalizedMajor.replace(/通用方向$|电力工程方向$|通信工程方向$/i, "");
  return candidates.find(programme => [
    programme.nameZh,
    programme.nameEn,
    ...(programme.aliases || []),
    ...(hksgProgrammeAliases[programme.id] || [])
  ]
    .filter(Boolean).map(normalizeMasterName).some(alias => alias.length >= 6 && stripped.includes(alias))) || null;
}

async function fetchHksgJson(url) {
  const response = await fetch(url, withHttpTimeout({
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
      Referer: "https://m.hksg.org/offer",
      "X-Requested-With": "XMLHttpRequest"
    }
  }));
  if (!response.ok) throw new Error(`HKSg search request failed ${response.status}`);
  return response.json();
}

export function parseHksgLinkCandidates(html, baseUrl, source, programme, kind = "seed") {
  const urls = new Set();
  const pattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionTerms = unique([
    institution?.nameZh,
    institution?.nameEn,
    ...(institution?.aliases || [])
  ]);
  const programmeTerms = hksgProgrammeTerms(programme);
  const pageText = normalizePageSearchText(stripHtml(html));
  const pageHasTarget = searchTermHit(pageText, institutionTerms).length > 0
    && searchTermHit(pageText, programmeTerms).length > 0;
  let match;
  while ((match = pattern.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (!source?.hosts?.includes(url.hostname)) continue;
      const matchesKind = kind === "detail"
        ? (source.detailRegexes || []).some(regex => new RegExp(regex).test(url.pathname))
        : (source.entryRegexes || []).some(regex => new RegExp(regex).test(url.pathname));
      if (!matchesKind) continue;
      const text = normalizePageSearchText(stripHtml(match[2]));
      const linkHasTarget = searchTermHit(text, institutionTerms).length > 0
        && searchTermHit(text, programmeTerms).length > 0;
      // HKSg major pages render offer cards as empty/icon-only anchors. When
      // the page itself is the requested programme, retain those detail URLs;
      // non-empty conflicting cards still require their own title match.
      const contextualDetail = kind === "detail" && !text && pageHasTarget;
      if (!linkHasTarget && !contextualDetail) continue;
      url.href = canonicalizeCandidateUrl(url.href);
      urls.add(url.href);
    } catch {}
  }
  return [...urls];
}

export async function discoverHksgCaseCandidates(programme, source, { fetchImpl = fetch, maxResults = 20, maxRequests = 10, searchPlan = null, allowDirectionOnly = false } = {}) {
  const search = source?.search;
  if (search?.kind !== "hksg-web") return { urls: [], entryUrls: [], attempts: [] };
  const terms = unique([...hksgSearchTerms(programme), ...(searchPlan?.queryTerms || [])]);
  const attempts = [];
  const urls = new Set();
  const entryUrls = new Set();
  const matchByUrl = new Map();
  const apiBase = search.apiBaseUrl || "https://m.hksg.org";
  const apiPath = search.apiPath || "/offer/list_data";
  let requestCount = 0;
  for (const term of terms) {
    if (requestCount >= maxRequests) break;
    const apiUrl = new URL(apiPath, apiBase);
    for (const [key, value] of Object.entries({ keywords: term, country_id: "", major_sort: "", school: "", gpa: "", page: "1", limit: "100" })) {
      apiUrl.searchParams.set(key, value);
    }
    try {
      requestCount += 1;
      const response = await fetchImpl(apiUrl.href, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "application/json", Referer: "https://m.hksg.org/offer", "X-Requested-With": "XMLHttpRequest" } }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const matched = rows.filter(row => {
        const decision = scoreHksgIndexedCaseForProgramme(row, programme, { allowDirectionOnly }).decision;
        return decision === "pass" || decision === "direction-only";
      });
      for (const row of matched) {
        if (!row?.id) continue;
        const url = canonicalizeCandidateUrl(`https://m.hksg.org/offer_${row.id}`);
        const decision = scoreHksgIndexedCaseForProgramme(row, programme, { allowDirectionOnly }).decision;
        urls.add(url);
        const current = matchByUrl.get(url);
        if (!current || (decision === "pass" && current.decision !== "pass")) {
          matchByUrl.set(url, { decision, programmeId: decision === "pass" ? programme.id : null });
        }
      }
      attempts.push({ kind: "api", term, found: rows.length, matched: matched.length });
    } catch (error) {
      attempts.push({ kind: "api", term, error: error.message });
    }
  }
  const webBase = search.baseUrl || "https://www.hksg.org";
  for (const term of terms.slice(0, 4)) {
    for (const [kind, path] of [["seed", search.majorPath || "/major"], ["detail", search.offerPath || "/offer"]]) {
      if (requestCount >= maxRequests) break;
      const url = new URL(path, webBase);
      url.searchParams.set("keywords", term);
      try {
        requestCount += 1;
        const response = await fetchImpl(url.href, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const found = parseHksgLinkCandidates(html, webBase, source, programme, kind);
        for (const candidate of found) (kind === "detail" ? urls : entryUrls).add(candidate);
        attempts.push({ kind: `web-${kind}`, term, found: found.length });
      } catch (error) {
        attempts.push({ kind: `web-${kind}`, term, error: error.message });
      }
    }
    if (requestCount >= maxRequests) break;
  }
  return {
    urls: [...urls].slice(0, maxResults),
    entryUrls: [...entryUrls].slice(0, maxResults),
    matchByUrl: Object.fromEntries(matchByUrl),
    attempts,
    requestCount,
    maxRequests
  };
}

function searchTermsForProgramme(programme) {
  const rawTerms = unique([
    programme?.nameEn,
    ...(programme?.aliases || []),
    programme?.nameZh
  ]).filter(term => String(term).trim().length >= 2);
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionTerms = unique([institution?.nameEn, institution?.nameZh, ...(institution?.aliases || [])])
    .filter(term => String(term).trim().length >= 2);
  const english = rawTerms.filter(term => /[A-Za-z]/.test(String(term)));
  const nonEnglish = rawTerms.filter(term => /[^\x00-\x7F]/.test(String(term)));
  return unique([
    ...english,
    ...nonEnglish,
    ...institutionTerms.flatMap(term => rawTerms.slice(0, 2).map(programmeTerm => `${term} ${programmeTerm}`))
  ]).filter(term => String(term).trim().length >= 2);
}

function programmeSearchNameVariants(programme) {
  const names = unique([
    programme?.nameEn,
    ...(programme?.aliases || [])
  ]).filter(value => /[A-Za-z]/.test(String(value)));
  const variants = names.flatMap(name => {
    const value = String(name).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    const stripped = value
      .replace(/\b(?:master\s+of\s+science|master|msc(?:\s*\(eng\))?|m\.sc\.?|msceng)\b/gi, " ")
      .replace(/\bin\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    return [name, value, stripped];
  });
  const focusTerms = unique((programme?.focusTags || []).flatMap(tag => ({
    computer: ["Computer Science", "Computing"],
    software: ["Computer Science", "Computing"],
    cybersecurity: ["Cyber Security", "Cybersecurity"],
    electronic: ["Electronics", "Electronic Engineering"],
    "integrated-circuit": ["Integrated Circuit Design"],
    communication: ["Communication Engineering", "Communications"],
    signal: ["Signal Processing"],
    data: ["Data Science", "Data Analytics"],
    ai: ["Artificial Intelligence"]
  }[tag] || [])));
  return unique([...variants, ...focusTerms]).filter(value => String(value).length >= 4);
}

function searchPlannerConfig() {
  // Reuse the extraction credentials until a cheaper search-specific model is configured.
  const apiUrl = chatCompletionsUrl(process.env.COLLECTOR_SEARCH_AI_API_URL || process.env.COLLECTOR_AI_API_URL);
  const apiKey = clean(process.env.COLLECTOR_SEARCH_AI_API_KEY || process.env.COLLECTOR_AI_API_KEY);
  const model = clean(process.env.COLLECTOR_SEARCH_AI_MODEL || process.env.COLLECTOR_AI_MODEL);
  return apiUrl && apiKey && model ? { apiUrl, apiKey, model } : null;
}

function cleanSearchPlannerTerms(values) {
  return unique(asArray(values)
    .map(value => String(value).replace(/^\s*(?:in|of)\s+/i, "").replace(/\s+/g, " ").trim())
    .filter(value => value.length >= 3 && value.length <= 120)
    .filter(value => !/^site:/i.test(value))
    .filter(value => !/[{}[\]]/.test(value)))
    .slice(0, 12);
}

function normalizeSearchPhrase(value) {
  return String(value || "")
    .replace(/^\s*(?:in|of)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateSearchPlan(payload) {
  const queryTerms = cleanSearchPlannerTerms(payload?.queryTerms || payload?.queries || payload?.titleVariants);
  return { queryTerms };
}

export function buildSearchPlannerRequest(programme, sources = [], model = process.env.COLLECTOR_SEARCH_AI_MODEL || "") {
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const existingSearchTerms = unique([
    programme?.nameEn,
    programme?.nameZh,
    ...(programme?.aliases || []),
    ...(programme?.discoveryTerms?.exact || []),
    ...(programme?.discoveryTerms?.short || []),
    ...(programme?.strictMatchTerms || [])
  ]).slice(0, 30);
  return {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: defaultSearchPlannerPrompt },
      { role: "user", content: JSON.stringify({
        programme: {
          id: programme?.id || null,
          nameEn: programme?.nameEn || null,
          nameZh: programme?.nameZh || null,
          aliases: asArray(programme?.aliases),
          focusTags: asArray(programme?.focusTags),
          institution: {
            nameEn: institution?.nameEn || null,
            nameZh: institution?.nameZh || null,
            aliases: asArray(institution?.aliases)
          }
        },
        searchableSources: sources.map(source => ({ id: source?.id || null, hosts: asArray(source?.hosts) })),
        existingSearchTerms
      }) }
    ]
  };
}

async function readSearchPlanCache() {
  if (!searchPlanCachePromise) {
    searchPlanCachePromise = readFile(searchPlannerCachePath, "utf8")
      .then(value => JSON.parse(value))
      .catch(error => error.code === "ENOENT" ? {} : {});
  }
  return searchPlanCachePromise;
}

function searchPlannerCacheKey(programme) {
  return createHash("sha256").update(JSON.stringify({
    plannerVersion: 3,
    model: process.env.COLLECTOR_SEARCH_AI_MODEL || process.env.COLLECTOR_AI_MODEL || null,
    id: programme?.id || null,
    institutionId: programme?.institutionId || null,
    nameEn: programme?.nameEn || null,
    nameZh: programme?.nameZh || null,
    aliases: asArray(programme?.aliases),
    focusTags: asArray(programme?.focusTags),
    strictMatchTerms: asArray(programme?.strictMatchTerms)
  })).digest("hex");
}

async function buildSearchPlan(programme, sources = []) {
  const config = searchPlannerConfig();
  if (!config) return { status: "disabled", queryTerms: [], model: null, cacheHit: false, usage: null };
  const cache = await readSearchPlanCache();
  const key = searchPlannerCacheKey(programme);
  const cached = cache?.[key];
  if (cached) {
    return { ...validateSearchPlan(cached), status: "cache", model: cached.model || config.model, cacheHit: true, usage: null };
  }
  try {
    const requestBody = buildSearchPlannerRequest(programme, sources, config.model);
    if (process.env.COLLECTOR_SEARCH_AI_JSON_MODE !== "false") requestBody.response_format = { type: "json_object" };
    requestBody.enable_thinking = false;
    const payload = await postChatCompletion({
      url: config.apiUrl,
      key: config.apiKey,
      body: requestBody,
      timeoutMs: Number(process.env.COLLECTOR_SEARCH_AI_TIMEOUT_MS || 30000),
      label: `搜索规划模型 ${config.model}`
    });
    const plan = validateSearchPlan(parseModelJson(payload?.choices?.[0]?.message?.content));
    cache[key] = { ...plan, model: config.model, updatedAt: new Date().toISOString() };
    await mkdir(dirname(searchPlannerCachePath), { recursive: true });
    await writeFile(searchPlannerCachePath, JSON.stringify(cache, null, 2), "utf8");
    return { ...plan, status: "generated", model: config.model, cacheHit: false, usage: payload?.usage || null };
  } catch (error) {
    return { status: "failed", queryTerms: [], model: config.model, cacheHit: false, usage: null, error: error.message };
  }
}

export function searchPlannerEnabled() {
  return Boolean(searchPlannerConfig());
}

export function searchQueryVariants(programme, source, searchPlan = null) {
  const host = source?.hosts?.[0] || "";
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionTerms = unique([institution?.nameZh, institution?.nameEn, ...(institution?.aliases || [])])
    .filter(term => String(term || "").trim().length >= 2);
  // Exact programme names lead discovery. Direction-only terms are fallbacks;
  // putting them first repeatedly finds neighbouring programmes instead.
  const profile = programme?.discoveryTerms || {};
  const sourceProfile = programme?.sourceSearchTerms?.[source?.id] || {};
  const exactProgrammeTerms = unique([
    ...(searchPlan?.queryTerms || []),
    ...(sourceProfile.exact || []),
    ...(profile.exact || []),
    ...programmeSearchNameVariants(programme),
    programme?.nameZh,
    ...(programme?.aliases || [])
  ]).map(normalizeSearchPhrase).filter(term => String(term || "").trim().length >= 4);
  const shortDirectionTerms = unique([
    ...(sourceProfile.short || []),
    ...(profile.short || []),
    ...(profile.focus || []),
    ...(programme?.focusTags || []).flatMap(tag => ({
    computer: ["计算机", "Computer Science", "Computing"],
    software: ["软件工程", "Software Engineering"],
    cybersecurity: ["网络安全", "Cyber Security", "Cybersecurity"],
    electronic: ["电子工程", "Electronic Engineering", "Electronics"],
    electrical: ["电气工程", "Electrical Engineering"],
    communication: ["通信工程", "Communications Engineering"],
    signal: ["信号处理", "Signal Processing"],
    data: ["数据科学", "Data Science", "Data Analytics"],
    ai: ["人工智能", "Artificial Intelligence"],
    robotics: ["机器人", "Robotics"],
    automation: ["自动化", "Automation"],
    control: ["控制工程", "Control Engineering"],
    "integrated-circuit": ["集成电路", "Integrated Circuit Design"],
    semiconductor: ["半导体", "Semiconductor"]
  }[tag] || []))
  ]);
  const compact = exactProgrammeTerms[0] || programme?.nameEn || "";
  const shortName = compact
    .replace(/^(MSc|Master of Science|Master|M\.Sc\.)\s+(in|of)\s+/i, "")
    .trim();
  const aliases = exactProgrammeTerms.slice(1, 8);
  const schoolTerms = institutionTerms.slice(0, 3);
  const exactTerms = exactProgrammeTerms.slice(0, 12);
  const caseSignalQuery = "(offer OR admission OR 录取 OR 案例)";
  const looseTerms = unique([
    ...exactTerms.map(term => String(term)
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(?:master\s+of\s+science|master\s+of\s+engineering|master|msc(?:\s*\(eng\))?|m\.sc\.?|msceng)\b/gi, " ")
      .replace(/\bin\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()),
    shortName,
    ...shortDirectionTerms
  ]).filter(term => String(term || "").trim().length >= 3).slice(0, 12);
  // Keep a reserved portion of the source budget for institution/direction
  // fallbacks. Otherwise a programme with many aliases spends all requests
  // repeating exact phrases that search engines may not index.
  const exactQueries = exactTerms.flatMap(term => [
    `site:${host} "${term}" offer`,
    `site:${host} "${term}" case`,
    `site:${host} "${term}" admission`,
    `site:${host} "${term}" 录取`,
    `site:${host} "${term}" GPA`
  ]);
  // A small per-source budget should cover distinct programme aliases before
  // spending both requests on offer/case variants of one phrase.
  const exactProbeQueries = unique([
    ...exactTerms.slice(0, 4).map(term => `site:${host} "${term}" offer`),
    ...exactTerms.slice(0, 4).map(term => `site:${host} "${term}" case`)
  ]);
  const schoolAndExactQueries = schoolTerms.slice(0, 2).flatMap(school => exactTerms.slice(0, 3).map(term =>
    `site:${host} "${school}" "${term}" admission`
  ));
  const qualifiedQueries = unique([
    ...(sourceProfile.institutionQualified || []),
    ...(profile.institutionQualified || [])
  ]).slice(0, 2).flatMap(term => [
    `site:${host} "${term}" offer`,
    `site:${host} "${term}" case`
  ]);
  const directionFallbackTerms = unique([
    ...(sourceProfile.focus || []),
    ...(profile.focus || []),
    ...shortDirectionTerms
  ]).slice(0, 2);
  const earlyFallbackQueries = schoolTerms.slice(0, 2).flatMap(school => directionFallbackTerms.slice(0, 2).map(term =>
    `site:${host} ${school} ${term} ${caseSignalQuery}`
  ));
  const looseQueries = looseTerms.flatMap(term => [
    `site:${host} ${term} ${caseSignalQuery}`,
    `site:${host} ${term} (GPA OR IELTS OR TOEFL OR 均分)`
  ]);
  const schoolOnlyQueries = schoolTerms.slice(0, 2).flatMap(school => [
    `site:${host} "${school}" ${caseSignalQuery}`,
    `site:${host} ${school} ${caseSignalQuery}`,
    `site:${host} "${school}" (GPA OR IELTS OR TOEFL OR 均分)`
  ]);
  return unique([
    // Two exact probes cover distinct target aliases, then the next probe is
    // allowed to widen the search before direction fallbacks consume budget.
    ...exactProbeQueries.slice(0, 2),
    ...schoolOnlyQueries,
    ...earlyFallbackQueries,
    ...schoolAndExactQueries,
    ...looseQueries.slice(0, 8),
    ...qualifiedQueries.slice(0, 1),
    ...qualifiedQueries.slice(1),
    ...exactQueries.slice(2),
    `site:${host} "${compact}" case`,
    ...(shortName && shortName !== compact ? [`site:${host} "${shortName}" admission`] : []),
    ...aliases.map(alias => `site:${host} "${alias}" offer`),
    `site:${host} ${compact} admission`,
    ...schoolTerms.slice(0, 2).flatMap(school => shortDirectionTerms.slice(0, 2).map(term => `site:${host} ${school} ${term} 录取 案例`)),
    ...shortDirectionTerms.slice(0, 2).map(term => `site:${host} ${term} offer case`),
    ...looseQueries.slice(8)
  ]);
}

export function buildCaseSearchQuery(programme, source) {
  const host = source?.hosts?.[0] || "";
  const terms = unique([...searchTermsForProgramme(programme), ...programmeSearchNameVariants(programme)])
    .slice(0, 3).map(term => `"${term}"`).join(" ");
  const detailPattern = source?.detailRegexes?.[0] ? ` ${host}` : "";
  return `site:${host} ${terms} admission offer case${detailPattern}`.trim();
}

export function parseSearchResultUrls(html, source) {
  return parseSearchResultCandidates(html, source).map(candidate => candidate.url);
}

export function parseSearchResultCandidates(html, source) {
  const urls = new Map();
  const addCandidate = (rawUrl, anchorText = "") => {
    try {
      const url = new URL(String(rawUrl).replace(/&amp;/g, "&"));
      if (!source?.hosts?.includes(url.hostname)) return;
      const kind = (source.detailRegexes || []).some(regex => new RegExp(regex).test(url.pathname))
        ? "detail"
        : [...(source.entryRegexes || []), ...(source.paginationRegexes || [])].some(regex => new RegExp(regex).test(url.pathname))
          ? "seed" : null;
      if (!kind) return;
      url.href = canonicalizeCandidateUrl(url.href);
      const key = `${kind}|${url.href}`;
      const current = urls.get(key);
      const text = stripHtml(anchorText);
      if (!current || text.length > current.anchorText.length) urls.set(key, { url: url.href, kind, anchorText: text });
    } catch {}
  };
  const anchorPattern = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html)))) addCandidate(match[1], match[2]);
  // Search engines also emit hrefs without a closing anchor, so retain the
  // old opening-tag parser as a deterministic fallback.
  const hrefPattern = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>/gi;
  while ((match = hrefPattern.exec(String(html)))) addCandidate(match[1]);
  // Bing sometimes renders the target URL in a tracking attribute or escaped
  // JSON instead of the visible href. Keep the parser deterministic, but
  // accept those same-host URLs when the configured detail/entry pattern fits.
  const escapedUrls = String(html).matchAll(/https?:[^"'<>\s]+/gi);
  for (const escaped of escapedUrls) {
    try {
      const raw = escaped[0].replaceAll("\\/", "/").replaceAll("\\u002F", "/").replace(/&amp;/g, "&");
      const url = new URL(raw);
      if (!source?.hosts?.includes(url.hostname)) continue;
      const kind = (source.detailRegexes || []).some(regex => new RegExp(regex).test(url.pathname))
        ? "detail"
        : [...(source.entryRegexes || []), ...(source.paginationRegexes || [])].some(regex => new RegExp(regex).test(url.pathname)) ? "seed" : null;
      if (!kind) continue;
      url.href = canonicalizeCandidateUrl(url.href);
      addCandidate(url.href);
    } catch {}
  }
  return [...urls.values()];
}

export function parseSeedCaseCandidates(html, baseUrl, source, programme) {
  const candidates = new Map();
  const title = stripHtml(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ").trim();
  const addCandidate = (rawUrl, anchorText = "") => {
    try {
      const url = new URL(String(rawUrl).replace(/&amp;/g, "&"), baseUrl);
      if (!source?.hosts?.includes(url.hostname)) return;
      const pagination = (source.paginationRegexes || []).some(regex => new RegExp(regex).test(url.pathname));
      const kind = (source.detailRegexes || []).some(regex => new RegExp(regex).test(url.pathname))
        ? "detail"
        : [...(source.entryRegexes || []), ...(source.paginationRegexes || [])].some(regex => new RegExp(regex).test(url.pathname))
          ? "seed" : null;
      if (!kind) return;
      url.href = canonicalizeCandidateUrl(url.href);
      const scored = pagination
        ? { url: url.href, kind, accepted: true, score: 0, programmeHits: [], institutionHits: [], reasons: ["pagination"] }
        : scoreSearchCandidate({
        url: url.href,
        kind,
        anchorText: `${stripHtml(anchorText)} ${title}`.trim()
      }, programme, source);
      const key = `${kind}|${url.href}`;
      const current = candidates.get(key);
      if (!current || scored.score > current.score || String(anchorText).length > String(current.anchorText || "").length) {
        candidates.set(key, { ...scored, pagination, anchorText: stripHtml(anchorText).replace(/\s+/g, " ").trim() });
      }
    } catch {}
  };
  const anchorPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html)))) addCandidate(match[1], match[2]);
  const hrefPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  while ((match = hrefPattern.exec(String(html)))) addCandidate(match[1]);
  const parsed = [...candidates.values()]
    .filter(candidate => candidate.accepted && (
      candidate.pagination
      || candidate.programmeHits?.some(hit => !isGenericProgrammeSearchTerm(hit))
      || (source?.acceptInstitutionOnly && candidate.institutionHits?.length > 0)
    ))
    .sort((a, b) => {
      const aExact = a.programmeHits?.length ? 1 : 0;
      const bExact = b.programmeHits?.length ? 1 : 0;
      return bExact - aExact || b.score - a.score || a.url.localeCompare(b.url);
    });
  if (source?.paginationStrategy !== "next") return parsed;
  const currentPage = Number(new URL(baseUrl, "https://example.com").pathname.match(/\/case-(\d+)-/)?.[1] || 0);
  const pagination = parsed.filter(candidate => candidate.pagination);
  if (!pagination.length) return parsed;
  const pageNumber = candidate => Number(new URL(candidate.url).pathname.match(/\/case-(\d+)-/)?.[1] || 0);
  const next = pagination
    .filter(candidate => pageNumber(candidate) === currentPage + 1)
    .sort((a, b) => a.url.localeCompare(b.url))[0]
    || pagination
      .filter(candidate => pageNumber(candidate) > currentPage)
      .sort((a, b) => pageNumber(a) - pageNumber(b) || a.url.localeCompare(b.url))[0]
    || pagination.find(candidate => /next|\u4e0b\u4e00\u9875|\u4e0b\u4e00\u9801/i.test(candidate.anchorText || ""));
  return [...parsed.filter(candidate => !candidate.pagination), ...(next ? [next] : [])];
}

export async function discoverSeedCaseCandidates(programme, source, { fetchImpl = fetch, maxResults = 20, maxSeeds = 1 } = {}) {
  const attempts = [];
  const urls = [];
  const entryUrls = [];
  const programmeRegion = normalizePageSearchText(programme?.region || "");
  const orderedSeedUrls = asArray(source?.seedUrls)
    .map((url, index) => ({
      url,
      index,
      priority: (source?.seedUrlHints || []).reduce((score, hint) => {
        const regions = asArray(hint?.regions).map(normalizePageSearchText).filter(Boolean);
        const regionMatch = programmeRegion && regions.some(region => programmeRegion.includes(region) || region.includes(programmeRegion));
        return score + (regionMatch && hint?.urlIncludes && String(url).includes(hint.urlIncludes) ? 1 : 0);
      }, 0)
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map(item => item.url);
  for (const seedUrl of orderedSeedUrls.slice(0, Math.max(1, maxSeeds))) {
    try {
      const response = await fetchImpl(seedUrl, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }));
      if (!response.ok) throw new Error(`seed request failed ${response.status}`);
      const html = await response.text();
      const candidates = parseSeedCaseCandidates(html, seedUrl, source, programme).slice(0, maxResults);
      const detailMatches = candidates.filter(candidate => candidate.kind === "detail").map(candidate => candidate.url);
      const seedMatches = candidates.filter(candidate => candidate.kind === "seed").map(candidate => candidate.url)
        .filter(url => url !== new URL(seedUrl).href)
        .slice(0, Math.max(1, Number(source?.paginationMaxPages) || maxResults));
      urls.push(...detailMatches);
      entryUrls.push(...seedMatches);
      attempts.push({ seedUrl, status: response.status, candidateCount: candidates.length, acceptedCount: candidates.length, urls: detailMatches, entryUrls: seedMatches, candidates: candidates.slice(0, 10) });
      if (detailMatches.length || seedMatches.length) break;
    } catch (error) {
      attempts.push({ seedUrl, status: null, candidateCount: 0, acceptedCount: 0, urls: [], entryUrls: [], error: error.message });
    }
  }
  return {
    urls: unique(urls).slice(0, maxResults),
    entryUrls: unique(entryUrls).slice(0, maxResults),
    attempts,
    requestCount: attempts.length,
    discoveryFunnel: {
      seedsProbed: attempts.length,
      candidatesSeen: attempts.reduce((sum, attempt) => sum + Number(attempt.candidateCount || 0), 0),
      accepted: attempts.reduce((sum, attempt) => sum + Number(attempt.acceptedCount || 0), 0),
      errors: attempts.filter(attempt => attempt.error).map(attempt => attempt.error)
    },
    discoveredBy: "seed-page"
  };
}

export function scoreSearchCandidate(candidate, programme, source) {
  const url = String(candidate?.url || "");
  const searchable = normalizePageSearchText(`${url} ${candidate?.anchorText || ""}`);
  const institution = institutionMaster.find(item => item.id === programme?.institutionId);
  const institutionTerms = unique([
    institution?.nameEn,
    institution?.nameZh,
    ...(institution?.aliases || [])
  ]).filter(term => normalizePageSearchText(term).length >= 2);
  const strictTerms = unique([
    ...(programme?.strictMatchTerms || []),
    programme?.nameEn,
    programme?.nameZh,
    ...(programme?.aliases || [])
  ]).filter(term => normalizePageSearchText(term).length >= 3);
  const programmeHits = searchTermHit(searchable, strictTerms);
  const institutionHits = searchTermHit(searchable, institutionTerms);
  const profileFocusHits = searchTermHit(searchable, programme?.discoveryTerms?.focus || []);
  const competingFocusHits = programme
    ? searchTermHit(searchable, competingProgrammeFocusTerms(programme)).filter(hit => !profileFocusHits.includes(hit))
    : [];
  const pathLooksLikeCase = (source?.detailRegexes || []).some(regex => {
    try { return new RegExp(regex).test(new URL(url).pathname); } catch { return false; }
  });
  const caseSignals = ["offer", "admission", "case", "student", "\u5f55\u53d6", "\u6848\u4f8b"]
    .filter(term => searchable.includes(normalizePageSearchText(term)));
  const conflictingProgrammeHits = programme
    ? programmeMaster
      .filter(item => item.institutionId === programme.institutionId && item.id !== programme.id)
      .flatMap(item => {
        const terms = unique([...(item.strictMatchTerms || []), item.nameEn, item.nameZh, ...(item.aliases || [])])
          .filter(term => normalizePageSearchText(term).length >= 4);
        const hits = searchTermHit(searchable, terms);
        return hits.length ? [{ id: item.id, hits: hits.slice(0, 3) }] : [];
      })
    : [];
  const explicitConflict = programmeHits.length === 0 && conflictingProgrammeHits.length > 0;
  const institutionOnlyConflict = Boolean(
    source?.acceptInstitutionOnly
    && programmeHits.length === 0
    && institutionHits.length > 0
    && competingFocusHits.length > 0
  );
  const score = programmeHits.length * 12
    + institutionHits.length * 4
    + profileFocusHits.slice(0, 2).length * 2
    + (candidate?.kind === "detail" ? 3 : 1)
    + (pathLooksLikeCase ? 2 : 0)
    + Math.min(2, caseSignals.length)
    - (explicitConflict ? 12 : 0)
    - (institutionOnlyConflict ? 12 : 0);
  const accepted = !explicitConflict && !institutionOnlyConflict && (programmeHits.length > 0 || score >= 6);
  return {
    ...candidate,
    score,
    accepted,
    programmeHits: programmeHits.slice(0, 6),
    institutionHits: institutionHits.slice(0, 4),
    competingFocusHits: competingFocusHits.slice(0, 4),
    conflictProgrammeIds: conflictingProgrammeHits.map(item => item.id).slice(0, 4),
    reasons: [
      programmeHits.length ? `programme:${programmeHits.slice(0, 3).join(",")}` : null,
      institutionHits.length ? `institution:${institutionHits.slice(0, 2).join(",")}` : null,
      profileFocusHits.length ? `focus:${profileFocusHits.slice(0, 2).join(",")}` : null,
      pathLooksLikeCase ? "case-path" : null,
      caseSignals.length ? `case-signal:${caseSignals.slice(0, 3).join(",")}` : null,
      explicitConflict ? `conflict:${conflictingProgrammeHits.map(item => item.id).slice(0, 2).join(",")}` : null,
      institutionOnlyConflict ? `focus-conflict:${competingFocusHits.slice(0, 2).join(",")}` : null,
      accepted ? "accepted" : "below-threshold"
    ].filter(Boolean)
  };
}

function parseEicApiUrl(record, source) {
  return source?.api?.detailPath && record?.id
    ? `${source.api.detailPath.replace(/\/$/, "")}/${record.id}`
    : null;
}

export async function discoverCaseUrlsBySearch(programme, source, { fetchImpl = fetch, maxResults = 20, maxQueries = 8, searchPlan = null } = {}) {
  const queries = searchQueryVariants(programme, source, searchPlan).slice(0, Math.max(1, maxQueries));
  const results = [];
  for (const query of queries) {
    const searchUrl = `https://www.bing.com/search?count=${Math.min(50, Math.max(1, maxResults))}&q=${encodeURIComponent(query)}`;
    try {
      const response = await fetchImpl(searchUrl, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "text/html", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }));
      if (!response.ok) throw new Error(`搜索请求失败 ${response.status}`);
      const html = await response.text();
      const candidates = parseSearchResultCandidates(html, source)
        .map(candidate => scoreSearchCandidate(candidate, programme, source))
        .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
      const accepted = candidates.filter(candidate => candidate.accepted);
      results.push({
        query,
        searchUrl,
        candidateCount: candidates.length,
        acceptedCount: accepted.length,
        rejectedCount: candidates.length - accepted.length,
        urls: accepted.filter(candidate => candidate.kind === "detail").map(candidate => candidate.url),
        entryUrls: accepted.filter(candidate => candidate.kind === "seed").map(candidate => candidate.url),
        candidates: candidates.slice(0, maxResults).map(candidate => ({
          url: candidate.url,
          kind: candidate.kind,
          score: candidate.score,
          accepted: candidate.accepted,
          reasons: candidate.reasons
        }))
      });
      const acceptedDetails = results.flatMap(result => result.urls);
      const highQuality = results.flatMap(result => result.candidates)
        .filter(candidate => candidate.accepted && candidate.score >= 15);
      if (acceptedDetails.length >= maxResults || highQuality.length >= Math.min(4, maxResults)) break;
    } catch (error) {
      results.push({ query, searchUrl, candidateCount: 0, acceptedCount: 0, rejectedCount: 0, urls: [], entryUrls: [], error: error.message });
    }
  }
  const detailCandidates = results.flatMap(result => result.candidates || [])
    .filter(candidate => candidate.kind === "detail" && candidate.accepted)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const entryCandidates = results.flatMap(result => result.candidates || [])
    .filter(candidate => candidate.kind === "seed" && candidate.accepted)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const rankUnique = candidates => [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()];
  return {
    query: results.map(result => result.query).join(" | "),
    searchUrl: results.at(-1)?.searchUrl || null,
    urls: rankUnique(detailCandidates).slice(0, maxResults).map(candidate => candidate.url),
    entryUrls: rankUnique(entryCandidates).slice(0, maxResults).map(candidate => candidate.url),
    attempts: results,
    discoveryFunnel: {
      queriesIssued: results.length,
      candidatesSeen: results.reduce((sum, result) => sum + Number(result.candidateCount || 0), 0),
      accepted: detailCandidates.length + entryCandidates.length,
      rejected: results.reduce((sum, result) => sum + Number(result.rejectedCount || 0), 0),
      errors: results.filter(result => result.error).map(result => ({ query: result.query, error: result.error }))
    }
  };
}

export function buildSourceCandidates(programme, sources = []) {
  const configuredEntrypoints = asArray(programme?.searchEntrypoints?.length
    ? programme.searchEntrypoints
    : programme?.caseSourceUrls);
  const candidateKind = (url, source) => {
    try {
      const pathname = new URL(url).pathname;
      if ((source?.detailRegexes || []).some(pattern => new RegExp(pattern).test(pathname))) return "detail";
      if ([...(source?.entryRegexes || []), ...(source?.paginationRegexes || [])].some(pattern => new RegExp(pattern).test(pathname))) return "seed";
    } catch {}
    return "detail";
  };
  const primary = configuredEntrypoints.map((url, index) => {
    const source = sourceForUrl(url, sources);
    return {
      url,
      sourceId: source?.id || null,
      priority: index === 0 ? 0 : 1,
      kind: candidateKind(url, source)
    };
  });
  const nativeSearchKinds = new Set(["hksg-web", "mastermate-api", "compass-index"]);
  const fallback = sources.flatMap(source => {
    if (nativeSearchKinds.has(source.search?.kind)) return [];
    return asArray(source.fallbackUrls).map(url => ({
      url,
      sourceId: source.id || null,
      priority: 1,
      kind: candidateKind(url, source),
      discoveredBy: "configured-source"
    }));
  });
  const seeds = sources.flatMap(source => {
    if (nativeSearchKinds.has(source.search?.kind)) return [];
    return asArray(source.seedUrls).map(url => ({
      url,
      sourceId: source.id || null,
      priority: 2,
      kind: "seed",
      discoveredBy: "configured-source"
    }));
  });
  const seen = new Set();
  return [...primary, ...fallback, ...seeds]
    .filter(candidate => {
      if (!candidate.url || seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

export function allocateSearchSourceLimit(searchSourceLimit = 10, searchRequestBudget = 16, minimumQueriesPerSource = 4) {
  const sourceLimit = Math.max(1, Number(searchSourceLimit) || 1);
  const requestBudget = Math.max(1, Number(searchRequestBudget) || 1);
  const minimumQueries = Math.max(1, Number(minimumQueriesPerSource) || 1);
  return Math.min(sourceLimit, Math.max(1, Math.floor(requestBudget / minimumQueries)));
}

export function allocateSearchSourceRotationLimit(searchSourceLimit = 10, searchRequestBudget = 16, availableSourceCount = searchSourceLimit) {
  const sourceLimit = Math.max(1, Number(searchSourceLimit) || 1);
  const requestBudget = Math.max(1, Number(searchRequestBudget) || 1);
  const available = Math.max(1, Number(availableSourceCount) || 1);
  return Math.min(sourceLimit, requestBudget, available);
}

function emptyCrawlRetryAfterMs() {
  return Math.max(0, Number(process.env.COLLECTOR_EMPTY_RECHECK_DAYS || 14)) * 24 * 60 * 60 * 1000;
}

export function crawlSourceNeedsAttempt(previous, programmeId, now = Date.now()) {
  if (!previous || previous.status !== "completed") return true;
  // Crawl status is stored per URL, but extraction/matching is programme-scoped.
  // A page that produced a candidate for another programme must be allowed to
  // run again here; otherwise search discovery finds a real case and the next
  // programme silently loses the chance to verify it. The case fingerprint
  // still prevents duplicate records, while the same programme remains cached.
  if (previous.programme_id !== programmeId) return true;
  if (Number(previous.scoped_count || 0) > 0) return false;
  const checkedAt = Date.parse(previous.last_checked_at || "");
  return !Number.isFinite(checkedAt) || now - checkedAt >= emptyCrawlRetryAfterMs();
}

function crawlSourceForProgramme(db, sourceUrl, programmeId) {
  const scoped = getCrawlSourceScope(db, sourceUrl, programmeId);
  if (scoped) return scoped;
  const global = getCrawlSource(db, sourceUrl);
  if (!global) return null;
  return global.programme_id === programmeId
    ? global
    : { ...global, programme_id: null, scoped_count: 0, queued_count: 0 };
}

function hasStoredCaseForSourceUrl(db, sourceUrl) {
  return Boolean(db.prepare("SELECT 1 FROM cases WHERE source_url = ? LIMIT 1").get(sourceUrl));
}

const fallbackPrefilterVersion = "fallback-prefilter-v1";

function fallbackPrefilterNeedsAttempt(db, sourceUrl, programmeId) {
  const previous = crawlSourceForProgramme(db, sourceUrl, programmeId);
  if (!previous || previous.status !== "completed" || previous.programme_id !== programmeId) return true;
  return previous.error !== `${fallbackPrefilterVersion}:no-target`;
}

function hasMoreSpecificProgrammeFallbackConflict(programme, pageText) {
  const targetNames = unique([
    programme?.nameEn,
    programme?.nameZh,
    ...(programme?.aliases || [])
  ]).map(normalizePageSearchText).filter(term => term.length >= 6);
  const searchable = normalizePageSearchText(pageText);
  const hasStandaloneTargetName = targetNames.some(term => {
    const index = searchable.indexOf(term);
    if (index < 0) return false;
    const suffix = searchable.slice(index + term.length, index + term.length + 40);
    return !/^(?:in|for|of|and|with)\b/i.test(suffix);
  });
  if (hasStandaloneTargetName) return false;
  return programmeMaster
    .filter(item => item.institutionId === programme?.institutionId && item.id !== programme?.id)
    .some(item => {
      const otherNames = unique([item.nameEn, item.nameZh, ...(item.aliases || [])])
        .map(normalizePageSearchText).filter(term => term.length >= 8);
      return otherNames.some(term => targetNames.some(target => term.includes(target)) && searchable.includes(term));
    });
}

async function probeConfiguredFallbackCandidates(programme, sources, db, {
  maxProbes = 6,
  maxCandidates = 2,
  allowDirectionOnly = false
} = {}) {
  const nativeSearchKinds = new Set(["hksg-web", "mastermate-api"]);
  const configured = sources.flatMap(source => asArray(source.fallbackUrls).map(url => {
    let pathname = "";
    try { pathname = new URL(url).pathname; } catch {}
    const kind = (source.entryRegexes || []).some(pattern => new RegExp(pattern).test(pathname))
      ? "seed"
      : "detail";
    return { url, sourceId: source.id || null, priority: 1, kind, discoveredBy: "configured-source" };
  }))
    .filter(candidate => candidate.kind === "detail" || candidate.kind === "seed")
    .filter(candidate => {
      const source = sources.find(item => item.id === candidate.sourceId);
      return source && !nativeSearchKinds.has(source.search?.kind);
    })
    .filter(candidate => fallbackPrefilterNeedsAttempt(db, candidate.url, programme.id));
  const candidates = [];
  const attempts = [];
  for (const candidate of configured) {
    if (attempts.length >= Math.max(1, maxProbes) || candidates.length >= Math.max(1, maxCandidates)) break;
    const source = sources.find(item => item.id === candidate.sourceId);
    try {
      const page = await fetchPage(candidate.url, source);
      const pageText = preparePageTextForSource(stripHtml(page.html), source.id);
      const prefilter = scorePageForExtraction({
        url: page.finalUrl,
        html: page.html,
        pageText,
        programmeId: programme.id,
        allowDirectionOnly
      });
      const headingText = normalizePageSearchText(`${pageHeadingText(page.html)} ${page.finalUrl}`);
      const headingProgrammeHits = fallbackTargetHeadingHits(headingText, programme);
      const institution = institutionMaster.find(item => item.id === programme.institutionId);
      const headingInstitutionHits = searchTermHit(headingText, unique([
        institution?.nameEn,
        institution?.nameZh,
        ...(institution?.aliases || [])
      ]));
      // A programme hit in the body is not enough: admission pages often
      // mention other programmes in a student's projects or related-case
      // links.  The fallback page itself must identify the requested
      // programme in its title/H1/URL before it can seed a crawl.
      const hasTargetAnchor = headingProgrammeHits.length > 0 && headingInstitutionHits.length > 0;
      const specificConflict = hasMoreSpecificProgrammeFallbackConflict(programme, pageText);
      const accepted = prefilter.decision === "pass"
        && prefilter.programmeHits.length > 0
        && hasTargetAnchor
        && !specificConflict;
      attempts.push({
        sourceId: source.id,
        url: candidate.url,
        finalUrl: page.finalUrl,
        accepted,
        decision: prefilter.decision,
        score: prefilter.score,
        programmeHits: prefilter.programmeHits,
        headingProgrammeHits,
        headingInstitutionHits,
        hasTargetAnchor,
        specificConflict,
        reasons: hasTargetAnchor
          ? prefilter.reasons
          : [...prefilter.reasons, "missing-heading-programme-anchor"]
      });
      if (accepted) {
        Object.assign(candidate, { priority: 0, discoveredBy: "fallback-prefilter", prefilter });
        candidates.push(candidate);
      } else {
        recordCrawlSource(db, {
          sourceUrl: candidate.url,
          finalUrl: page.finalUrl,
          programmeId: programme.id,
          extractedCount: 0,
          scopedCount: 0,
          queuedCount: 0,
          error: `${fallbackPrefilterVersion}:no-target`
        });
      }
    } catch (error) {
      attempts.push({ sourceId: source?.id || candidate.sourceId, url: candidate.url, error: error.message });
    }
  }
  return { candidates, attempts };
}

const engineeringProgrammeTags = new Set([
  "electronic", "communication", "computer", "software", "ai", "data", "automation",
  "robotics", "electrical", "mechanical", "integrated-circuit", "semiconductor", "control",
  "network", "signal", "embedded", "manufacturing", "cybersecurity"
]);
const clearlyNonEngineeringProgrammeWords = /business|finance|financial|fintech|accountancy|accounting|marketing|actuarial|risk|management|media|education|communication\s+and\s+translation|executive|social\s+science|urban|human\s+capital|medicine|medical|biomedical|epidemiology|e-?commerce|commerce|earth|environment|sustainab|health/i;

export function isCoreEngineeringProgramme(programme) {
  const tags = new Set(asArray(programme?.focusTags));
  const name = `${programme?.nameEn || ""} ${programme?.nameZh || ""}`;
  if (![...tags].some(tag => engineeringProgrammeTags.has(tag))) return false;
  if (clearlyNonEngineeringProgrammeWords.test(name)) return false;
  if (tags.has("communication") && !/engineering|electronic|telecom|network|signal/i.test(name)) return false;
  return true;
}

export function buildProgrammeCollectionPlan(programme, sources = [], db = null, { targetApproved = DEFAULT_APPROVED_TARGET } = {}) {
  const coverage = db ? caseCoverage(db, programme.id) : null;
  const programmeStatus = db ? getProgrammeStatus(db, programme.id) : null;
  const programmeScope = db ? getProgrammeScope(db, programme.id) : null;
  const primaryCandidates = buildSourceCandidates({ ...programme, caseSourceUrls: programme?.caseSourceUrls || [] }, sources)
    .filter(candidate => candidate.kind === "detail" && candidate.priority === 0)
    .filter(candidate => !db || crawlSourceForProgramme(db, candidate.url, programme.id)?.status !== "completed");
  const usedSourceIds = new Set();
  const sourceCandidates = buildSourceCandidates(programme, sources)
    .filter(candidate => {
      const previous = db ? crawlSourceForProgramme(db, candidate.url, programme.id) : null;
      return crawlSourceNeedsAttempt(previous, programme.id);
    })
    .sort((a, b) => {
      const aUsed = usedSourceIds.has(a.sourceId) ? 1 : 0;
      const bUsed = usedSourceIds.has(b.sourceId) ? 1 : 0;
      return aUsed - bUsed || a.priority - b.priority || String(a.sourceId || "").localeCompare(String(b.sourceId || ""));
    });
  for (const candidate of sourceCandidates) usedSourceIds.add(candidate.sourceId);
  return {
    programmeId: programme.id,
    programme: { nameEn: programme.nameEn, nameZh: programme.nameZh, institutionId: programme.institutionId, focusTags: programme.focusTags || [] },
    targetApproved,
    coverage,
    programmeStatus,
    programmeScope,
    sourceCandidates,
    primarySourceCount: primaryCandidates.length,
    sourceCount: new Set(sourceCandidates.map(candidate => candidate.sourceId).filter(Boolean)).size,
    needsSourceDiscovery: primaryCandidates.length === 0 && (!coverage || (coverage.approved2021 ?? coverage.approved) < targetApproved),
    searchSources: primaryCandidates.length ? [] : sources.map(source => ({ id: source.id, hosts: source.hosts, query: buildCaseSearchQuery(programme, source) }))
  };
}
export function buildLowCoverageProgrammePlans({ db, sources = [], targetApproved = DEFAULT_APPROVED_TARGET, limit = 20, institutionIds = targetInstitutionIds, programmeScope = "all", focusTags = [] } = {}) {
  const allowedInstitutions = new Set(institutionIds.filter(Boolean));
  const allowedFocusTags = new Set(focusTags.filter(Boolean));
  const coreOnly = programmeScope === "core-engineering";
  return programmeMaster
    .filter(programme => programme.active !== false)
    .filter(programme => !allowedInstitutions.size || allowedInstitutions.has(programme.institutionId))
    .filter(programme => !allowedFocusTags.size || (programme.focusTags || []).some(tag => allowedFocusTags.has(tag)))
    .filter(programme => !coreOnly || isCoreEngineeringProgramme(programme))
    .filter(programme => programmeScopeAllowed(getProgrammeScope(db, programme.id)))
    .filter(programme => programmeCollectionAllowed(getProgrammeStatus(db, programme.id)))
    .map(programme => ({
      ...buildProgrammeCollectionPlan(programme, sources, db, { targetApproved }),
      searchEvidence: programmeSearchEvidence(db, programme.id),
      recentNoProgress: eligibilityRecentNoProgressRunCount(db, programme.id)
    }))
    .filter(plan => programmeCollectionEligibility({
      scope: plan.programmeScope,
      status: plan.programmeStatus,
      coverage: plan.coverage,
      searchEvidence: plan.searchEvidence,
      targetApproved
    }).eligible)
    .filter(plan => !plan.coverage || (plan.coverage.approved2021 ?? plan.coverage.approved) < targetApproved)
    .sort((a, b) => Number((b.coverage?.pending2021 ?? b.coverage?.pending ?? 0) === 0)
        - Number((a.coverage?.pending2021 ?? a.coverage?.pending ?? 0) === 0)
      || (b.coverage?.approved2021 ?? b.coverage?.approved ?? 0) - (a.coverage?.approved2021 ?? a.coverage?.approved ?? 0)
      || (a.coverage?.recentApproved ?? 0) - (b.coverage?.recentApproved ?? 0)
      || Number(b.primarySourceCount > 0) - Number(a.primarySourceCount > 0)
      || a.recentNoProgress - b.recentNoProgress
      || (b.coverage?.pending2021 ?? b.coverage?.pending ?? 0) - (a.coverage?.pending2021 ?? a.coverage?.pending ?? 0)
      || Number(isCoreEngineeringProgramme(b.programme)) - Number(isCoreEngineeringProgramme(a.programme))
      || b.sourceCount - a.sourceCount
      || a.programmeId.localeCompare(b.programmeId))
    .slice(0, Math.max(1, limit));
}

function robotsPattern(path) {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}${path.endsWith("$") ? "" : ".*"}`);
}

export function robotsAllowsText(robotsText, pathname) {
  const lines = String(robotsText).split(/\r?\n/).map(line => line.replace(/#.*/, "").trim());
  let applies = false;
  const rules = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") applies = value === "*";
    else if (applies && (key === "allow" || key === "disallow") && value) rules.push({ allow: key === "allow", value });
  }
  const matches = rules.filter(rule => robotsPattern(rule.value).test(pathname)).sort((a, b) => b.value.length - a.value.length);
  return matches.length ? matches[0].allow : true;
}

async function robotsAllows(url, fetchImpl = fetch) {
  const target = new URL(url);
  const cacheKey = target.origin;
  if (!robotsDecisionCache.has(cacheKey)) {
    const decision = (async () => {
      const response = await fetchImpl(new URL("/robots.txt", target.origin), withHttpTimeout({ headers: { "User-Agent": userAgent } }));
      if (response.status === 404) return true;
      if (!response.ok) return false;
      return robotsAllowsText(await response.text(), target.pathname);
    })();
    robotsDecisionCache.set(cacheKey, decision);
  }
  try {
    return await robotsDecisionCache.get(cacheKey);
  } catch (error) {
    robotsDecisionCache.delete(cacheKey);
    throw error;
  }
}

async function fetchOfficialPage(url, fetchImpl = fetch) {
  if (!officialPageCache.has(url)) {
    const request = (async () => {
      const response = await fetchImpl(url, withHttpTimeout({
        headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en,zh-CN;q=0.8" }
      }));
      return { response, html: await response.text() };
    })();
    officialPageCache.set(url, request);
  }
  try {
    return await officialPageCache.get(url);
  } catch (error) {
    officialPageCache.delete(url);
    throw error;
  }
}

async function fetchPage(url, source) {
  if (!await robotsAllows(url)) throw new Error(`robots.txt不允许抓取：${url}`);
  const response = await fetch(url, withHttpTimeout({ headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" } }));
  if (!response.ok) throw new Error(`页面请求失败 ${response.status}：${url}`);
  const finalUrl = new URL(response.url);
  if (!source.hosts.includes(finalUrl.hostname)) throw new Error(`页面跳转到未授权域名：${finalUrl.hostname}`);
  return { html: await response.text(), finalUrl: finalUrl.href };
}

function parseModelJson(content) {
  return JSON.parse(String(content).replace(/^```json\s*/i, "").replace(/\s*```$/, ""));
}

const extractionScalarFields = new Set([
  "targetUniversity", "targetProgramme", "targetProgrammeEnglishRaw", "offerYear",
  "undergraduateUniversity", "undergraduateMajor", "gpaRaw", "gpaScale", "gpa100",
  "languageTest", "languageScale", "languageScore", "sourcePublishedAt"
]);
const extractionArrayFields = new Set(["auxiliaryScores", "experiences"]);
const extractionRequiredFields = [
  ...extractionScalarFields,
  ...extractionArrayFields
];

export function validateExtractionPayload(payload) {
  if (!payload || !Array.isArray(payload.cases)) throw new Error("抽取结果缺少 cases 数组");
  for (const [index, candidate] of payload.cases.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`抽取结果 cases[${index}] 不是对象`);
    }
    const missing = extractionRequiredFields.filter(field => !Object.prototype.hasOwnProperty.call(candidate, field));
    if (missing.length) throw new Error(`抽取结果 cases[${index}] 缺少字段：${missing.join(", ")}`);
    for (const field of extractionScalarFields) {
      const value = candidate[field];
      if (value !== null && !["string", "number"].includes(typeof value)) {
        throw new Error(`抽取结果 cases[${index}].${field} 类型错误`);
      }
    }
    for (const field of extractionArrayFields) {
      if (!Array.isArray(candidate[field])) throw new Error(`抽取结果 cases[${index}].${field} 必须是数组`);
    }
  }
  return payload;
}

async function postChatCompletion({ url, key, body, timeoutMs, label }) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      const rawPayload = await response.text();
      let payload;
      try { payload = JSON.parse(rawPayload); } catch { payload = null; }
      if (!response.ok) {
        const message = payload?.error?.message || rawPayload.slice(0, 300) || `HTTP ${response.status}`;
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new Error(message);
      }
      if (!payload) throw new Error("接口未返回合法JSON");
      return payload;
    } catch (error) {
      lastError = error;
      const retryable = !["AbortError", "TimeoutError"].includes(error?.name);
      if (attempt < 2 && retryable) {
        await sleep(1000 * attempt);
        continue;
      }
    }
  }
  throw new Error(`${label}失败：${lastError?.message || "unknown error"}`);
}

const programmeMatcherPrompt = [
  "You map extracted admission-page programme names to an exact programme ID from a closed master list.",
  "Use the university and both Chinese/English names, including abbreviations and renamed programmes.",
  "Never invent an ID and never map across universities. Return null when the evidence is ambiguous or the programme is not in the list.",
  "Return only JSON with a matches array containing index, programmeId, confidence, and reason.",
  "Only high-confidence matches will be applied automatically."
].join("\n");

function programmeMatcherCandidates(institutionId) {
  return programmeMaster
    .filter(programme => programme.institutionId === institutionId)
    .map(programme => ({
      id: programme.id,
      nameZh: programme.nameZh,
      nameEn: programme.nameEn,
      aliases: unique([...(programme.aliases || [])]).slice(0, 8)
    }));
}

function localProgrammeForCase(row) {
  return resolveProgramme({
    universityName: row?.targetUniversity,
    programmeName: row?.targetProgramme,
    programmeEnglishName: row?.targetProgrammeEnglishRaw || row?.targetProgrammeEnRaw
  });
}

function caseProgrammeNeedsResolution(row) {
  const institutionId = resolveInstitution(row?.targetUniversity)?.id || row?.targetInstitutionId;
  if (!institutionId || (!row?.targetProgramme && !row?.targetProgrammeEnglishRaw && !row?.targetProgrammeEnRaw)) return false;
  const local = localProgrammeForCase(row);
  // A previously stored programme ID is not proof that the raw name was
  // matched correctly. Re-check same-university IDs when the raw name is
  // still unresolved, because old fuzzy matching could have selected the
  // wrong programme.
  return !local;
}

function isHighProgrammeMatch(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["high", "high-confidence", "true", "yes"].includes(normalized)) return true;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric >= 0.85;
}

async function mapProgrammeNamesWithModel(rows) {
  const pending = rows.map((row, index) => ({ row, index })).filter(item => caseProgrammeNeedsResolution(item.row));
  if (!pending.length) return { matches: new Map(), used: false, calls: 0, usage: null, errors: [] };
  const aiUrl = chatCompletionsUrl(process.env.COLLECTOR_MATCH_AI_API_URL || process.env.COLLECTOR_AI_API_URL || process.env.AI_API_URL);
  const aiKey = process.env.COLLECTOR_MATCH_AI_API_KEY || process.env.COLLECTOR_AI_API_KEY || process.env.AI_API_KEY;
  const aiModel = process.env.COLLECTOR_MATCH_AI_MODEL || process.env.COLLECTOR_AI_MODEL || process.env.AI_MODEL;
  if (!aiUrl || !aiKey || !aiModel) return { matches: new Map(), used: false, calls: 0, usage: null, errors: ["programme-matcher-api-not-configured"] };
  const grouped = new Map();
  for (const item of pending) {
    const institutionId = resolveInstitution(item.row.targetUniversity)?.id || item.row.targetInstitutionId;
    const group = grouped.get(institutionId) || [];
    group.push(item);
    grouped.set(institutionId, group);
  }
  const matches = new Map();
  const usages = [];
  const errors = [];
  let calls = 0;
  for (const [institutionId, group] of grouped) {
    const candidates = programmeMatcherCandidates(institutionId);
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50);
      try {
        const body = {
          model: aiModel,
          temperature: 0,
          enable_thinking: process.env.COLLECTOR_MATCH_AI_ENABLE_THINKING === "true",
          messages: [
            { role: "system", content: programmeMatcherPrompt },
            { role: "user", content: JSON.stringify({
              university: institutionMaster.find(item => item.id === institutionId)?.nameEn || institutionId,
              items: batch.map(item => ({
                index: item.index,
                targetUniversity: item.row.targetUniversity || null,
                targetProgramme: item.row.targetProgramme || null,
                targetProgrammeEnglishRaw: item.row.targetProgrammeEnglishRaw || item.row.targetProgrammeEnRaw || null
              })),
              masterProgrammes: candidates
            }) }
          ]
        };
        if (process.env.COLLECTOR_AI_JSON_MODE !== "false") body.response_format = { type: "json_object" };
        const payload = await postChatCompletion({
          url: chatCompletionsUrl(aiUrl),
          key: aiKey,
          body,
          timeoutMs: Number(process.env.COLLECTOR_MATCH_AI_TIMEOUT_MS || 30000),
          label: `programme matcher ${aiModel}`
        });
        calls += 1;
        if (payload?.usage) usages.push(payload.usage);
        const parsed = parseModelJson(payload?.choices?.[0]?.message?.content);
        for (const match of Array.isArray(parsed?.matches) ? parsed.matches : []) {
          const index = Number(match?.index);
          const programme = programmeMaster.find(item => item.id === match?.programmeId);
          if (!Number.isInteger(index) || !programme || programme.institutionId !== institutionId || !isHighProgrammeMatch(match?.confidence)) continue;
          if (!batch.some(item => item.index === index)) continue;
          matches.set(index, { programmeId: programme.id, confidence: "high", reason: String(match.reason || "closed-list programme match").slice(0, 300), model: aiModel });
        }
      } catch (error) {
        errors.push(`${institutionId}: ${error.message}`);
      }
    }
  }
  return { matches, used: calls > 0, calls, usage: addUsage(usages), errors };
}

async function resolveProgrammeIds(cases) {
  const resolved = cases.map(candidate => {
    const local = localProgrammeForCase(candidate);
    if (local) {
      return { ...candidate, targetProgrammeId: local.id, _programmeResolution: { method: "local-alias", programmeId: local.id } };
    }
    return candidate;
  });
  const modelResult = await mapProgrammeNamesWithModel(resolved);
  const mapped = resolved.map((candidate, index) => {
    const match = modelResult.matches.get(index);
    return match
      ? { ...candidate, targetProgrammeId: match.programmeId, _programmeResolution: { method: "llm-closed-list", ...match } }
      : candidate;
  });
  return { cases: mapped, ...modelResult };
}

async function extractWithModel(url, text, programmeId = null, programmeIds = []) {
  const aiUrl = chatCompletionsUrl(process.env.COLLECTOR_AI_API_URL || process.env.AI_API_URL);
  const aiKey = process.env.COLLECTOR_AI_API_KEY || process.env.AI_API_KEY;
  const aiModel = process.env.COLLECTOR_AI_MODEL || process.env.AI_MODEL;
  if (!aiUrl || !aiKey || !aiModel) throw new Error("案例采集模型尚未配置");
  const extractionPrompt = (await readFile(defaultExtractionPromptPath, "utf8")).trim();
  const requestBody = {
    model: aiModel,
    temperature: 0,
    messages: [
      { role: "system", content: extractionPrompt },
      { role: "user", content: JSON.stringify({
        url,
        routingContext: programmeIds.length > 1
          ? {
              targetProgrammes: programmeIds.map(id => {
                const target = programmeMaster.find(item => item.id === id);
                const university = target ? institutionMaster.find(item => item.id === target.institutionId) : null;
                return { programmeId: id, targetUniversity: university?.nameZh || null, targetProgramme: target?.nameZh || target?.nameEn || null };
              }),
              instruction: "仅用于限定本次任务范围，不是网页事实；所有字段仍必须以pageText为证据。"
            }
          : programmeId
          ? (() => {
              const target = programmeMaster.find(item => item.id === programmeId);
              const university = target ? institutionMaster.find(item => item.id === target.institutionId) : null;
              return {
                programmeId,
                targetUniversity: university?.nameZh || null,
                targetProgramme: target?.nameZh || target?.nameEn || null,
                instruction: "仅用于限定本次任务范围，不是网页事实；所有字段仍必须以pageText为证据。"
              };
            })()
          : null,
        // Keep the default request small enough for the standalone agent to
        // finish reliably on image-heavy detail pages. Callers can raise this
        // explicitly when a source needs more context.
        pageText: text.slice(0, Number(process.env.COLLECTOR_MAX_PAGE_CHARS || 8000))
      }) }
    ]
  };
  if (process.env.COLLECTOR_AI_JSON_MODE !== "false") requestBody.response_format = { type: "json_object" };
  if (["true", "false"].includes(process.env.COLLECTOR_AI_ENABLE_THINKING)) {
    requestBody.enable_thinking = process.env.COLLECTOR_AI_ENABLE_THINKING === "true";
  } else if (["enabled", "disabled"].includes(process.env.COLLECTOR_AI_THINKING)) {
    requestBody.thinking = { type: process.env.COLLECTOR_AI_THINKING };
  }
  const payload = await postChatCompletion({
    url: aiUrl,
    key: aiKey,
    body: requestBody,
    // Long, image-heavy case pages can take over a minute to structure. Keep
    // the timeout configurable, but avoid treating a slow valid page as a
    // source failure by default.
    timeoutMs: Number(process.env.COLLECTOR_AI_TIMEOUT_MS || 120000),
    label: `结构化抽取模型 ${aiModel}`
  });
  const parsed = validateExtractionPayload(parseModelJson(payload?.choices?.[0]?.message?.content));
  return { cases: parsed.cases, usage: payload?.usage || null, model: aiModel };
}

export function buildOcrRequestBody(model, content, enableThinking = process.env.COLLECTOR_OCR_ENABLE_THINKING === "true") {
  return {
    model,
    enable_thinking: Boolean(enableThinking),
    ...(!enableThinking ? { temperature: 0 } : {}),
    messages: [{ role: "user", content }]
  };
}

function inferOcrFieldsFromText(text) {
  const normalized = String(text || "").normalize("NFKC");
  const gpa = normalized.match(/(?:GPA|均分|平均分|绩点|学术成绩|本科|本)\s*[:：]?\s*(\d{1,3}(?:\s*\.\s*\d+)?(?:\s*\/\s*\d{1,3}(?:\s*\.\s*\d+)?)?)/iu);
  const language = normalized.match(/\b(IELTS|TOEFL|雅思|托福)\s*[:：]?\s*(?:N\/A|免除|无|([0-9]+(?:\s*\.\s*[0-9]+)?))/iu);
  const fields = {};
  if (gpa?.[1]) fields.gpaRaw = gpa[1].replace(/\s+/g, " ").trim();
  const offerYear = inferOfferYear(normalized) || inferCriticalOfferYear(normalized);
  if (offerYear) fields.offerYear = offerYear;
  if (language?.[1]) fields.languageTest = /IELTS|雅思/i.test(language[1]) ? "IELTS" : "TOEFL";
  if (language?.[2]) fields.languageScore = Number(language[2].replace(/\s+/g, ""));
  return fields;
}

export function normalizeOcrResponseText(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  let parsed;
  try { parsed = parseModelJson(raw); } catch { return raw; }
  if (!parsed || typeof parsed !== "object") return raw;
  const records = (Array.isArray(parsed) ? parsed : [parsed]).filter(item => item && typeof item === "object" && !Array.isArray(item));
  if (!records.length) return raw;
  const visibleText = records
    .map(item => item.rawText || item.text || item.visibleText || "")
    .filter(Boolean)
    .join("\n\n");
  const fields = inferOcrFieldsFromText(visibleText);
  for (const record of records) {
    for (const [key, value] of Object.entries(record.fields && typeof record.fields === "object" ? record.fields : {})) {
      if (value !== null && value !== undefined && String(value).trim()) fields[key] = value;
    }
  }
  const fieldLines = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
  if (!visibleText && !fieldLines.length) return raw;
  return [
    visibleText,
    fieldLines.length ? `[OCR_FIELDS]\n${fieldLines.join("\n")}` : ""
  ].filter(Boolean).join("\n\n").trim();
}

const structuredOcrPrompt = "Read visible text in the image(s). Return only JSON with rawText, fields, and confidence. fields must contain targetUniversity, targetProgramme, undergraduateUniversity, undergraduateMajor, gpaRaw, offerYear, languageTest, and languageScore. Copy only visible text; never infer or repair numbers. Use null for absent fields. Keep rawText verbatim and preserve image order.";

function addUsage(rows) {
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let found = false;
  for (const usage of rows.filter(Boolean)) {
    found = true;
    totals.prompt_tokens += Number(usage.prompt_tokens || 0);
    totals.completion_tokens += Number(usage.completion_tokens || 0);
    totals.total_tokens += Number(usage.total_tokens || 0);
  }
  return found ? totals : null;
}

async function extractImagesWithModel(imageUrls, config) {
  const { apiUrl, apiKey, model, enableThinking, timeoutMs, prompt, structured = false } = config;
  if (!apiUrl || !apiKey || !model) return { text: "", skippedReason: "ocr-api-not-configured", usage: null, model };
  const content = [
    ...imageUrls.map(url => ({ type: "image_url", image_url: { url } })),
    { type: "text", text: structured ? structuredOcrPrompt : prompt }
  ];
  const payload = await postChatCompletion({
    url: apiUrl,
    key: apiKey,
    body: buildOcrRequestBody(model, content, enableThinking),
    timeoutMs,
    label: `图像识别模型 ${model}`
  });
  return {
    text: normalizeOcrResponseText(messageContentText(payload?.choices?.[0]?.message?.content)),
    skippedReason: null,
    usage: payload?.usage || null,
    model
  };
}

async function extractWithOcr(imageUrls) {
  if (!imageUrls.length || process.env.COLLECTOR_OCR_MODE === "disabled") {
    return { text: "", skippedReason: imageUrls.length ? "disabled" : "no-images", usage: null, model: null };
  }
  const key = process.env.COLLECTOR_OCR_API_KEY || process.env.DASHSCOPE_API_KEY;
  const aiUrl = chatCompletionsUrl(
    process.env.COLLECTOR_OCR_API_URL || (key ? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" : null)
  );
  const model = process.env.COLLECTOR_OCR_MODEL || "qwen3.8-max";
  if (!aiUrl || !key) return { text: "", skippedReason: "ocr-api-not-configured" };
  try {
    return await extractImagesWithModel(imageUrls, {
      apiUrl: aiUrl,
      apiKey: key,
      model,
      enableThinking: process.env.COLLECTOR_OCR_ENABLE_THINKING === "true",
       timeoutMs: Number(process.env.COLLECTOR_OCR_TIMEOUT_MS || 60000),
       structured: true,
      prompt: "请逐字提取图片中的全部可见文字。不要总结、翻译或补全；如果有多张图片，按图片顺序输出。"
    });
  } catch (error) {
    if (process.env.COLLECTOR_OCR_REQUIRED === "true") throw error;
    return { text: "", skippedReason: error.message, usage: null, model };
  }
}

async function verifyCriticalFieldsWithOcr(imageUrls) {
  const key = process.env.COLLECTOR_VERIFY_API_KEY || process.env.COLLECTOR_OCR_API_KEY || process.env.DASHSCOPE_API_KEY;
  const apiUrl = chatCompletionsUrl(process.env.COLLECTOR_VERIFY_API_URL || process.env.COLLECTOR_OCR_API_URL
    || (key ? "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" : null));
  const model = process.env.COLLECTOR_VERIFY_MODEL || "qwen3.5-ocr";
  try {
    const results = [];
    for (const [index, imageUrl] of imageUrls.entries()) {
      const result = await extractImagesWithModel([imageUrl], {
        apiUrl,
        apiKey: key,
        model,
        enableThinking: false,
        timeoutMs: Number(process.env.COLLECTOR_VERIFY_TIMEOUT_MS || 120000),
        prompt: "这是录取案例的关键字段复核。请逐字输出图中的录取/入学年份、GPA/均分、IELTS/TOEFL类型与分数及相邻上下文。若没有这些字段，输出“未发现关键字段”。不要推断、翻译或改写数字。"
      });
      results.push({ ...result, index });
    }
    return {
      text: results.map(result => `[IMAGE ${result.index + 1}]\n${result.text}`).join("\n\n"),
      skippedReason: null,
      usage: addUsage(results.map(result => result.usage)),
      model
    };
  } catch (error) {
    return { text: "", skippedReason: error.message, usage: null, model };
  }
}

async function queueCandidates(candidates, rawLogPath, dryRun) {
  if (dryRun) return { extracted: candidates.length, queued: candidates.length, duplicates: 0, dryRun: true, candidates };
  const db = openCaseStore();
  let fresh;
  try {
    fresh = insertCases(db, candidates);
  } finally {
    db.close();
  }
  if (fresh.length) {
    await mkdir(dirname(rawLogPath), { recursive: true });
    await appendFile(rawLogPath, `${fresh.map(candidate => JSON.stringify(candidate)).join("\n")}\n`, "utf8");
  }
  return {
    extracted: candidates.length,
    queued: fresh.length,
    duplicates: candidates.length - fresh.length,
    database: defaultDbPath,
    rawLog: rawLogPath,
    candidates: fresh
  };
}

async function collectIndexedCase(record, programme, source, dryRun = false) {
  const sourceUrl = `${source.api.detailPath.replace(/\/$/, "")}/${record.id}`;
  const candidate = normalizeCandidate(normalizeEicIndexedCase(record, programme, source.api.detailPath), sourceUrl);
  const review = applyReviewPolicy(candidate);
  const normalized = { ...candidate, reviewStatus: review.status, issues: review.issues, reviewPolicy: review };
  const result = await queueCandidates([normalized], defaultRawLogPath, dryRun);
  if (!dryRun) {
    const db = openCaseStore();
    try {
      recordCrawlSource(db, {
        sourceUrl,
        status: "completed",
        programmeId: programme.id,
        extractedCount: 1,
        scopedCount: 1,
        queuedCount: result.queued,
        checkedAt: new Date().toISOString()
      });
    } finally { db.close(); }
  }
  return {
    ...result,
    extracted: 1,
    extractedCandidates: [normalized],
    scoped: 1,
    preservedUnmatched: 0,
    scopeDropped: 0,
    skipped: false,
    skipReason: null,
    modelCalled: false,
    extractionMethod: "structured-index",
    prefilter: { decision: "pass", score: null, programmeId: programme.id, reasons: ["eic-index-match"] },
    usage: { extraction: null, primaryOcr: null, criticalOcr: null },
    ocr: { used: false, imageCount: 0, textLength: 0, skippedReason: "structured-index", model: null },
    criticalVerification: { used: false, model: null, skippedReason: "structured-index" }
  };
}

export async function collectUrl(url, sources, options = {}) {
  const source = sourceForUrl(url, sources);
  if (!source) throw new Error(`域名未列入sources.json：${url}`);
  if (!options.forceRefresh) {
    const db = openCaseStore();
    try {
      const previous = options.programmeId
        ? crawlSourceForProgramme(db, url, options.programmeId)
        : getCrawlSource(db, url);
      if (previous?.status === "completed"
        && (!options.recheckEmpty || Number(previous.scoped_count || 0) > 0)) {
        return {
          extracted: 0,
          scoped: 0,
          scopeDropped: 0,
          queued: 0,
          duplicates: 0,
          skipped: true,
          skipReason: "source-already-collected",
          modelCalled: false,
          prefilter: {
            decision: "skip",
            score: null,
            programmeId: options.programmeId || null,
            reasons: ["source-already-collected"],
            previous
          },
          usage: { extraction: null, primaryOcr: null, criticalOcr: null },
          ocr: { used: false, imageCount: 0, textLength: 0, skippedReason: "source-already-collected", model: null },
          criticalVerification: { used: false, model: null, skippedReason: "source-already-collected" }
        };
      }
    } finally {
      db.close();
    }
  }
  const requestedProgrammeIds = unique([
    ...asArray(options.programmeIds),
    ...asArray(options.programmeId)
  ]);
  let page;
  try {
    page = await fetchPage(url, source);
    const rawPageText = stripHtml(page.html);
    let pageText = preparePageTextForSource(rawPageText, source.id);
    const imageUrls = selectOcrImageUrls(extractImageUrls(page.html, page.finalUrl), source);
    const ocrMode = process.env.COLLECTOR_OCR_MODE || "disabled";
    const rawPageHash = createHash("sha256").update(page.html || "").digest("hex");
    const sourceHasAuthoritativeHtml = ["thinkwithu-public-cases", "compassedu-public-cases"].includes(source.id)
      && !(source.id === "compassedu-public-cases" && /\/article(?:_|\/)\d+/.test(page.finalUrl));
    let cachedOcr = null;
    if (!options.refreshOcr && ocrMode !== "disabled" && source.ocrFallback === true && imageUrls.length > 0) {
      const db = openCaseStore();
      try {
        const candidate = getOcrCache(db, page.finalUrl);
        if (candidate?.page_hash === rawPageHash) cachedOcr = candidate;
      } finally { db.close(); }
    }
    const buildPrefilters = text => requestedProgrammeIds.map(programmeId => scorePageForExtraction({
      url: page.finalUrl, html: page.html, pageText: text, programmeId,
      allowDirectionOnly: Boolean(options.allowDirectionOnly),
      allowSparseDetail: Boolean(source.allowSparseDetail)
    }));
    const combinePrefilters = programmePrefilters => programmePrefilters.length <= 1
      ? programmePrefilters[0] || scorePageForExtraction({
          url: page.finalUrl, html: page.html, pageText, programmeId: null,
          allowSparseDetail: Boolean(source.allowSparseDetail)
        })
      : {
          decision: programmePrefilters.some(item => item.decision === "pass") ? "pass" : "skip",
          score: Math.max(...programmePrefilters.map(item => item.score)),
          programmeId: null,
          programmeIds: requestedProgrammeIds,
          perProgramme: programmePrefilters,
          reasons: programmePrefilters.some(item => item.decision === "pass") ? ["one-or-more-target-programmes-pass"] : ["all-target-programmes-skipped"]
        };
    let programmePrefilters = buildPrefilters(pageText);
    let prefilter = combinePrefilters(programmePrefilters);
    let ocr = cachedOcr
      ? { text: cachedOcr.text, skippedReason: "cache-hit", usage: null, model: cachedOcr.model, cacheHit: true }
      : { text: "", skippedReason: "text-page", usage: null, model: null, cacheHit: false };
    const weakTargetEvidence = programmePrefilters.some(item =>
      item.reasons?.includes("direction-only-match")
      || item.reasons?.includes("low-coverage-direction-only-match")
      || item.reasons?.some(reason => String(reason).startsWith("explicit-programme-conflict:"))
    );
    const ocrFallbackEligible = !sourceHasAuthoritativeHtml
      && source.ocrFallback === true
      && ocrMode !== "disabled"
      && imageUrls.length > 0
      // Image-first detail pages often contain neither the institution nor
      // field labels in HTML. Requiring a visible institution here would make
      // OCR unable to discover exactly those cases. The source opt-in keeps
      // this broad fallback limited to known image-backed sources.
      && programmePrefilters.some(item => item.detailUrl
        && (!item.enoughAdmissionFields
          || item.focusedTextLength < Number(process.env.COLLECTOR_OCR_TEXT_THRESHOLD || 5000)
          || weakTargetEvidence));
    if ((prefilter.decision === "skip" || weakTargetEvidence) && ocrFallbackEligible) {
      if (!cachedOcr) {
        ocr = await extractWithOcr(imageUrls);
        if (ocr.usage || ocr.text) {
          const db = openCaseStore();
          try {
            saveOcrCache(db, { sourceUrl: page.finalUrl, pageHash: rawPageHash, model: ocr.model, text: ocr.text });
          } finally { db.close(); }
        }
      }
      if (ocr.text) {
        const ocrEvidenceText = [pageHeadingText(page.html), ocr.text]
          .filter(Boolean)
          .join("\n\n[OCR_IMAGE_TEXT]\n");
        const ocrProgrammePrefilters = buildPrefilters(ocrEvidenceText);
        const ocrPrefilter = combinePrefilters(ocrProgrammePrefilters);
        // On image-first sources the HTML often contributes only SEO text.
        // When the initial match was weak, let the OCR evidence replace that
        // template for the decision and for the extraction prompt.
        if (source.ocrFallback === true && (weakTargetEvidence || prefilter.decision === "skip")) {
          pageText = ocrEvidenceText;
          programmePrefilters = ocrProgrammePrefilters;
          prefilter = ocrPrefilter;
        } else {
          pageText = `${pageText}\n\n[OCR_IMAGE_TEXT]\n${ocr.text}`;
          programmePrefilters = buildPrefilters(pageText);
          prefilter = combinePrefilters(programmePrefilters);
        }
      }
    }
  if (shouldSkipPagePrefilter(prefilter, options)) {
    if (!options.dryRun) {
      const db = openCaseStore();
      try {
        recordCrawlSource(db, { sourceUrl: url, finalUrl: page.finalUrl, status: "completed", programmeId: options.programmeId, checkedAt: new Date().toISOString() });
      } finally { db.close(); }
    }
    return {
      extracted: 0,
      scoped: 0,
      scopeDropped: 0,
      queued: 0,
      duplicates: 0,
      skipped: true,
      skipReason: "page-prefilter",
      modelCalled: false,
      prefilter,
      usage: { extraction: null, primaryOcr: ocr.usage, criticalOcr: null },
      ocr: { used: Boolean(ocr.text), cacheHit: Boolean(ocr.cacheHit), imageCount: imageUrls.length, textLength: ocr.text.length, skippedReason: ocr.skippedReason || "page-prefilter", model: ocr.model },
      criticalVerification: { used: false, model: null, skippedReason: "page-prefilter" }
    };
  }
  const structuredCases = extractStructuredCasesForSource(pageText, source.id);
  const shouldOcr = !ocr.text && !cachedOcr && !structuredCases.length && !sourceHasAuthoritativeHtml && imageUrls.length > 0
    && ocrMode === "always";
  if (shouldOcr) ocr = await extractWithOcr(imageUrls);
  const evidenceText = [pageText, ocr.text].filter(Boolean).join("\n\n[OCR_IMAGE_TEXT]\n");
  const pagePublishedAt = inferSourcePublishedAt(pageText);
  const pageHash = createHash("sha256").update(evidenceText).digest("hex");
  const currentModel = process.env.COLLECTOR_AI_MODEL || process.env.AI_MODEL || null;
  let cachedExtraction = null;
  if (!options.skipExtractionCache) {
    const db = openCaseStore();
    try { cachedExtraction = getExtractionCache(db, page.finalUrl); } finally { db.close(); }
  }
  // A newly available deterministic parser is authoritative and must be
  // allowed to replace an older, lower-quality LLM cache entry. Otherwise a
  // parser improvement would remain invisible until the page hash changes.
  const cacheUsable = Boolean(
    !structuredCases.length
    &&
    cachedExtraction
    && Array.isArray(cachedExtraction.cases)
    && (!cachedExtraction.model || cachedExtraction.model === currentModel)
    && (
      cachedExtraction.page_hash === pageHash
      || (
        options.recheckEmpty
        && prefilter.decision === "pass"
        && cachedCasesMatchProgrammes(cachedExtraction.cases, requestedProgrammeIds)
      )
    )
  );
  const extractionCacheHit = cacheUsable;
  const extraction = cacheUsable
    ? { cases: cachedExtraction.cases, usage: null, model: cachedExtraction.model, cacheHit: true }
    : structuredCases.length
      ? { cases: structuredCases, usage: null, model: null, cacheHit: false }
      : {
          ...(await extractWithModel(
            page.finalUrl,
            evidenceText,
            requestedProgrammeIds.length === 1 ? requestedProgrammeIds[0] : null,
            requestedProgrammeIds
          )),
          cacheHit: false
        };
  const programmeResolution = await resolveProgrammeIds(extraction.cases);
  const extractedCases = programmeResolution.cases;
  if ((!extractionCacheHit || programmeResolution.matches.size > 0) && !options.dryRun && !options.skipExtractionCache) {
    const db = openCaseStore();
    try {
      saveExtractionCache(db, {
        sourceUrl: page.finalUrl,
        pageHash,
        model: extraction.model || null,
        extractionMethod: structuredCases.length ? "structured-source" : "llm",
        cases: extractedCases.map(({ _programmeResolution, ...candidate }) => candidate)
      });
    } finally { db.close(); }
  }
  const requiresVerification = Boolean(ocr.text) && extractedCases.some(candidate => criticalVerificationReasons(candidate).length > 0);
  const secondaryOcr = requiresVerification
    ? await verifyCriticalFieldsWithOcr(imageUrls)
    : { text: "", skippedReason: "not-required", usage: null, model: process.env.COLLECTOR_VERIFY_MODEL || "qwen3.5-ocr" };
  const normalized = extractedCases.map(candidate => {
    const applied = requiresVerification && secondaryOcr.text
      ? applyCriticalVerification(candidate, secondaryOcr.text, { model: secondaryOcr.model })
      : {
          candidate,
          verification: requiresVerification
            ? { status: "unavailable", reasons: criticalVerificationReasons(candidate), unresolved: criticalVerificationReasons(candidate), model: secondaryOcr.model, checkedAt: new Date().toISOString() }
            : { status: "not-required", reasons: [], unresolved: [], model: null, checkedAt: new Date().toISOString() }
        };
    const sourceFieldText = source.id === "xdf-public-cases" ? `${pageText}\n${rawPageText}` : pageText;
    const recoveredCandidate = recoverGpaFromSourceText(applied.candidate, sourceFieldText, source.id);
    const resolvedOfferYear = resolveOfferYear(
      recoveredCandidate.offerYear,
      pageText,
      recoveredCandidate.sourcePublishedAt || pagePublishedAt
    );
    const anchoredTargetProgrammeId = options.trustedProgrammeId
      || anchoredProgrammeId(recoveredCandidate, requestedProgrammeIds, prefilter, source.id);
    const normalizedCandidate = normalizeCandidate({
      ...recoveredCandidate,
      ...(anchoredTargetProgrammeId ? { targetProgrammeId: anchoredTargetProgrammeId } : {}),
      offerYear: resolvedOfferYear.value,
      sourcePublishedAt: recoveredCandidate.sourcePublishedAt || pagePublishedAt,
      sourceEvidence: {
        ...verifyCandidateAgainstText({ ...recoveredCandidate, offerYear: resolvedOfferYear.value }, `${evidenceText}\n${sourceFieldText}`),
        inferred: resolvedOfferYear.inferred ? { offerYear: resolvedOfferYear.inferred } : {},
        criticalVerification: applied.verification,
        ocr: { used: Boolean(ocr.text), imageCount: imageUrls.length, imageUrls, textLength: ocr.text.length, skippedReason: ocr.skippedReason, model: ocr.model },
        ...(candidate._programmeResolution ? { programmeResolution: candidate._programmeResolution } : {}),
        ...(anchoredTargetProgrammeId ? { programmeScope: { method: "single-target-prefilter", programmeId: anchoredTargetProgrammeId } } : {})
      }
    }, page.finalUrl);
    const review = applyReviewPolicy(normalizedCandidate);
    return { ...normalizedCandidate, reviewStatus: review.status, issues: review.issues, reviewPolicy: review };
  });
  const scoped = filterCandidatesForProgrammes(normalized, requestedProgrammeIds);
  const queuedCandidates = candidatesForQueue(normalized, requestedProgrammeIds);
  const preservedUnmatched = queuedCandidates.length - scoped.length;
  const result = await queueCandidates(queuedCandidates, options.rawLogPath || defaultRawLogPath, options.dryRun);
  if (!options.dryRun) {
    const db = openCaseStore();
    try {
      recordCrawlSource(db, {
        sourceUrl: url,
        finalUrl: page.finalUrl,
        status: "completed",
        programmeId: requestedProgrammeIds.length === 1 ? requestedProgrammeIds[0] : null,
        extractedCount: normalized.length,
        scopedCount: scoped.length,
        queuedCount: result.queued,
        checkedAt: new Date().toISOString()
      });
    } finally { db.close(); }
  }
  return {
    ...result,
    extracted: normalized.length,
    extractedCandidates: normalized,
    scoped: scoped.length,
    preservedUnmatched,
    scopeDropped: normalized.length - queuedCandidates.length,
    skipped: false,
    skipReason: null,
    modelCalled: !structuredCases.length && !extractionCacheHit,
    extractionMethod: extractionCacheHit ? "cache" : structuredCases.length ? "structured-source" : "llm",
    cacheHit: extractionCacheHit,
    prefilter,
    usage: { extraction: extraction.usage, programmeMatching: programmeResolution.usage, primaryOcr: ocr.usage, criticalOcr: secondaryOcr.usage },
    ocr: { used: Boolean(ocr.text), cacheHit: Boolean(ocr.cacheHit), imageCount: imageUrls.length, textLength: ocr.text.length, skippedReason: ocr.skippedReason, model: ocr.model },
    criticalVerification: { used: Boolean(secondaryOcr.text), model: secondaryOcr.model, skippedReason: secondaryOcr.skippedReason }
  };
  } catch (error) {
    if (!options.dryRun) {
      const db = openCaseStore();
      try {
        recordCrawlSource(db, { sourceUrl: url, finalUrl: page?.finalUrl || null, status: "failed", programmeId: options.programmeId, error: error.message, checkedAt: new Date().toISOString() });
      } finally { db.close(); }
    }
    throw error;
  }
}

async function showStatus() {
  const db = openCaseStore();
  try {
    console.log(JSON.stringify({ database: defaultDbPath, rawLog: defaultRawLogPath, ...storeStatus(db) }, null, 2));
  } finally {
    db.close();
  }
}

async function listQueue(limit) {
  const db = openCaseStore();
  try {
    console.table(listCases(db, limit).map(row => ({
      fingerprint: row.fingerprint,
      status: row.reviewStatus,
      target: [row.targetUniversity, row.targetProgramme].filter(Boolean).join(" / "),
      undergraduate: row.undergraduateUniversity,
      gpa: row.gpaRaw || row.gpa100,
      language: [row.languageTest, row.languageScore, row.languageScale].filter(Boolean).join(" "),
      year: row.offerYear
    })));
  } finally {
    db.close();
  }
}

async function showRecord(fingerprint) {
  const db = openCaseStore();
  try {
    const record = getCase(db, fingerprint);
    if (!record) throw new Error(`没有找到案例：${fingerprint}`);
    console.log(JSON.stringify(record, null, 2));
  } finally {
    db.close();
  }
}

function updateReviewStatus(fingerprint, status) {
  const db = openCaseStore();
  try {
    console.log(JSON.stringify(reviewCase(db, fingerprint, status), null, 2));
  } finally {
    db.close();
  }
}

async function repairUnmatchedProgrammes(flags) {
  const limit = Math.max(1, Number(flags.find(flag => flag.startsWith("--limit="))?.split("=")[1] || 1000));
  const db = openCaseStore();
  try {
    const rows = db.prepare(`SELECT fingerprint, target_programme_id AS targetProgrammeId,
      target_institution_id AS targetInstitutionId, target_university AS targetUniversity,
      target_programme AS targetProgramme, target_programme_en_raw AS targetProgrammeEnglishRaw,
      offer_year AS offerYear
      FROM cases WHERE review_status = 'needs-review' ORDER BY collected_at DESC LIMIT ?`).all(limit);
    const eligible = rows.filter(row => {
      const institutionId = resolveInstitution(row.targetUniversity)?.id || row.targetInstitutionId;
      return targetInstitutionIds.includes(institutionId);
    });
    const result = await resolveProgrammeIds(eligible);
    let reassigned = 0;
    let autoApproved = 0;
    const failures = [];
    for (const [index, candidate] of result.cases.entries()) {
      const previous = eligible[index];
      if (!candidate.targetProgrammeId || candidate.targetProgrammeId === previous.targetProgrammeId) continue;
      try {
        reassignCaseProgramme(db, previous.fingerprint, candidate.targetProgrammeId, {
          reviewer: "programme-matcher",
          reason: candidate._programmeResolution?.method || "programme-resolution"
        });
        reassigned += 1;
        const updated = getCase(db, previous.fingerprint);
        const decision = applyReviewPolicy(updated);
        if (decision.status === "approved" && Number(updated.offerYear) >= 2021) {
          reviewCase(db, previous.fingerprint, "approved", { reviewer: "programme-matcher", reason: decision.reason });
          autoApproved += 1;
        }
      } catch (error) {
        failures.push({ fingerprint: previous.fingerprint, error: error.message });
      }
    }
    console.log(JSON.stringify({
      scanned: rows.length,
      eligible: eligible.length,
      modelCalls: result.calls,
      modelMatched: result.matches.size,
      reassigned,
      autoApproved,
      modelErrors: result.errors,
      failures
    }, null, 2));
  } finally {
    db.close();
  }
}

function cleanOutOfScopeCases() {
  const db = openCaseStore();
  try {
    const rows = db.prepare(`SELECT fingerprint, target_institution_id AS targetInstitutionId,
      target_university AS targetUniversity, offer_year AS offerYear, review_status AS reviewStatus
      FROM cases WHERE review_status IN ('approved', 'needs-review', 'pending')`).all();
    let outside = 0;
    let old = 0;
    for (const row of rows) {
      const institutionId = resolveInstitution(row.targetUniversity)?.id || row.targetInstitutionId;
      const reason = !targetInstitutionIds.includes(institutionId)
        ? "outside-hksg7-scope"
        : Number(row.offerYear) <= 2020 ? "offer-year-before-2021" : null;
      if (!reason) continue;
      reviewCase(db, row.fingerprint, "rejected", { reviewer: "scope-policy", reason });
      if (reason === "outside-hksg7-scope") outside += 1;
      else old += 1;
    }
    console.log(JSON.stringify({ scanned: rows.length, rejectedOutsideScope: outside, rejectedBefore2021: old }, null, 2));
  } finally {
    db.close();
  }
}

function showMasterData() {
  const db = openCaseStore();
  try {
    console.log(JSON.stringify(listMasterData(db), null, 2));
  } finally {
    db.close();
  }
}

function showAgentRuns(limit) {
  const db = openCaseStore();
  try {
    console.log(JSON.stringify(listAgentRuns(db, limit), null, 2));
  } finally {
    db.close();
  }
}

function showCoverage(programmeId) {
  const db = openCaseStore();
  try {
    console.log(JSON.stringify(caseCoverage(db, programmeId), null, 2));
  } finally {
    db.close();
  }
}

function programmeStatusFilter(flags) {
  const value = flags.find(flag => flag.startsWith("--status="))?.split("=").slice(1).join("=");
  return value ? value.split(",").map(item => item.trim()).filter(Boolean) : [];
}

function showProgrammeStatuses(flags) {
  const db = openCaseStore();
  try {
    const statuses = listProgrammeStatuses(db, programmeStatusFilter(flags));
    console.log(JSON.stringify({
      total: statuses.length,
      counts: Object.fromEntries([...new Set(statuses.map(status => status.status))].map(status => [status, statuses.filter(item => item.status === status).length])),
      statuses
    }, null, 2));
  } finally {
    db.close();
  }
}

function showProgrammeScopes(flags) {
  const db = openCaseStore();
  try {
    const value = flags.find(flag => flag.startsWith("--scope="))?.split("=").slice(1).join("=");
    const scopes = listProgrammeScopes(db, value ? value.split(",").map(item => item.trim()).filter(Boolean) : []);
    console.log(JSON.stringify({
      total: scopes.length,
      counts: Object.fromEntries([...new Set(scopes.map(scope => scope.scope))].map(scope => [scope, scopes.filter(item => item.scope === scope).length])),
      scopes
    }, null, 2));
  } finally {
    db.close();
  }
}

async function classifyProgrammeScopeCommand(target, flags) {
  const limitFlag = flags.find(flag => flag.startsWith("--limit="));
  const limit = Math.max(1, Number(limitFlag?.split("=")[1] || Number.MAX_SAFE_INTEGER));
  const isInstitution = target && targetInstitutionIds.includes(target);
  const db = openCaseStore();
  try {
    const result = classifyProgrammeScopes({
      db,
      programmeIds: target && !isInstitution && target !== "all" ? [target] : [],
      institutionIds: isInstitution ? [target] : target === "all" ? targetInstitutionIds : target ? [] : targetInstitutionIds,
      limit
    });
    const outputPath = resolve(collectorRoot, "data", `programme-scope-audit-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), "utf8");
    console.log(JSON.stringify({ outputPath, classified: result.classified, counts: result.counts }, null, 2));
  } finally {
    db.close();
  }
}

async function verifyProgrammeStatusCommand(target, flags) {
  const limitFlag = flags.find(flag => flag.startsWith("--limit="));
  const concurrencyFlag = flags.find(flag => flag.startsWith("--concurrency="));
  const limit = Math.max(1, Number(limitFlag?.split("=")[1] || Number.MAX_SAFE_INTEGER));
  const concurrency = Math.max(1, Number(concurrencyFlag?.split("=")[1] || 4));
  const isInstitution = target && targetInstitutionIds.includes(target);
  const result = await verifyProgrammeStatuses({
    programmeIds: target && !isInstitution && target !== "all" ? [target] : [],
    institutionIds: isInstitution ? [target] : target === "all" ? targetInstitutionIds : target ? [] : targetInstitutionIds,
    limit,
    concurrency,
    force: flags.includes("--refresh"),
    checkRobots: !flags.includes("--skip-robots")
  });
  const outputPath = resolve(collectorRoot, "data", `programme-status-audit-${Date.now()}.json`);
  await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), "utf8");
  console.log(JSON.stringify({ outputPath, checked: result.checked, skipped: result.skipped, counts: result.counts }, null, 2));
}

async function showCollectionPlan(target, sources, flags) {
  const db = openCaseStore();
  try {
    const limitFlag = flags.find(flag => flag.startsWith("--limit="));
    const limit = Math.max(1, Number(limitFlag?.split("=")[1] || 20));
    const targetApproved = Math.max(1, Number(flags.find(flag => flag.startsWith("--target-approved="))?.split("=")[1] || DEFAULT_APPROVED_TARGET));
    const institutionIds = target && target !== "engineering" ? [target] : targetInstitutionIds;
    const plans = buildLowCoverageProgrammePlans({ db, sources, targetApproved, limit, institutionIds });
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      targetApproved,
      plans: plans.map(plan => ({
        programmeId: plan.programmeId,
        programme: plan.programme,
        programmeStatus: plan.programmeStatus,
        coverage: plan.coverage,
        sourceCount: plan.sourceCount,
        sourceCandidates: plan.sourceCandidates,
        needsSourceDiscovery: plan.needsSourceDiscovery
      }))
    }, null, 2));
  } finally {
    db.close();
  }
}

export function planNextAgentAction({ coverage, goal, sourceUrls, sourceCandidates, visitedUrls = [], stopOnPending = true }) {
  if ((coverage.approved2021 ?? coverage.approved) >= goal.targetApproved) return { action: "stop", reason: "target-satisfied" };
  if (stopOnPending && (coverage.pending2021 ?? coverage.pending) > 0) return { action: "stop", reason: "awaiting-human-review" };
  if (goal.apiCalls >= goal.maxApiCalls) return { action: "stop", reason: "api-budget-reached" };
  if (goal.errors >= goal.maxErrors) return { action: "stop", reason: "error-budget-reached" };
  const candidates = (sourceCandidates || asArray(sourceUrls).map(url => ({ url })))
    .filter(candidate => candidate?.url && !visitedUrls.includes(candidate.url));
  if (!candidates.length) return { action: "stop", reason: "sources-exhausted" };
  const separateDetailBudget = Number.isFinite(Number(goal.maxDetailAttempts));
  const detailAttempts = Number(goal.detailAttempts || 0);
  const maxDetailAttempts = separateDetailBudget
    ? Number(goal.maxDetailAttempts)
    : Number(goal.maxPages);
  const detailCandidates = candidates.filter(candidate => candidate.kind !== "seed");
  // Keep the legacy total-page guard for callers that do not opt into the
  // split budget. The expansion runner opts in so pagination cannot consume
  // the entire detail-page budget.
  if (!separateDetailBudget && goal.pagesAttempted >= goal.maxPages) {
    return { action: "stop", reason: "page-budget-reached" };
  }
  let eligibleCandidates = candidates;
  if (separateDetailBudget && goal.pagesAttempted >= goal.maxPages) {
    eligibleCandidates = detailCandidates;
  }
  if (separateDetailBudget && detailAttempts >= maxDetailAttempts) {
    eligibleCandidates = eligibleCandidates.filter(candidate => candidate.kind === "seed");
  }
  if (!eligibleCandidates.length) {
    return { action: "stop", reason: detailAttempts >= maxDetailAttempts ? "detail-budget-reached" : "page-budget-reached" };
  }
  const searchDetails = new Set(["hksg-search", "mastermate-search", "bing", "seed-page", "eic-index"]);
  const searchSeeds = new Set(["hksg-search", "mastermate-search", "compass-search", "bing", "seed-page"]);
  const rank = candidate => {
    // Collect already discovered details before opening more pagination pages.
    // A seed page is only useful after its currently visible case details have
    // had a chance to pass the cheap page-level filter.
    if (candidate.kind === "detail" && candidate.targetMatched) return 0;
    if (candidate.kind === "detail"
      && ["hksg-search", "mastermate-search", "eic-index", "compass-search"].includes(candidate.discoveredBy)) return 0.5;
    if (candidate.kind === "detail" && candidate.discoveredBy === "seed-page") return 1 + Math.min(3, Math.max(0, Number(candidate.casePriority ?? 1)));
    if (candidate.kind === "seed" && candidate.discoveredBy === "seed-page") return 1.5 + Math.min(3, Math.max(0, Number(candidate.casePriority ?? 1)));
    if (candidate.kind === "seed" && candidate.discoveredBy === "configured-source") return 1.75 + Math.min(3, Math.max(0, Number(candidate.casePriority ?? 1)));
    if (candidate.kind === "seed" && searchSeeds.has(candidate.discoveredBy)) return 2;
    if (candidate.kind === "detail" && searchDetails.has(candidate.discoveredBy)) return 3;
    if (candidate.kind === "detail" && Number(candidate.priority) === 0) return 4;
    if (candidate.kind === "detail" && candidate.discoveredBy === "configured-source") return 4;
    if (candidate.kind === "detail") return 6;
    if (candidate.kind === "seed") return 7;
    return 7;
  };
  const candidate = [...eligibleCandidates].sort((a, b) => rank(a) - rank(b))[0];
  const action = candidate.kind === "seed" ? "discover-seed" : "collect";
  return {
    action,
    url: candidate.url,
    ...(candidate.sourceId ? { sourceId: candidate.sourceId } : {}),
    ...(candidate.kind ? { kind: candidate.kind } : {})
  };
}

async function runCollectionAgent(programmeId, sources, flags) {
  const programme = programmeMaster.find(item => item.id === programmeId);
  if (!programme) throw new Error(`项目主表中没有：${programmeId}`);
  const numberFlag = (name, fallback) => {
    const value = flags.find(flag => flag.startsWith(`--${name}=`))?.split("=")[1];
    return Math.max(1, Number(value || fallback));
  };
  const goal = {
    programmeId,
    targetApproved: numberFlag("target-approved", 10),
    maxPages: numberFlag("max-pages", 10),
    maxDetailAttempts: numberFlag("max-detail-pages", Math.max(numberFlag("max-pages", 10), 8)),
    maxApiCalls: numberFlag("max-api-calls", 10),
    maxErrors: numberFlag("max-errors", 3)
  };
  const report = {
    id: randomUUID(), goal, state: "running", stopReason: null,
    pagesAttempted: 0, detailAttempts: 0, apiCalls: 0, searchPlannerCalls: 0, searchPlannerTokens: 0, errors: 0,
    ocrCalls: 0, ocrTokens: 0, extractionTokens: 0,
    startedAt: new Date().toISOString(), finishedAt: null, steps: [], staleAfterMs: 30 * 60 * 1000
  };
  const db = openCaseStore();
  const programmeScope = getProgrammeScope(db, programmeId);
  if (!programmeScopeAllowed(programmeScope) && !flags.includes("--force-scope")) {
    db.close();
    throw new Error(`项目范围为 ${programmeScope.scope}，默认跳过案例采集；如需强制运行请使用 --force-scope`);
  }
  const programmeStatus = getProgrammeStatus(db, programmeId);
  if (!programmeCollectionAllowed(programmeStatus) && !flags.includes("--force-status")) {
    db.close();
    throw new Error(`项目状态为 ${programmeStatus.status}，默认跳过案例采集；如需强制运行请使用 --force-status`);
  }
  const eligibility = programmeCollectionEligibility({
    scope: programmeScope,
    status: programmeStatus,
    coverage: caseCoverage(db, programmeId),
    searchEvidence: programmeSearchEvidence(db, programmeId),
    targetApproved: goal.targetApproved
  });
  if (!eligibility.eligible && !flags.includes("--force-eligibility")) {
    db.close();
    throw new Error(`项目当前不进入常规采集：${eligibility.exclusion}；如需强制运行请使用 --force-eligibility`);
  }
  startAgentRun(db, report);
  activeAgentRun = { db, report };
  const visitedUrls = [];
  const sourceNoProgress = new Map();
  const searchOnly = !flags.includes("--allow-generic-sources");
  const sourceCandidates = buildSourceCandidates(programme, sources);
  // Programme-scoped collection still requires explicit programme evidence for
  // automatic approval. Information-rich ambiguous pages may enter the model
  // through the controlled inference option; the final programme-ID filter
  // remains mandatory.
  const allowDirectionOnlyDiscovery = false;
  const seenIndexedIds = new Set();
  const searchBudget = numberFlag("search-sources", 14);
  const searchRequestBudget = numberFlag("search-requests", 42);
  let remainingSearchRequests = searchRequestBudget;
  let searchPlan = { status: "disabled", queryTerms: [], model: null, cacheHit: false, usage: null };
  if (!flags.includes("--skip-search")) {
  const effectiveSearchSourceLimit = allocateSearchSourceRotationLimit(searchBudget, searchRequestBudget, sources.length);
  const searchableSources = sources
    .filter(source => source.hosts?.length && source.detailRegexes?.length)
    .sort((a, b) => Number(a.searchPriority ?? 1) - Number(b.searchPriority ?? 1) || String(a.id).localeCompare(String(b.id)))
    .slice(0, effectiveSearchSourceLimit);
    if (!flags.includes("--skip-search-planner")) {
      try {
        searchPlan = await withDiscoveryTimeout(
          buildSearchPlan(programme, searchableSources),
          "search planner"
        );
      } catch (error) {
        searchPlan = { status: "failed", queryTerms: [], model: process.env.COLLECTOR_SEARCH_AI_MODEL || null, cacheHit: false, usage: null, error: error.message };
      }
      report.searchPlannerCalls += searchPlan.status === "generated" ? 1 : 0;
      report.searchPlannerTokens += Number(searchPlan.usage?.total_tokens || 0);
      const plannerStep = {
        index: report.steps.length + 1,
        action: "plan-search-queries",
        status: searchPlan.status === "failed" ? "failed" : "completed",
        detail: {
          model: searchPlan.model,
          cacheHit: Boolean(searchPlan.cacheHit),
          termCount: searchPlan.queryTerms.length,
          queryTerms: searchPlan.queryTerms,
          error: searchPlan.error || null
        },
        createdAt: new Date().toISOString()
      };
      report.steps.push(plannerStep);
      appendAgentStep(db, report.id, plannerStep);
    }
    // Search sources concurrently. Budgets are allocated up front so parallel
    // requests still rotate across websites instead of letting one source
    // consume the whole batch. The result processing below remains ordered so
    // queue ranking and the persisted report stay deterministic.
    const sourceBudgets = [];
    let budgetForAllocation = remainingSearchRequests;
    for (let sourceIndex = 0; sourceIndex < searchableSources.length; sourceIndex += 1) {
      const remainingSources = searchableSources.length - sourceIndex;
      const sourceSearchBudget = Math.max(
        1,
        Math.min(budgetForAllocation, Math.ceil(budgetForAllocation / remainingSources))
      );
      sourceBudgets.push(sourceSearchBudget);
      budgetForAllocation -= sourceSearchBudget;
    }
    const discoveryResults = await Promise.all(searchableSources.map(async (source, sourceIndex) => {
      const sourceSearchBudget = sourceBudgets[sourceIndex];
      try {
        const discovered = await withDiscoveryTimeout(
          source.search?.kind === "hksg-web"
            ? discoverHksgCaseCandidates(programme, source, { maxResults: 20, maxRequests: sourceSearchBudget, searchPlan, allowDirectionOnly: allowDirectionOnlyDiscovery })
            : source.search?.kind === "mastermate-api"
              ? discoverMastermateCaseCandidates(programme, source, { maxResults: 20, maxRequests: sourceSearchBudget, searchPlan, allowDirectionOnly: allowDirectionOnlyDiscovery })
              : source.search?.kind === "compass-index"
                ? discoverCompassCaseCandidates(programme, source, { maxResults: 20, maxRequests: sourceSearchBudget, searchPlan })
                : source.seedUrls?.length
                  ? (async () => {
                    const seeded = await discoverSeedCaseCandidates(programme, source, { maxResults: 20, maxSeeds: Math.min(sourceSearchBudget, Math.max(source.seedUrls.length, Number(source.paginationMaxPages) || 1)) });
                    const remaining = Math.max(0, sourceSearchBudget - Number(seeded.requestCount || 0));
                    const seededHasExplicitProgramme = (seeded.attempts || []).some(attempt =>
                      (attempt.candidates || []).some(candidate =>
                        candidate.kind === "detail"
                        && (candidate.programmeHits || []).some(hit => !isGenericProgrammeSearchTerm(hit))
                      )
                    );
                    if (seededHasExplicitProgramme || remaining <= 0) return seeded;
                    const searched = await discoverCaseUrlsBySearch(programme, source, { maxResults: 10, maxQueries: remaining, searchPlan });
                    return {
                      ...searched,
                      urls: unique([...(seeded.urls || []), ...(searched.urls || [])]),
                      entryUrls: unique([...(seeded.entryUrls || []), ...(searched.entryUrls || [])]),
                      attempts: [...(seeded.attempts || []), ...(searched.attempts || [])],
                      requestCount: Number(seeded.requestCount || 0) + Number(searched.requestCount || searched.attempts?.length || 0),
                      discoveryFunnel: {
                        ...(searched.discoveryFunnel || {}),
                        seedAttempts: seeded.attempts || [],
                        seedsProbed: seeded.discoveryFunnel?.seedsProbed || 0
                      },
                      discoveredBy: searched.discoveredBy || seeded.discoveredBy
                    };
                  })()
                  : discoverCaseUrlsBySearch(programme, source, { maxResults: 10, maxQueries: sourceSearchBudget, searchPlan }),
          `source discovery ${source.id}`
        );
        return { source, sourceSearchBudget, discovered };
      } catch (error) {
        return { source, sourceSearchBudget, error };
      }
    }));
    for (const { source, sourceSearchBudget, discovered, error } of discoveryResults) {
      if (error) {
        remainingSearchRequests -= 1;
        const searchStep = { index: report.steps.length + 1, action: "discover-search-results", status: "failed", detail: { sourceId: source.id, error: error.message }, createdAt: new Date().toISOString() };
        report.steps.push(searchStep);
        appendAgentStep(db, report.id, searchStep);
        continue;
      }
      try {
        remainingSearchRequests -= Math.min(sourceSearchBudget, Number(discovered.requestCount || discovered.attempts?.length || 1));
        for (const url of discovered.urls) {
          const canonicalUrl = canonicalizeCandidateUrl(url);
          const discoveredBy = source.search?.kind === "hksg-web"
            ? "hksg-search"
            : source.search?.kind === "mastermate-api"
              ? "mastermate-search"
              : discovered.discoveredBy || "bing";
          const sourceMatch = discovered.matchByUrl?.[canonicalUrl];
          const existingCandidate = sourceCandidates.find(candidate => canonicalizeCandidateUrl(candidate.url) === canonicalUrl);
          if (existingCandidate) {
            existingCandidate.discoveredBy ||= discoveredBy;
            if (sourceMatch?.programmeId) existingCandidate.trustedProgrammeId = sourceMatch.programmeId;
          } else {
            sourceCandidates.unshift({
              url: canonicalUrl,
              sourceId: source.id || null,
              priority: 0,
              kind: "detail",
              discoveredBy,
              ...(sourceMatch?.programmeId ? { trustedProgrammeId: sourceMatch.programmeId } : {}),
              casePriority: Number(source.casePriority ?? 1)
            });
          }
        }
        for (const url of discovered.entryUrls || []) {
          const canonicalUrl = canonicalizeCandidateUrl(url);
          if (!sourceCandidates.some(candidate => canonicalizeCandidateUrl(candidate.url) === canonicalUrl)) {
            const discoveredBy = source.search?.kind === "hksg-web"
              ? "hksg-search"
              : source.search?.kind === "mastermate-api"
                ? "mastermate-search"
                : source.search?.kind === "compass-index"
                  ? "compass-search"
                  : discovered.discoveredBy || "bing";
            const entryCandidate = { url: canonicalUrl, sourceId: source.id || null, priority: 0, kind: "seed", discoveredBy, casePriority: Number(source.casePriority ?? 1) };
            if (source.search?.kind === "hksg-web") sourceCandidates.unshift(entryCandidate);
            else sourceCandidates.push(entryCandidate);
          }
        }
        const searchStep = { index: report.steps.length + 1, action: "discover-search-results", status: "completed", detail: { sourceId: source.id, query: discovered.query || null, found: discovered.urls.length, entries: discovered.entryUrls?.length || 0, funnel: discovered.discoveryFunnel || null, attempts: discovered.attempts || [] }, createdAt: new Date().toISOString() };
        report.steps.push(searchStep);
        appendAgentStep(db, report.id, searchStep);
      } catch (error) {
        remainingSearchRequests -= 1;
        const searchStep = { index: report.steps.length + 1, action: "discover-search-results", status: "failed", detail: { sourceId: source.id, error: error.message }, createdAt: new Date().toISOString() };
        report.steps.push(searchStep);
        appendAgentStep(db, report.id, searchStep);
      }
    }
  }
  const eicSource = sources.find(source => source.api?.kind === "eic-case-library");
  const eicPages = numberFlag("index-pages", 3);
  if (eicSource && !flags.includes("--skip-index")) {
    for (let pageNo = 1; pageNo <= eicPages; pageNo += 1) {
      try {
        const indexed = await withDiscoveryTimeout(
          discoverEicCaseRecords(programme, eicSource, { pageNo, pageSize: 10 }),
          `EIC index discovery page ${pageNo}`
        );
        let added = 0;
        for (const item of indexed.records) {
          const record = item.record;
          if (!record?.id || seenIndexedIds.has(String(record.id))) continue;
          seenIndexedIds.add(String(record.id));
          const url = parseEicApiUrl(record, eicSource);
          if (url && !sourceCandidates.some(candidate => candidate.url === url)) {
            sourceCandidates.unshift({ url, sourceId: eicSource.id, priority: 0, kind: "detail", discoveredBy: "eic-index", indexedCase: record });
            added += 1;
          }
        }
        const indexStep = { index: report.steps.length + 1, action: "discover-index-results", status: "completed", detail: { sourceId: eicSource.id, pageNo, total: indexed.total, matched: indexed.records.length, added }, createdAt: new Date().toISOString() };
        report.steps.push(indexStep);
        appendAgentStep(db, report.id, indexStep);
        if (!added && pageNo > 1) break;
      } catch (error) {
        const indexStep = { index: report.steps.length + 1, action: "discover-index-results", status: "failed", detail: { sourceId: eicSource.id, pageNo, error: error.message }, createdAt: new Date().toISOString() };
        report.steps.push(indexStep);
        appendAgentStep(db, report.id, indexStep);
        break;
      }
    }
  }
  if (searchOnly && (caseCoverage(db, programmeId).approved2021 ?? 0) < goal.targetApproved) {
    const dynamicKinds = new Set(["hksg-search", "mastermate-search", "bing", "compass-search", "eic-index"]);
    const nativeSearchKinds = new Set(["hksg-web", "mastermate-api", "compass-index"]);
    const hasUsableDiscoveredCandidate = sourceCandidates.some(candidate => {
      if (!dynamicKinds.has(candidate.discoveredBy)) return false;
      if (candidate.kind === "seed") return true;
      if (candidate.kind !== "detail") return false;
      const source = candidate.sourceId ? sources.find(item => item.id === candidate.sourceId) : sourceForUrl(candidate.url, sources);
      if (nativeSearchKinds.has(source?.search?.kind)
        && hasStoredCaseForSourceUrl(db, candidate.url)
        && candidate.trustedProgrammeId !== programmeId) return false;
      return crawlSourceNeedsAttempt(crawlSourceForProgramme(db, candidate.url, programmeId), programmeId);
    });
    if (!hasUsableDiscoveredCandidate) {
      try {
        const bootstrap = await withDiscoveryTimeout(
          probeConfiguredFallbackCandidates(programme, sources, db, {
            maxProbes: numberFlag("bootstrap-probes", 6),
            maxCandidates: numberFlag("bootstrap-candidates", 2),
            allowDirectionOnly: allowDirectionOnlyDiscovery
          }),
          "configured fallback prefilter"
        );
        for (const candidate of bootstrap.candidates) {
          const existing = sourceCandidates.find(item => item.url === candidate.url);
          if (existing) Object.assign(existing, candidate);
          else sourceCandidates.push(candidate);
        }
        const bootstrapStep = {
          index: report.steps.length + 1,
          action: "discover-bootstrap-sources",
          status: "completed",
          detail: {
            probes: bootstrap.attempts.length,
            accepted: bootstrap.candidates.length,
            attempts: bootstrap.attempts
          },
          createdAt: new Date().toISOString()
        };
        report.steps.push(bootstrapStep);
        appendAgentStep(db, report.id, bootstrapStep);
      } catch (error) {
        report.errors += 1;
        const bootstrapStep = {
          index: report.steps.length + 1,
          action: "discover-bootstrap-sources",
          status: "failed",
          detail: { error: error.message },
          createdAt: new Date().toISOString()
        };
        report.steps.push(bootstrapStep);
        appendAgentStep(db, report.id, bootstrapStep);
      }
    }
  }
  const stopOnPending = !flags.includes("--allow-pending");
  try {
    for (;;) {
      const coverage = caseCoverage(db, programmeId);
      const availableSourceCandidates = sourceCandidates.filter(candidate => {
        if (searchOnly && candidate.discoveredBy && !["bing", "eic-index", "hksg-search", "mastermate-search", "compass-search", "seed-page", "fallback-prefilter"].includes(candidate.discoveredBy)) return false;
        const source = candidate.sourceId ? sources.find(item => item.id === candidate.sourceId) : sourceForUrl(candidate.url, sources);
        const sourceKey = candidate.sourceId || source?.id || null;
        // A source with two unproductive detail pages should stop spending
        // detail budget, but its pagination seed may still lead to a new
        // frontier. Keep seeds available so the run can advance instead of
        // declaring sources exhausted at the first page.
        if (candidate.kind !== "seed" && sourceKey && Number(sourceNoProgress.get(sourceKey) || 0) >= 2) return false;
        if (candidate.kind === "detail" && ["hksg-web", "mastermate-api", "compass-index"].includes(source?.search?.kind)
          && hasStoredCaseForSourceUrl(db, candidate.url)
          && candidate.trustedProgrammeId !== programmeId
          && !flags.includes("--recheck-empty")) return false;
        const previous = crawlSourceForProgramme(db, candidate.url, programmeId);
        if (candidate.discoveredBy === "fallback-prefilter") {
          return fallbackPrefilterNeedsAttempt(db, candidate.url, programmeId);
        }
        // Keep pagination pages replayable so a later batch can advance the
        // frontier after the current run's page budget stops it. Detail URLs
        // remain protected by their normal crawl state and URL de-duplication.
        if (candidate.kind === "seed" && candidate.discoveredBy === "seed-page") return true;
        return flags.includes("--recheck-empty")
          ? previous?.status !== "completed"
            || Number(previous?.scoped_count || 0) === 0
            || previous?.programme_id !== programmeId
          : crawlSourceNeedsAttempt(previous, programmeId);
       });
      const visitedSourceIds = new Set(visitedUrls.map(url => sourceForUrl(url, sources)?.id).filter(Boolean));
      const expansionSources = new Set(["hksg-search", "mastermate-search", "compass-search", "seed-page", "fallback-prefilter"]);
      const freshSourceCandidates = availableSourceCandidates.filter(candidate =>
        expansionSources.has(candidate.discoveredBy) || !visitedSourceIds.has(candidate.sourceId)
      );
      const planningCandidates = freshSourceCandidates.length ? freshSourceCandidates : availableSourceCandidates;
      const decision = planNextAgentAction({
        coverage,
      goal: { ...goal, pagesAttempted: report.pagesAttempted, apiCalls: report.apiCalls, errors: report.errors },
        sourceCandidates: planningCandidates,
        visitedUrls,
        stopOnPending
      });
      const step = {
        index: report.steps.length + 1,
        action: decision.action === "collect" ? "collect-source"
          : decision.action === "discover-seed" ? "discover-seed"
            : "evaluate-stop-condition",
        status: ["collect", "discover-seed"].includes(decision.action) ? "planned" : "stopped",
         detail: { decision, coverage, sourceCandidates: planningCandidates.length, availableSourceCandidates: availableSourceCandidates.length, searchOnly },
        createdAt: new Date().toISOString()
      };
      report.steps.push(step);
      appendAgentStep(db, report.id, step);
      if (decision.action === "stop") {
        report.state = decision.reason === "target-satisfied" ? "completed"
          : decision.reason === "awaiting-human-review" ? "awaiting-review" : "stopped";
        report.stopReason = decision.reason;
        break;
      }
      visitedUrls.push(decision.url);
      report.pagesAttempted += 1;
      if (decision.action === "collect") report.detailAttempts += 1;
      try {
        if (decision.action === "discover-seed") {
          const source = sources.find(item => item.id === decision.sourceId) || sourceForUrl(decision.url, sources);
          if (!source) throw new Error(`seed source not found: ${decision.url}`);
          const page = await fetchPage(decision.url, source);
          const discovered = source.search?.kind === "hksg-web"
            ? parseHksgLinkCandidates(page.html, page.finalUrl, source, programme, "detail").map(url => ({ url, kind: "detail", targetMatched: true }))
            : source.search?.kind === "compass-index"
              ? [
                ...parseCompassDetailCandidates(page.html, page.finalUrl, source, programme).map(candidate => ({ url: candidate.url, kind: "detail", targetMatched: true })),
                ...discoverEntryLinks(page.html, page.finalUrl, source).map(url => ({ url, kind: "seed" }))
              ]
            : (source.seedUrls?.length || source.paginationRegexes?.length)
              ? parseSeedCaseCandidates(page.html, page.finalUrl, source, programme).map(candidate => ({
                url: candidate.url,
                kind: candidate.kind,
                targetMatched: candidate.kind === "detail" && candidate.programmeHits?.some(hit => !isGenericProgrammeSearchTerm(hit))
              }))
              : [
                ...discoverLinks(page.html, page.finalUrl, source).map(url => ({ url, kind: "detail" })),
                ...discoverEntryLinks(page.html, page.finalUrl, source).map(url => ({ url, kind: "seed" }))
              ];
          for (const item of discovered) {
            const url = item.url;
            if (!visitedUrls.includes(url) && !sourceCandidates.some(candidate => candidate.url === url)) {
              const kind = item.kind || ((source.detailRegexes || []).some(pattern => new RegExp(pattern).test(new URL(url).pathname)) ? "detail" : "seed");
              const discoveredBy = source.search?.kind === "hksg-web"
                ? "hksg-search"
                : source.search?.kind === "compass-index"
                  ? "compass-search"
                  : "seed-page";
              sourceCandidates.push({ url, sourceId: source.id || null, priority: source.search?.kind === "compass-index" ? 0 : 1, kind, discoveredBy, targetMatched: Boolean(item.targetMatched), casePriority: Number(source.casePriority ?? 1) });
            }
          }
          const resultStep = {
            index: report.steps.length + 1,
            action: "discover-detail-links",
            status: "completed",
            detail: { url: decision.url, discovered: discovered.length, queued: discovered.filter(item => !visitedUrls.includes(item.url)).length },
            createdAt: new Date().toISOString()
          };
          report.steps.push(resultStep);
          appendAgentStep(db, report.id, resultStep);
          continue;
        }
        const selectedCandidate = availableSourceCandidates.find(candidate => candidate.url === decision.url);
        const previousCrawl = selectedCandidate ? crawlSourceForProgramme(db, decision.url, programmeId) : null;
        const result = selectedCandidate?.discoveredBy === "eic-index"
          ? await collectIndexedCase(selectedCandidate.indexedCase, programme, eicSource, false)
          : await collectUrl(decision.url, sources, {
            dryRun: false,
            programmeId,
            recheckEmpty: Number(previousCrawl?.scoped_count || 0) === 0,
            forceRefresh: false,
            trustedProgrammeId: selectedCandidate?.trustedProgrammeId || null,
            allowDirectionOnly: (coverage.approved2021 ?? coverage.approved ?? 0) < goal.targetApproved,
            allowProgrammeInference: true
          });
        const coverageAfter = caseCoverage(db, programmeId);
        const coverageChanged = (coverageAfter.total ?? 0) > (coverage.total ?? 0)
          || (coverageAfter.approved2021 ?? coverageAfter.approved ?? 0) > (coverage.approved2021 ?? coverage.approved ?? 0)
          || (coverageAfter.pending2021 ?? coverageAfter.pending ?? 0) > (coverage.pending2021 ?? coverage.pending ?? 0);
        const selectedSource = selectedCandidate?.sourceId
          ? sources.find(item => item.id === selectedCandidate.sourceId)
          : sourceForUrl(decision.url, sources);
        const sourceKey = selectedCandidate?.sourceId || selectedSource?.id || null;
        if (sourceKey) {
          if (coverageChanged) sourceNoProgress.delete(sourceKey);
          else sourceNoProgress.set(sourceKey, Number(sourceNoProgress.get(sourceKey) || 0) + 1);
        }
        report.apiCalls += result.modelCalled ? 1 : 0;
        const approved2021 = (result.candidates || [])
          .filter(candidate => candidate?.reviewStatus === "approved" && Number(candidate.offerYear) >= 2021)
          .length;
        const ocrTokens = Number(result.usage?.primaryOcr?.total_tokens || 0)
          + Number(result.usage?.criticalOcr?.total_tokens || 0);
        report.ocrCalls += result.ocr?.used && !result.ocr?.cacheHit ? 1 : 0;
        report.ocrTokens += ocrTokens;
        report.extractionTokens += Number(result.usage?.extraction?.total_tokens || 0);
        const resultStep = {
          index: report.steps.length + 1,
          action: "extract-validate-store",
          status: "completed",
          detail: { url: decision.url, extracted: result.extracted, queued: result.queued, duplicates: result.duplicates, approved2021, skipped: result.skipped, ocrUsed: Boolean(result.ocr?.used), ocrTokens, modelCalled: Boolean(result.modelCalled), coverageChanged, sourceNoProgress: sourceKey ? Number(sourceNoProgress.get(sourceKey) || 0) : 0, prefilter: result.prefilter },
          createdAt: new Date().toISOString()
        };
        report.steps.push(resultStep);
        appendAgentStep(db, report.id, resultStep);
        if (selectedCandidate?.discoveredBy === "fallback-prefilter" && Number(result.scoped || 0) === 0) {
          recordCrawlSource(db, {
            sourceUrl: decision.url,
            programmeId,
            extractedCount: Number(result.extracted || 0),
            scopedCount: 0,
            queuedCount: Number(result.queued || 0),
            error: `${fallbackPrefilterVersion}:no-target`
          });
        }
      } catch (error) {
        report.errors += 1;
        const errorStep = {
          index: report.steps.length + 1,
          action: "extract-validate-store",
          status: "failed",
          detail: { url: decision.url, error: error.message },
          createdAt: new Date().toISOString()
        };
        report.steps.push(errorStep);
        appendAgentStep(db, report.id, errorStep);
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    finishAgentRun(db, report.id, report);
    if (activeAgentRun?.report.id === report.id) activeAgentRun = null;
    db.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

async function collectMany(urls, sources, options) {
  const report = [];
  for (const [index, url] of urls.entries()) {
    try {
      report.push({ url, ...(await collectUrl(url, sources, options)) });
    } catch (error) {
      report.push({ url, error: error.message });
    }
    if (index < urls.length - 1) await sleep(delayMs);
  }
  return report;
}

async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  const flags = args.filter(argument => argument.startsWith("--"));
  const target = args.find(argument => !argument.startsWith("--"));
  const dryRun = flags.includes("--dry-run");
  const limitFlag = flags.find(flag => flag.startsWith("--limit="));
  const limit = Math.max(1, Number(limitFlag?.split("=")[1] || 20));
  const sources = await loadSources();
  if (command === "status") return showStatus();
  if (command === "list") return listQueue(limit);
  if (command === "show") {
    if (!target) throw new Error("缺少案例fingerprint");
    return showRecord(target);
  }
  if (["approve", "reject", "pending"].includes(command)) {
    if (!target) throw new Error("缺少案例fingerprint");
    const status = command === "approve" ? "approved" : command === "reject" ? "rejected" : "pending";
    return updateReviewStatus(target, status);
  }
  if (command === "repair-programmes") return repairUnmatchedProgrammes(flags);
  if (command === "scope-cleanup") return cleanOutOfScopeCases();
  if (command === "master") return showMasterData();
  if (command === "runs") return showAgentRuns(limit);
  if (command === "coverage") {
    if (!target) throw new Error("缺少项目id，例如 cuhk-ee");
    return showCoverage(target);
  }
  if (["verify-programmes", "verify-status"].includes(command)) return verifyProgrammeStatusCommand(target, flags);
  if (["programme-status", "programme-statuses"].includes(command)) return showProgrammeStatuses(flags);
  if (["classify-programmes", "programme-scope"].includes(command)) return classifyProgrammeScopeCommand(target, flags);
  if (["programme-scopes", "scope-status"].includes(command)) return showProgrammeScopes(flags);
  if (command === "plan") return showCollectionPlan(target, sources, flags);
  if (command === "run") {
    if (!target) throw new Error("缺少项目id，例如 cuhk-ee");
    return runCollectionAgent(target, sources, flags);
  }
  if (!target) throw new Error(`缺少${command}目标`);
  if (command === "discover") {
    const source = sourceForUrl(target, sources);
    if (!source) throw new Error(`域名未列入sources.json：${target}`);
    const page = await fetchPage(target, source);
    console.log(discoverLinks(page.html, page.finalUrl, source).join("\n"));
    return;
  }
  if (command === "collect") {
    const programmeId = flags.find(flag => flag.startsWith("--programme-id="))?.split("=").slice(1).join("=") || null;
    console.log(JSON.stringify(await collectUrl(target, sources, {
      dryRun,
      programmeId,
      forceRefresh: flags.includes("--force-refresh"),
      refreshOcr: flags.includes("--refresh-ocr"),
      recheckEmpty: flags.includes("--recheck-empty")
    }), null, 2));
    return;
  }
  if (command === "crawl") {
    const urls = (await readFile(resolve(target), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, limit);
    console.log(JSON.stringify(await collectMany(urls, sources, { dryRun }), null, 2));
    return;
  }
  if (command === "harvest") {
    const source = sourceForUrl(target, sources);
    if (!source) throw new Error(`域名未列入sources.json：${target}`);
    const page = await fetchPage(target, source);
    const urls = discoverLinks(page.html, page.finalUrl, source).slice(0, limit);
    console.log(JSON.stringify(await collectMany(urls, sources, { dryRun }), null, 2));
    return;
  }
  throw new Error(`未知命令：${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
