import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { openCaseStore } from "./store.mjs";

const concurrency = Math.max(1, Number(process.argv.find(arg => arg.startsWith("--concurrency="))?.split("=")[1] || 8));
const limit = Math.max(0, Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] || 0));
const refresh = process.argv.includes("--refresh");
const useProxy = process.argv.includes("--proxy");
const proxyOnly = process.argv.includes("--proxy-only");
const headers = { "user-agent": "Mozilla/5.0 AdmissionProgrammeResearchBot/0.1" };
const targetInstitutions = ["hku", "cuhk", "hkust", "cityu-hk", "polyu-hk", "nus", "ntu"];
const execFileAsync = promisify(execFile);

const decode = value => String(value || "")
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

function textFromHtml(source) {
  const title = decode(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s+/g, " ").trim();
  const description = decode(source.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1]).replace(/\s+/g, " ").trim();
  const body = decode(source
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ").replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return { title, text: [description, body].filter(Boolean).join("\n\n").slice(0, 30000) };
}

async function fetchText(url) {
  let lastError;
  for (const candidate of proxyOnly ? [`https://r.jina.ai/${url}`] : useProxy ? [url, `https://r.jina.ai/${url}`] : [url]) {
    try {
      const response = await fetch(candidate, { headers, signal: AbortSignal.timeout(proxyOnly ? 15000 : 25000), redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      const parsed = candidate.startsWith("https://r.jina.ai/")
        ? { title: source.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "Official programme page", text: source.slice(source.indexOf("Markdown Content:") + 17).trim().slice(0, 30000) }
        : textFromHtml(source);
      if (parsed.text.length < 180 || /noindex,nofollow[\s\S]{0,300}_Incapsula_Resource/i.test(source)) throw new Error("empty or blocked page");
      return { ...parsed, fetchedUrl: candidate };
    } catch (error) { lastError = error; }
  }
  if (useProxy || proxyOnly) try {
    const { stdout: source } = await execFileAsync("curl.exe", ["-L", "--silent", "--show-error", "--max-time", "20", "-A", headers["user-agent"], `https://r.jina.ai/${url}`], { maxBuffer: 5_000_000, encoding: "utf8" });
    const parsed = { title: source.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "Official programme page", text: source.slice(source.indexOf("Markdown Content:") + 17).trim().slice(0, 30000) };
    if (parsed.text.length >= 180) return { ...parsed, fetchedUrl: `https://r.jina.ai/${url}` };
  } catch (error) { lastError = error; }
  throw lastError;
}

export async function fetchProgrammeDescriptions({ db = openCaseStore() } = {}) {
  const existing = new Set(refresh ? [] : db.prepare("SELECT programme_id FROM programme_documents WHERE section='official-page'").all().map(row => row.programme_id));
  let rows = db.prepare(`SELECT id, institution_id, name_en, official_url FROM programmes
    WHERE active=1 AND institution_id IN (${targetInstitutions.map(() => "?").join(",")})
    ORDER BY institution_id, name_en`).all(...targetInstitutions)
    .filter(row => !existing.has(row.id));
  const groups = Object.values(Object.groupBy(rows, row => row.institution_id));
  rows = Array.from({ length: Math.max(0, ...groups.map(group => group.length)) }, (_, index) => groups.map(group => group[index]).filter(Boolean)).flat();
  if (limit) rows = rows.slice(0, limit);
  const statement = db.prepare(`INSERT INTO programme_documents
    (id, programme_id, section, title, text, provenance, academic_years_json, checked_at, sources_json, updated_at)
    VALUES (?, ?, 'official-page', ?, ?, 'official', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, text=excluded.text, checked_at=excluded.checked_at,
      sources_json=excluded.sources_json, updated_at=excluded.updated_at`);
  const report = { attempted: rows.length, succeeded: 0, failed: 0, failures: [] };
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const page = await fetchText(row.official_url);
        const now = new Date().toISOString();
        statement.run(`${row.id}:official-page`, row.id, page.title || row.name_en, page.text,
          JSON.stringify(["2026-27"]), now, JSON.stringify([{ kind: "official-programme-page", url: row.official_url, fetchedUrl: page.fetchedUrl }]), now);
        report.succeeded += 1;
      } catch (error) {
        report.failed += 1;
        report.failures.push({ programmeId: row.id, url: row.official_url, error: error?.message || String(error) });
      }
      if ((report.succeeded + report.failed) % 25 === 0) console.log(JSON.stringify({ progress: report.succeeded + report.failed, ...report, failures: undefined }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  return report;
}

async function main() {
  const db = openCaseStore();
  try { console.log(JSON.stringify(await fetchProgrammeDescriptions({ db }), null, 2)); }
  finally { db.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
