import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { programmeMaster, resolveProgramme } from "../master-data.mjs";
import { openCaseStore } from "./store.mjs";

const endpoint = "https://m.hksg.org/offer/list_data";
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function discoveryTerms(programme) {
  const chinese = [programme.nameZh, ...(programme.aliases || [])]
    .filter(value => /[\u3400-\u9fff]/u.test(value))
    .map(value => value.replace(/(?:理学|工学)?硕士|专业|研究生/gu, "").trim())
    .filter(value => value.length >= 4);
  return [...new Set(chinese)].sort((a, b) => a.length - b.length).slice(0, 4);
}

export async function searchHksg(keyword, fetchImpl = fetch) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({ keywords: keyword, country_id: "", major_sort: "", school: "", gpa: "", page: "1", limit: "100" })) {
    url.searchParams.set(key, value);
  }
  const response = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://m.hksg.org/offer", "x-requested-with": "XMLHttpRequest" } });
  if (!response.ok) throw new Error(`HKSg discovery failed ${response.status}`);
  return (await response.json()).data || [];
}

export async function discoverForProgramme(programme, fetchImpl = fetch) {
  const rows = [];
  for (const term of discoveryTerms(programme)) {
    rows.push(...await searchHksg(term, fetchImpl));
    await sleep(200);
  }
  return [...new Map(rows.map(row => [String(row.id), row])).values()]
    .filter(row => resolveProgramme({ universityName: row.university_name, programmeName: row.major_name })?.id === programme.id)
    .map(row => ({ url: `https://m.hksg.org/offer_${row.id}`, programmeId: programme.id, title: row.title }));
}

async function main() {
  const target = Number(process.argv.find(arg => arg.startsWith("--target="))?.split("=")[1] || 8);
  const output = resolve(process.argv.find(arg => arg.startsWith("--output="))?.split("=")[1] || `collector/batches/hksg-auto-${new Date().toISOString().slice(0, 10)}.tsv`);
  const db = openCaseStore();
  const projects = programmeMaster.filter(programme => ["香港", "新加坡"].includes(programme.region) && programme.active !== false)
    .map(programme => ({ programme, approved: db.prepare("SELECT COUNT(*) count FROM cases WHERE target_programme_id=? AND review_status='approved'").get(programme.id).count }))
    .filter(row => row.approved < target)
    .sort((a, b) => a.approved - b.approved);
  const discovered = [];
  for (const row of projects) {
    const candidates = await discoverForProgramme(row.programme);
    const fresh = candidates.filter(candidate => !db.prepare("SELECT 1 FROM crawl_sources WHERE source_url=?").get(candidate.url));
    discovered.push(...fresh.slice(0, Math.max(0, target - row.approved)));
    console.log(`${row.programme.id}: approved=${row.approved}, found=${candidates.length}, fresh=${fresh.length}`);
  }
  db.close();
  await writeFile(output, [...new Map(discovered.map(row => [row.url, row])).values()].map(row => `${row.url}\t${row.programmeId}`).join("\n") + "\n", "utf8");
  console.log(JSON.stringify({ output, jobs: discovered.length }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
