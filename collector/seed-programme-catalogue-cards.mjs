import { readFile } from "node:fs/promises";
import { openCaseStore } from "./store.mjs";

const catalogue = JSON.parse(await readFile("collector/data/programme-catalogue.json", "utf8"));
const db = openCaseStore();
const missing = new Set(db.prepare("SELECT p.id FROM programmes p LEFT JOIN programme_documents d ON d.programme_id=p.id AND d.section='official-page' WHERE d.id IS NULL").all().map(row => row.id));
const statement = db.prepare(`INSERT INTO programme_documents
  (id, programme_id, section, title, text, provenance, academic_years_json, checked_at, sources_json, updated_at)
  VALUES (?, ?, 'catalogue-card', ?, ?, 'official-catalogue', ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title,text=excluded.text,checked_at=excluded.checked_at,sources_json=excluded.sources_json,updated_at=excluded.updated_at`);
let inserted = 0;
for (const item of catalogue.programmes.filter(row => missing.has(row.id))) {
  const now = new Date().toISOString();
  const text = [
    `Programme: ${item.nameEn}`,
    item.nameZh ? `Chinese name: ${item.nameZh}` : null,
    item.faculty ? `Faculty or department: ${item.faculty}` : null,
    item.officialCode ? `Official code: ${item.officialCode}` : null,
    `Official programme URL: ${item.officialUrl}`
  ].filter(Boolean).join("\n");
  statement.run(`${item.id}:catalogue-card`, item.id, `${item.nameEn} official catalogue card`, text,
    JSON.stringify(["2026-27"]), item.checkedAt || now,
    JSON.stringify([{ kind: "official-programme-catalogue", url: item.catalogueUrl }, { kind: "official-programme-page", url: item.officialUrl }]), now);
  inserted += 1;
}
console.log(JSON.stringify({ inserted, remainingWithoutAnyDocument: db.prepare("SELECT COUNT(*) n FROM programmes p LEFT JOIN programme_documents d ON d.programme_id=p.id WHERE d.id IS NULL").get().n }, null, 2));
db.close();
