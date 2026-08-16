import { programmeMaster } from "../master-data.mjs";
import { openCaseStore } from "./store.mjs";

const db = openCaseStore();
const activeIds = new Set(programmeMaster.map(row => row.id));
const normalize = value => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/master of science|m\.?sc\.?/g, "").replace(/master of arts|\bma\b/g, "")
  .replace(/master of engineering|\bmeng\b/g, "").replace(/\band\b|&/g, "and")
  .replace(/\bin\b/g, "").replace(/programme|program/g, "").replace(/[^a-z0-9]+/g, "");
const mappings = db.prepare("SELECT id,institution_id,name_en FROM programmes").all().filter(row => !activeIds.has(row.id)).flatMap(row => {
  const canonical = programmeMaster.find(item => item.institutionId === row.institution_id && normalize(item.nameEn) === normalize(row.name_en));
  return canonical ? [{ from: row.id, to: canonical.id, name: row.name_en }] : [];
});
db.exec("BEGIN");
try {
  for (const mapping of mappings) {
    db.prepare("UPDATE cases SET target_programme_id=? WHERE target_programme_id=?").run(mapping.to, mapping.from);
    db.prepare("UPDATE crawl_sources SET programme_id=? WHERE programme_id=?").run(mapping.to, mapping.from);
    for (const doc of db.prepare("SELECT * FROM programme_documents WHERE programme_id=?").all(mapping.from)) {
      const nextId = `${mapping.to}:${doc.section}`;
      if (!db.prepare("SELECT 1 FROM programme_documents WHERE id=?").get(nextId)) db.prepare("UPDATE programme_documents SET id=?,programme_id=? WHERE id=?").run(nextId, mapping.to, doc.id);
      else db.prepare("DELETE FROM programme_documents WHERE id=?").run(doc.id);
    }
    db.prepare("DELETE FROM programmes WHERE id=?").run(mapping.from);
  }
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
console.log(JSON.stringify({ merged: mappings.length, mappings, remainingProgrammes: db.prepare("SELECT COUNT(*) n FROM programmes").get().n }, null, 2));
db.close();
