import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { programmeMaster, resolveInstitution } from "../master-data.mjs";
import { resolveHksgIndexedProgramme } from "./agent.mjs";

try { process.loadEnvFile(resolve(".env")); } catch {}
const indexPath = resolve("collector/data/hksg-offer-index.json");
const outputPath = resolve("collector/data/programme-alias-map.json");
const target = new Set(["hku", "cuhk", "hkust", "cityu-hk", "polyu-hk", "nus", "ntu"]);

function chatUrl(value) {
  const url = String(value || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`;
}

async function mapSchool(institutionId, names) {
  const candidates = programmeMaster.filter(p => p.institutionId === institutionId)
    .map(p => ({ id: p.id, nameEn: p.nameEn, nameZh: p.nameZh === p.nameEn ? null : p.nameZh }));
  const prompt = `Map each Chinese source programme name to exactly one official programme id, or null when no confident equivalent exists. Distinguish tracks when the official list distinguishes them. Do not guess across different disciplines. Return JSON only: {"mappings":[{"sourceName":"...","programmeId":"... or null","confidence":"high|medium|low"}]}.\n\nSource names:\n${JSON.stringify(names)}\n\nOfficial candidates:\n${JSON.stringify(candidates)}`;
  const body = { model: process.env.COLLECTOR_AI_MODEL, temperature: 0, enable_thinking: false,
    response_format: { type: "json_object" }, messages: [{ role: "system", content: "You are a strict university programme entity-resolution engine." }, { role: "user", content: prompt }] };
  const response = await fetch(chatUrl(process.env.COLLECTOR_AI_API_URL), { method: "POST", headers: { authorization: `Bearer ${process.env.COLLECTOR_AI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${institutionId} mapping failed ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || "{}";
  return { mappings: JSON.parse(content.replace(/^```json\s*/i, "").replace(/\s*```$/, "")).mappings || [], usage: payload.usage || null };
}

const index = JSON.parse(await readFile(indexPath, "utf8"));
let previous = { mappings: [], usage: [] };
try { previous = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
const saved = new Map((previous.mappings || []).map(row => [`${row.institutionId}\t${String(row.sourceName || "").trim()}`, row]));
const unresolved = index.rows.filter(row => {
  const institutionId = resolveInstitution(row.university_name)?.id;
  return target.has(institutionId) && !resolveHksgIndexedProgramme(row);
});
const grouped = Object.groupBy(unresolved, row => resolveInstitution(row.university_name).id);
const usage = [...(previous.usage || [])];
for (const [institutionId, rows] of Object.entries(grouped)) {
  const names = [...new Set(rows.map(row => String(row.major_name || "").trim()).filter(Boolean))]
    .filter(name => !saved.has(`${institutionId}\t${name}`));
  if (!names.length) continue;
  const result = await mapSchool(institutionId, names);
  const allowedNames = new Set(names);
  for (const mapping of result.mappings) {
    const sourceName = String(mapping.sourceName || "").trim();
    const valid = allowedNames.has(sourceName)
      && (mapping.programmeId == null || programmeMaster.some(p => p.id === mapping.programmeId && p.institutionId === institutionId));
    if (sourceName && valid) saved.set(`${institutionId}\t${sourceName}`, { institutionId, ...mapping, sourceName });
  }
  usage.push({ institutionId, ...result.usage });
  await writeFile(outputPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), mappings: [...saved.values()], usage }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ institutionId, requested: names.length, mapped: result.mappings.filter(row => row.programmeId).length, usage: result.usage }));
}
console.log(JSON.stringify({ outputPath, mappings: saved.size, mapped: [...saved.values()].filter(row => row.programmeId).length, usage }, null, 2));
