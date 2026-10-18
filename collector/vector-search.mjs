import { createHash } from "node:crypto";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function compactList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean).join("；");
  return String(value || "").trim();
}

function deriveEmbeddingUrl(value) {
  const url = String(value || "").trim();
  return url.endsWith("/chat/completions")
    ? `${url.slice(0, -"/chat/completions".length)}/embeddings`
    : "";
}

export function resolveEmbeddingSettings(env = process.env) {
  const apiUrl = String(env.EMBEDDING_API_URL || env.COLLECTOR_EMBEDDING_API_URL || deriveEmbeddingUrl(env.COLLECTOR_AI_API_URL)).trim();
  const apiKey = String(env.EMBEDDING_API_KEY || env.COLLECTOR_EMBEDDING_API_KEY || env.COLLECTOR_AI_API_KEY || "").trim();
  const model = String(env.EMBEDDING_MODEL || env.COLLECTOR_EMBEDDING_MODEL || "text-embedding-v4").trim();
  const enabled = String(env.VECTOR_SEARCH_ENABLED || "false").toLowerCase() === "true";
  return {
    enabled,
    apiUrl,
    apiKey,
    model,
    batchSize: Math.min(10, Math.max(1, Number(env.EMBEDDING_BATCH_SIZE || 10))),
    timeoutMs: Math.max(5000, Number(env.EMBEDDING_TIMEOUT_MS || 60000))
  };
}

export function embeddingTextHash(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function buildCaseEmbeddingText(item = {}) {
  return [
    `目标项目：${item.targetProgramme || item.targetProgrammeEnglishRaw || item.targetProgrammeId || "未披露"}`,
    `录取年份：${item.offerYear || "未披露"}`,
    `本科院校：${item.undergraduateUniversity || "未披露"}`,
    `本科专业：${item.undergraduateMajor || "未披露"}`,
    `GPA：${item.gpaRaw || "未披露"}`,
    `语言：${item.languageTest || "未披露"} ${item.languageScore ?? "未披露"}`,
    `实习：${compactList(item.internships) || "未披露"}`,
    `工作：${compactList(item.workExperience) || "未披露"}`,
    `科研：${compactList(item.research) || "未披露"}`,
    `竞赛：${compactList(item.competitions) || "未披露"}`,
    `奖项：${compactList(item.awards) || "未披露"}`,
    `项目：${compactList(item.projects) || "未披露"}`
  ].join("\n");
}

export function buildProfileEmbeddingText(profile = {}, narrative = "", query = {}) {
  const internshipTypes = Array.isArray(profile.internships)
    ? profile.internships.flatMap(item => Array.isArray(item?.companyTypes) ? item.companyTypes : [])
    : [];
  return [
    `申请年份：${profile.applicationYear || "未披露"}`,
    `本科院校：${profile.university || "未披露"}`,
    `本科专业：${profile.major || "未披露"}`,
    `GPA：${profile.gpaValue ?? "未披露"}/${profile.gpaScale || "未披露"}`,
    `语言：${profile.languageTest || "未披露"} ${profile.language ?? "未披露"}`,
    `申请地区：${compactList(query.regions) || "未披露"}`,
    `申请方向：${compactList(query.fields) || "未披露"}`,
    `实习方向：${compactList(profile.internships?.map(item => item?.direction).filter(Boolean)) || "未披露"}`,
    `实习单位类型：${compactList(internshipTypes) || "未披露"}`,
    `课程标签：${compactList(profile.courseTags) || "未披露"}`,
    String(narrative || "").trim()
  ].filter(Boolean).join("\n");
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function hybridEvidenceScore(vectorScore, yearWeight = 0) {
  if (!Number.isFinite(Number(vectorScore))) return null;
  // Keep semantic similarity useful without allowing it to erase recency evidence.
  const semantic = (clamp(Number(vectorScore), -1, 1) + 1) / 2;
  return 0.65 * semantic + 0.35 * clamp(Number(yearWeight) || 0, 0, 1);
}

export async function requestEmbeddings(texts, settings = resolveEmbeddingSettings()) {
  const values = texts.map(text => String(text || ""));
  if (!settings.apiUrl || !settings.apiKey || !settings.model) throw new Error("向量模型配置不完整，需要 EMBEDDING_API_URL、EMBEDDING_API_KEY 和 EMBEDDING_MODEL");
  if (!values.length) return [];
  const response = await fetch(settings.apiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(settings.timeoutMs),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, input: values })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`向量模型调用失败（${response.status}）：${payload.error?.message || payload.message || response.statusText}`);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const ordered = rows
    .map((row, index) => ({ index: Number.isFinite(Number(row.index)) ? Number(row.index) : index, embedding: row.embedding }))
    .sort((a, b) => a.index - b.index);
  if (ordered.length !== values.length || ordered.some(row => !Array.isArray(row.embedding) || !row.embedding.length)) {
    throw new Error("向量模型返回数量或向量格式不正确");
  }
  return ordered.map(row => row.embedding.map(Number));
}

export function caseVectorMap(rows = []) {
  return new Map(rows
    .filter(row => row?.fingerprint && Array.isArray(row.vector))
    .map(row => [row.fingerprint, row]));
}
