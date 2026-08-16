import { createReadStream, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseCsvLine } from "./csv.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const referenceDir = resolve(root, "data", "reference");
const inputPath = resolve(referenceDir, "moe-china-universities-2026.csv");
const outputPath = resolve(referenceDir, "institutions.sqlite");

if (!existsSync(inputPath)) throw new Error("缺少教育部 CSV，请先运行 npm.cmd run reference:moe:export");
if (!existsSync(outputPath)) throw new Error("缺少 ROR 索引，请先运行 npm.cmd run reference:index");

const db = new DatabaseSync(outputPath);
db.exec(`
  DROP TABLE IF EXISTS moe_institutions_fts;
  DROP TABLE IF EXISTS moe_institutions;
  CREATE TABLE moe_institutions (
    institution_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    authority TEXT,
    city TEXT,
    education_level TEXT,
    note TEXT,
    source_name TEXT NOT NULL,
    source_date TEXT NOT NULL
  );
  CREATE INDEX idx_moe_institutions_name ON moe_institutions(name);
`);

const insert = db.prepare(`INSERT INTO moe_institutions
  (institution_code, name, authority, city, education_level, note, source_name, source_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
let inserted = 0;
db.exec("BEGIN");
try {
  const lines = createInterface({ input: createReadStream(inputPath, { encoding: "utf8" }), crlfDelay: Infinity });
  let rowNumber = 0;
  for await (const line of lines) {
    rowNumber += 1;
    if (rowNumber <= 3 || !line.trim()) continue;
    const row = parseCsvLine(line.replace(/^\uFEFF/, ""));
    const sequence = String(row[0] || "").trim();
    const name = String(row[1] || "").trim();
    const code = String(row[2] || "").trim();
    if (!/^\d+$/.test(sequence) || !name || !/^\d{10}$/.test(code)) continue;
    insert.run(
      code,
      name,
      String(row[3] || "").trim() || null,
      String(row[4] || "").trim() || null,
      String(row[5] || "").trim() || null,
      String(row[6] || "").trim() || null,
      "教育部全国普通高等学校名单",
      "2026-06-17"
    );
    inserted += 1;
  }
  db.exec("COMMIT");
  db.exec(`CREATE VIRTUAL TABLE moe_institutions_fts USING fts5(
    institution_code UNINDEXED, name, tokenize='trigram'
  );
  INSERT INTO moe_institutions_fts SELECT institution_code, name FROM moe_institutions;`);
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  db.close();
  throw error;
}
db.close();
console.log(JSON.stringify({ input: inputPath, output: outputPath, inserted }, null, 2));
