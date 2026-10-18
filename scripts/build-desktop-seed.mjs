import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openCaseStore } from "../collector/store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = process.env.DESKTOP_SEED_SOURCE || resolve(root, "collector/data/cases.sqlite");
const referencePath = resolve(root, "collector/data/reference/institutions.sqlite");
const outputDirectory = resolve(root, "build/desktop-seed");
const outputPath = join(outputDirectory, "cases-seed.sqlite");
const cloudDataDirectory = join(root, "miniprogram/cloud-data");
const cloudAgentDirectory = join(root, "miniprogram/cloudfunctions/admissionApi");
const legacyDataSources = [
  [join(cloudDataDirectory, "cases.json"), "cases.jsonl"],
  [join(cloudDataDirectory, "programmes.json"), "programmes.jsonl"],
  [join(cloudDataDirectory, "programme_evidence.json"), "programme-evidence.jsonl"]
];
const catalogueSource = join(cloudAgentDirectory, "catalog.json");
const textRedaction = value => String(value || "")
  .replace(/https?:\/\/\S+/gi, "[链接已移除]")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已移除]")
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已移除]")
  .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[证件号已移除]")
  .replace(/(?:微信|wechat|vx|联系方式)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/gi, "[联系方式已移除]")
  .trim();
const sanitizeJson = value => {
  if (typeof value === "string") return textRedaction(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJson(item)]));
  return value;
};

if (!existsSync(sourcePath) || !existsSync(referencePath)) throw new Error("缺少本地案例库或院校参考库，无法生成桌面版资料。");
if (legacyDataSources.some(([source]) => !existsSync(source)) || !existsSync(catalogueSource)) {
  throw new Error("缺少云函数旧版 Agent 使用的脱敏案例、项目或官方资料快照，拒绝改用另一套分析数据打包。");
}
mkdirSync(outputDirectory, { recursive: true });
rmSync(outputPath, { force: true });

const legacyCounts = {};
for (const [source, destination] of legacyDataSources) {
  const rows = readFileSync(source, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (destination === "cases.jsonl" && rows.some(row => row.reviewStatus !== "approved")) {
    throw new Error("旧版 Agent 数据快照中存在未审核通过的案例，拒绝打包。");
  }
  if (destination === "cases.jsonl" && rows.some(row =>
    ["openid", "sourceUrl", "sourceUrls", "raw_json", "email", "phone", "mobile"].some(key => key in row))) {
    throw new Error("旧版 Agent 案例快照中发现不应分发的身份或来源字段，拒绝打包。");
  }
  copyFileSync(source, join(outputDirectory, destination));
  legacyCounts[destination] = rows.length;
}
const catalogue = JSON.parse(readFileSync(catalogueSource, "utf8"));
copyFileSync(catalogueSource, join(outputDirectory, "catalog.json"));
legacyCounts.catalogueProgrammes = Array.isArray(catalogue.programmes) ? catalogue.programmes.length : 0;

const db = openCaseStore(outputPath);
db.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
const sourceCases = db.prepare(`SELECT * FROM source.cases
  WHERE review_status='approved' AND offer_year>=2021 AND target_programme_id IS NOT NULL
  ORDER BY offer_year DESC, fingerprint`).all();
const columns = [
  "fingerprint", "target_institution_id", "target_programme_id", "undergraduate_institution_id",
  "target_university", "target_programme", "target_programme_en_raw", "offer_year",
  "undergraduate_university", "undergraduate_major", "gpa_raw", "gpa_scale", "gpa100",
  "language_test", "language_scale", "language_score", "internships_json", "work_experience_json",
  "research_json", "competitions_json", "awards_json", "patents_json", "projects_json",
  "experiences_json", "auxiliary_scores_json", "evidence_json", "source_published_at", "source_url",
  "collected_at", "quality_score", "review_status", "issues_json", "raw_json"
];
const insertCase = db.prepare(`INSERT INTO main.cases (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
db.exec("BEGIN IMMEDIATE");
try {
  for (const row of sourceCases) {
    const value = name => row[name] == null ? null : row[name];
    const json = name => JSON.stringify(sanitizeJson(JSON.parse(row[name] || "[]")));
    insertCase.run(
      row.fingerprint, value("target_institution_id"), row.target_programme_id, value("undergraduate_institution_id"),
      textRedaction(row.target_university), textRedaction(row.target_programme), textRedaction(row.target_programme_en_raw),
      row.offer_year, textRedaction(row.undergraduate_university), textRedaction(row.undergraduate_major),
      textRedaction(row.gpa_raw), row.gpa_scale, row.gpa100, value("language_test"), value("language_scale"),
      row.language_score, json("internships_json"), json("work_experience_json"), json("research_json"),
      json("competitions_json"), json("awards_json"), json("patents_json"), json("projects_json"),
      json("experiences_json"), json("auxiliary_scores_json"), "{}", value("source_published_at"),
      `desktop://approved-case/${row.fingerprint}`, row.collected_at, row.quality_score, "approved", "[]", "{}"
    );
  }
  db.exec("DELETE FROM main.programme_documents");
  db.exec(`INSERT OR REPLACE INTO main.programme_documents
    (id, programme_id, section, title, text, provenance, academic_years_json, checked_at, sources_json, updated_at)
    SELECT d.id, d.programme_id, d.section, d.title, d.text, d.provenance,
      d.academic_years_json, d.checked_at, '[]', d.updated_at
    FROM source.programme_documents d
    JOIN main.programmes p ON p.id=d.programme_id
    WHERE d.provenance IN ('official','official-structured','official-catalogue')
      AND d.text IS NOT NULL AND length(trim(d.text))>0`);
  db.exec(`DELETE FROM main.case_sources;
    DELETE FROM main.analysis_feedback;
    DELETE FROM main.analysis_records;
    DELETE FROM main.agent_steps;
    DELETE FROM main.agent_runs;
    DELETE FROM main.case_embeddings;
    DELETE FROM main.crawl_extraction_cache;
    DELETE FROM main.crawl_ocr_cache;
    DELETE FROM main.crawl_source_scopes;
    DELETE FROM main.crawl_sources;`);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  db.close();
  throw error;
}
db.prepare("DETACH DATABASE source").run();
db.exec("VACUUM");
const caseCount = db.prepare("SELECT count(*) AS count FROM cases").get().count;
const programmeCount = db.prepare("SELECT count(DISTINCT programme_id) AS count FROM programme_documents").get().count;
const evidenceCount = db.prepare("SELECT count(*) AS count FROM programme_documents").get().count;
db.close();
copyFileSync(referencePath, join(outputDirectory, "institutions.sqlite"));

console.log(JSON.stringify({
  outputPath,
  cases: caseCount,
  programmesWithOfficialEvidence: programmeCount,
  officialDocuments: evidenceCount,
  legacyAgentSnapshot: legacyCounts
}, null, 2));
