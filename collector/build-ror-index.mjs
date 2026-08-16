import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseCsvLine } from "./csv.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const referenceDir = resolve(root, "data", "reference");
const outputPath = resolve(referenceDir, "institutions.sqlite");

const files = await readdir(referenceDir);
const csvName = files.find(name => /-ror-data\.csv$/.test(name));
if (!csvName) throw new Error("没有找到已解压的ROR CSV，请先运行 npm.cmd run reference:download 并解压ZIP");
const inputPath = resolve(referenceDir, csvName);
const overseasPath = resolve(referenceDir, "world_universities_and_domains.json");
if (existsSync(outputPath)) rmSync(outputPath);
const db = new DatabaseSync(outputPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE organizations (
    ror_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    acronyms TEXT NOT NULL,
    country_code TEXT,
    country_name TEXT,
    website TEXT,
    established INTEGER,
    types TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX idx_organizations_name ON organizations(name);
  CREATE INDEX idx_organizations_country ON organizations(country_code);
  CREATE TABLE overseas_institutions (
    overseas_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT,
    country_code TEXT,
    domains TEXT NOT NULL,
    web_pages TEXT NOT NULL,
    state_province TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX idx_overseas_institutions_name ON overseas_institutions(name);
  CREATE INDEX idx_overseas_institutions_country ON overseas_institutions(country_code);
`);
const insert = db.prepare(`INSERT INTO organizations
  (ror_id, name, aliases, acronyms, country_code, country_name, website, established, types, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const prefixedNames = value => String(value || "").split(";").map(item => item.trim().replace(/^[a-z_]+:\s*/i, "")).filter(Boolean);

let header;
let indexes;
let inserted = 0;
let seen = 0;
db.exec("BEGIN");
try {
  const lines = createInterface({ input: createReadStream(inputPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!header) {
      header = parseCsvLine(line);
      indexes = Object.fromEntries(header.map((name, index) => [name, index]));
      continue;
    }
    seen += 1;
    const row = parseCsvLine(line);
    const types = row[indexes.types] || "";
    const status = row[indexes.status] || "";
    if (status !== "active" || !types.split(";").map(value => value.trim()).includes("education")) continue;
    const displayName = row[indexes["names.types.ror_display"]];
    if (!displayName) continue;
    const aliases = [...new Set([
      ...prefixedNames(row[indexes["names.types.label"]]),
      ...prefixedNames(row[indexes["names.types.alias"]])
    ].filter(name => name !== displayName))];
    const acronyms = prefixedNames(row[indexes["names.types.acronym"]]);
    insert.run(
      row[indexes.id], displayName, aliases.join(" | "), acronyms.join(" | "),
      row[indexes["locations.geonames_details.country_code"]] || null,
      row[indexes["locations.geonames_details.country_name"]] || null,
      row[indexes["links.type.website"]]?.split(";")[0]?.trim() || null,
      Number(row[indexes.established]) || null, types, status
    );
    inserted += 1;
    if (inserted % 5000 === 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
    }
  }
  db.exec("COMMIT");
  db.exec(`CREATE VIRTUAL TABLE organizations_fts USING fts5(ror_id UNINDEXED, name, aliases, acronyms, tokenize='trigram');
    INSERT INTO organizations_fts SELECT ror_id, name, aliases, acronyms FROM organizations;`);
  if (existsSync(overseasPath)) {
    const overseas = JSON.parse(readFileSync(overseasPath, "utf8"));
    const insertOverseas = db.prepare(`INSERT INTO overseas_institutions
      (overseas_id, name, country, country_code, domains, web_pages, state_province, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN");
    for (const [index, item] of (Array.isArray(overseas) ? overseas : []).entries()) {
      if (!item?.name) continue;
      insertOverseas.run(
        `hipo:${index}`,
        String(item.name),
        item.country || null,
        item.alpha_two_code || null,
        JSON.stringify(item.domains || []),
        JSON.stringify(item.web_pages || []),
        item["state-province"] || null,
        "Hipo university-domains-list"
      );
    }
    db.exec("COMMIT");
  }
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  db.close();
  throw error;
}
db.close();
console.log(JSON.stringify({ input: inputPath, output: outputPath, seen, inserted }, null, 2));
