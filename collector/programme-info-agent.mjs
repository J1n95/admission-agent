import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openCaseStore } from "./store.mjs";

try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }

const concurrency = Math.max(1, Number(process.argv.find(arg => arg.startsWith("--concurrency="))?.split("=")[1] || 3));
const limit = Math.max(0, Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] || 0));
const refresh = process.argv.includes("--refresh");
const proxy = process.argv.includes("--proxy");
const cachedOnly = process.argv.includes("--cached-only");
const uncachedOnly = process.argv.includes("--uncached-only");
const retryFailed = process.argv.includes("--retry-failed");
const allowDerivedFallback = process.argv.includes("--allow-derived-fallback");
const programmeIds = new Set(String(process.argv.find(arg => arg.startsWith("--programme-ids="))?.split("=").slice(1).join("=") || "")
  .split(",").map(value => value.trim()).filter(Boolean));
const userAgent = "Mozilla/5.0 AdmissionProgrammeInfoAgent/0.1";
const execFileAsync = promisify(execFile);
const targetInstitutions = new Set(["hku", "cuhk", "hkust", "polyu-hk", "cityu-hk", "hkbu", "lingnan-hk", "eduhk", "nus", "ntu"]);
const fields = [
  ["requirements", "项目要求"],
  ["positioning", "项目定位"],
  ["duration", "学制与学分"],
  ["curriculum", "课程结构"],
  ["orientation", "课程取向"],
  ["resources", "项目与院校资源"],
  ["career", "就业与发展"],
  ["comparison", "相近项目区别"]
];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decode(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function htmlToText(source) {
  const title = clean(decode(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]));
  const description = clean(decode(
    source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]
      || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1]
  ));
  const body = clean(decode(source
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")));
  return { title: title || "Official programme page", text: [description, body].filter(Boolean).join("\n\n").slice(0, 30000) };
}

function markdownToText(source) {
  const marker = source.indexOf("Markdown Content:");
  return {
    title: clean(source.match(/^Title:\s*(.+)$/m)?.[1]) || "Official programme page",
    text: clean(marker >= 0 ? source.slice(marker + "Markdown Content:".length) : source).slice(0, 30000)
  };
}

async function fetchOfficialPage(url) {
  let lastError;
  const candidates = proxy ? [`https://r.jina.ai/${url}`] : [url];
  for (const candidate of candidates) {
    try {
      const timeoutMs = candidate.startsWith("https://r.jina.ai/")
        ? Number(process.env.COLLECTOR_INFO_PROXY_TIMEOUT_MS || 12000)
        : Number(process.env.COLLECTOR_INFO_DIRECT_TIMEOUT_MS || 10000);
      const response = await fetch(candidate, { redirect: "follow", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      const page = candidate.startsWith("https://r.jina.ai/") ? markdownToText(source) : htmlToText(source);
      if (page.text.length < 180) throw new Error("official page text is too short");
      return { ...page, fetchedUrl: candidate };
    } catch (error) { lastError = error; }
  }
  for (const candidate of (proxy ? [`https://r.jina.ai/${url}`] : [url])) {
    try {
      const { stdout } = await execFileAsync("curl.exe", ["-L", "--silent", "--show-error", "--max-time", "25", "-A", userAgent, candidate], {
        maxBuffer: 5_000_000,
        encoding: "utf8"
      });
      const page = candidate.startsWith("https://r.jina.ai/") ? markdownToText(stdout) : htmlToText(stdout);
      if (page.text.length >= 180) return { ...page, fetchedUrl: candidate };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("official page fetch failed");
}

function chatUrl(value) {
  const url = clean(value);
  if (!url) return "";
  return /\/chat\/completions\/?$/i.test(url) ? url : `${url.replace(/\/$/, "")}/chat/completions`;
}

function modelSettings() {
  const apiUrl = chatUrl(process.env.COLLECTOR_INFO_AI_API_URL || process.env.COLLECTOR_AI_API_URL || process.env.AI_API_URL);
  const apiKey = clean(process.env.COLLECTOR_INFO_AI_API_KEY || process.env.COLLECTOR_AI_API_KEY || process.env.AI_API_KEY);
  const model = clean(process.env.COLLECTOR_INFO_AI_MODEL || process.env.COLLECTOR_AI_MODEL || process.env.AI_MODEL);
  return apiUrl && apiKey && model ? { apiUrl, apiKey, model } : null;
}

function parseJson(content) {
  const text = Array.isArray(content) ? content.map(item => item?.text || "").join("\n") : String(content || "");
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeField(value) {
  const text = Array.isArray(value)
    ? clean(value.join("；"))
    : value && typeof value === "object"
      ? clean(Object.values(value).join("；"))
      : clean(value);
  return /^(null|none|n\/a|未披露|暂无资料|未明确说明|未提及|未提供|未提供.*|暂无.*|页面未说明|页面没有.*)$/i.test(text) ? "" : text;
}

async function structurePage(settings, programme, rawText) {
  const prompt = `你是研究生项目资料整理助手。请基于下面的学校官方项目页面整理项目卡片，不得编造学校没有支持的具体事实，也不要输出录取概率。requirements、positioning、duration、curriculum、orientation 只能整理页面明确写出的内容。resources、career、comparison 如果页面没有直接段落，可以在不添加实验室名称、雇主名称、就业承诺或官方录取结论的前提下，依据项目名称、院系、课程和官方定位做谨慎的结构化推断；这类内容必须以“基于官方项目定位推断：”开头。完全无法支持时返回 null。每个字段用简洁但有信息量的中文，避免只返回“未提供资料”。只返回 JSON 对象，键必须是 requirements, positioning, duration, curriculum, orientation, resources, career, comparison。\n\n项目：${programme.name_en}\n官方页面：${programme.official_url}\n\n官方页面文本：\n${rawText.slice(0, 24000)}`;
  const response = await fetch(settings.apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(Number(process.env.COLLECTOR_INFO_AI_TIMEOUT_MS || 120000)),
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      enable_thinking: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You extract verifiable facts from official university programme pages. For resources, career, and comparison, cautious inferences are allowed only when clearly labeled in Chinese as requested; never invent named labs, employers, rankings, admission cutoffs, or guarantees." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`AI HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  return { data: parseJson(payload.choices?.[0]?.message?.content), usage: payload.usage || null };
}

async function structureBlockedPage(settings, programme) {
  const prefix = "官网暂不可读取，基于项目名称与学科定位推断：";
  const prompt = `你是研究生项目资料整理助手。当前学校官网触发访问限制，无法读取正文。请仅根据学校、项目名称和项目网址，生成一张谨慎的项目概览卡，用来帮助用户理解项目的大致方向，不得把推断写成官方事实，不得编造分数线、语言要求、学分、学制时长、课程名称、实验室、雇主或就业承诺。

每个字段都必须以“${prefix}”开头。requirements 只概括通常需要的本科背景、先修能力或经验类型，并明确精确门槛以官网为准；positioning 概括培养定位；duration 明确精确学制与学分以官网为准，同时说明更可能属于授课型、研究型或职业型；curriculum 概括可能覆盖的知识模块，不写具体课程名；orientation 概括方法、行业或研究取向；resources 只写可利用的院系、跨学科和职业服务资源类别；career 只写可能对应的岗位方向；comparison 说明与相邻学科项目的典型区别。每项一到三句中文。只返回 JSON 对象，键必须是 requirements, positioning, duration, curriculum, orientation, resources, career, comparison。

学校：${programme.institution_id}
项目：${programme.name_en}
官网：${programme.official_url}`;
  const response = await fetch(settings.apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(Number(process.env.COLLECTOR_INFO_AI_TIMEOUT_MS || 120000)),
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      enable_thinking: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You create clearly labelled, cautious programme overviews when an official page is temporarily inaccessible. Never invent exact official requirements, scores, durations, credits, course names, facilities, employers, rankings, or outcomes." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`AI HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  return { data: parseJson(payload.choices?.[0]?.message?.content), usage: payload.usage || null };
}

function upsertDocument(db, row) {
  db.prepare(`INSERT INTO programme_documents
    (id, programme_id, section, title, text, provenance, academic_years_json, checked_at, sources_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, text=excluded.text, provenance=excluded.provenance,
      academic_years_json=excluded.academic_years_json, checked_at=excluded.checked_at,
      sources_json=excluded.sources_json, updated_at=excluded.updated_at`).run(
    row.id, row.programmeId, row.section, row.title, row.text, row.provenance,
    JSON.stringify(["2026-27"]), row.checkedAt, JSON.stringify(row.sources), row.checkedAt
  );
}

async function processProgramme(db, row, settings, report) {
  const now = new Date().toISOString();
  let raw = db.prepare("SELECT * FROM programme_documents WHERE programme_id=? AND section='official-page' LIMIT 1").get(row.id);
  if (refresh || !raw) {
    try {
      const page = await fetchOfficialPage(row.official_url);
      raw = { programme_id: row.id, title: page.title || row.name_en, text: page.text, sources_json: JSON.stringify([{ kind: "official-programme-page", url: row.official_url, fetchedUrl: page.fetchedUrl }]) };
      upsertDocument(db, {
        id: `${row.id}:official-page`, programmeId: row.id, section: "official-page", title: raw.title,
        text: raw.text, provenance: "official", checkedAt: now, sources: JSON.parse(raw.sources_json)
      });
      report.pagesFetched += 1;
    } catch (error) {
      if (!allowDerivedFallback || !settings) throw error;
      const structured = await structureBlockedPage(settings, row);
      let stored = 0;
      for (const [section, title] of fields) {
        const text = normalizeField(structured.data?.[section]);
        if (!text) continue;
        upsertDocument(db, {
          id: `${row.id}:${section}`, programmeId: row.id, section, title, text,
          provenance: "derived-ai-blocked-source", checkedAt: now,
          sources: [{ kind: "official-programme-page-blocked", url: row.official_url }]
        });
        stored += 1;
      }
      report.aiCalls += 1;
      report.structuredFields += stored;
      return { programmeId: row.id, status: stored ? "derived-fallback" : "no-fields", fields: stored, usage: structured.usage };
    }
  }
  const existing = new Set(db.prepare("SELECT section FROM programme_documents WHERE programme_id=?").all(row.id).map(item => item.section));
  if (!settings) {
    report.aiSkipped += 1;
    return { programmeId: row.id, status: "raw-only", reason: "info-agent-api-not-configured" };
  }
  if (!refresh && fields.every(([section]) => existing.has(section))) {
    report.cached += 1;
    return { programmeId: row.id, status: "cached" };
  }
  const structured = await structurePage(settings, row, raw.text);
  if (refresh) {
    db.prepare(`DELETE FROM programme_documents WHERE programme_id=? AND section IN (${fields.map(() => "?").join(",")})`)
      .run(row.id, ...fields.map(([section]) => section));
  }
  let stored = 0;
  for (const [section, title] of fields) {
    const text = normalizeField(structured.data?.[section]);
    if (!text) continue;
    upsertDocument(db, {
      id: `${row.id}:${section}`, programmeId: row.id, section, title, text,
      provenance: /^基于官方项目定位推断：/.test(text) ? "derived-ai" : "official-structured", checkedAt: now,
      sources: [{ kind: "official-programme-page", url: row.official_url }]
    });
    stored += 1;
  }
  report.aiCalls += 1;
  report.structuredFields += stored;
  return { programmeId: row.id, status: stored ? "structured" : "no-fields", fields: stored, usage: structured.usage };
}

export async function runProgrammeInfoAgent({ db = openCaseStore() } = {}) {
  const settings = modelSettings();
  db.exec(`CREATE TABLE IF NOT EXISTS programme_info_failures (
    programme_id TEXT PRIMARY KEY,
    official_url TEXT NOT NULL,
    reason TEXT NOT NULL,
    checked_at TEXT NOT NULL
  )`);
  let rows = db.prepare(`SELECT id, institution_id, name_en, official_url FROM programmes WHERE active=1 ORDER BY institution_id, name_en`).all()
    .filter(row => programmeIds.size ? programmeIds.has(row.id) : targetInstitutions.has(row.institution_id));
  if (cachedOnly || uncachedOnly) {
    const cached = new Set(db.prepare("SELECT programme_id FROM programme_documents WHERE section='official-page'").all().map(item => item.programme_id));
    rows = rows.filter(row => cachedOnly ? cached.has(row.id) : !cached.has(row.id));
  }
  if (uncachedOnly && !retryFailed) {
    const failed = new Set(db.prepare("SELECT programme_id FROM programme_info_failures WHERE official_url IN (SELECT official_url FROM programmes)").all().map(item => item.programme_id));
    rows = rows.filter(row => !failed.has(row.id));
  }
  if (limit) rows = rows.slice(0, limit);
  const report = { attempted: rows.length, succeeded: 0, failed: 0, pagesFetched: 0, aiCalls: 0, aiSkipped: 0, structuredFields: 0, cached: 0, failures: [] };
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const result = await processProgramme(db, row, settings, report);
        db.prepare("DELETE FROM programme_info_failures WHERE programme_id=?").run(row.id);
        report.succeeded += 1;
        console.log(JSON.stringify({ progress: report.succeeded + report.failed, ...result }));
      } catch (error) {
        report.failed += 1;
        const reason = error?.message || String(error);
        db.prepare(`INSERT INTO programme_info_failures (programme_id, official_url, reason, checked_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(programme_id) DO UPDATE SET official_url=excluded.official_url,
          reason=excluded.reason, checked_at=excluded.checked_at`).run(row.id, row.official_url, reason, new Date().toISOString());
        report.failures.push({ programmeId: row.id, url: row.official_url, error: reason });
        console.error(JSON.stringify({ programmeId: row.id, status: "failed", error: error?.message || String(error) }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return report;
}

async function main() {
  const db = openCaseStore();
  try { console.log(JSON.stringify(await runProgrammeInfoAgent({ db }), null, 2)); }
  finally { db.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
