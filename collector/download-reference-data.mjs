import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const collectorRoot = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(collectorRoot, "data", "reference");
const rorConceptRecord = "https://zenodo.org/api/records/6347574";
const moeUniversityList = "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/W020260618416094865984.xls";
const overseasUniversityList = "https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json";
const headers = { "User-Agent": "AdmissionCaseResearch/0.1 (reference data downloader)" };

async function fetchJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function download(url, destination) {
  const temporary = `${destination}.part`;
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) throw new Error(`${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rm(destination, { force: true });
  await rename(temporary, destination);
}

async function md5(path) {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(outputDir, { recursive: true });

const manifest = {
  downloadedAt: new Date().toISOString(),
  sources: [],
  errors: []
};

try {
  const ror = await fetchJson(rorConceptRecord);
  const rorFile = ror.files?.find(file => file.key.endsWith("-ror-data.zip"));
  if (!rorFile) throw new Error("ROR release has no data ZIP");
  const rorPath = resolve(outputDir, rorFile.key);
  await download(rorFile.links.self, rorPath);
  const expectedMd5 = String(rorFile.checksum).replace(/^md5:/, "");
  const actualMd5 = await md5(rorPath);
  if (actualMd5 !== expectedMd5) throw new Error(`ROR checksum mismatch: ${actualMd5}`);
  manifest.sources.push({
    id: "ror",
    purpose: "global organization identity and aliases; not a ranking",
    releaseId: ror.id,
    doi: ror.doi,
    publicationDate: ror.metadata?.publication_date,
    license: "CC0-1.0",
    sourceUrl: rorConceptRecord,
    file: rorFile.key,
    checksum: rorFile.checksum
  });
} catch (error) {
  manifest.errors.push({ id: "ror", message: error.message });
}

try {
  const moeFile = "moe-china-universities-2026.xls";
  await download(moeUniversityList, resolve(outputDir, moeFile));
  manifest.sources.push({
    id: "moe-cn-2026",
    purpose: "official mainland China higher education institution list",
    publicationDate: "2026-06-18",
    sourceUrl: moeUniversityList,
    file: moeFile
  });
} catch (error) {
  manifest.errors.push({ id: "moe-cn-2026", message: error.message });
}

try {
  const overseasFile = "world_universities_and_domains.json";
  await download(overseasUniversityList, resolve(outputDir, overseasFile));
  manifest.sources.push({
    id: "hipo-world-universities",
    purpose: "overseas institution name and domain identity; not a ranking or admissions-quality source",
    sourceUrl: "https://github.com/Hipo/university-domains-list",
    file: overseasFile
  });
} catch (error) {
  manifest.errors.push({ id: "hipo-world-universities", message: error.message });
}

await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputDir, manifest }, null, 2));
if (manifest.errors.length) process.exitCode = 1;
