import { openCaseStore } from "./store.mjs";

const mappings = [
  ["cityu-hk-msc-electrical-and-electronic-engineering", "cityu-eie"],
  ["hku-master-of-science-in-engineering-civil-engineering-environmental-engineering-stream", "hku-civil-engineering"],
  ["hku-master-of-science-in-engineering-civil-engineering-general-stream", "hku-civil-engineering"],
  ["hku-master-of-science-in-engineering-civil-engineering-geotechnical-engineering-stream", "hku-civil-engineering"],
  ["hku-master-of-science-in-engineering-civil-engineering-structural-engineering-stream", "hku-civil-engineering"],
  ["hku-master-of-science-in-engineering-electrical-and-electronic-engineering-communications-engi", "hku-eee"],
  ["hku-master-of-science-in-engineering-electrical-and-electronic-engineering-general-stream", "hku-eee"],
  ["hku-master-of-science-in-engineering-electrical-and-electronic-engineering-power-engineering-s", "hku-eee"],
  ["hku-master-of-science-in-engineering-infrastructure-engineering-and-management-digital-infrast", "hku-infrastructure-engineering-management"],
  ["hku-master-of-science-in-engineering-infrastructure-engineering-and-management-infrastructure-", "hku-infrastructure-engineering-management"]
];

const db = openCaseStore();
db.exec("BEGIN");
try {
  for (const [from, to] of mappings) {
    db.prepare("UPDATE cases SET target_programme_id=? WHERE target_programme_id=?").run(to, from);
    db.prepare("UPDATE crawl_sources SET programme_id=? WHERE programme_id=?").run(to, from);
    for (const doc of db.prepare("SELECT id FROM programme_documents WHERE programme_id=?").all(from)) {
      db.prepare("UPDATE programme_documents SET id=?,programme_id=? WHERE id=?")
        .run(`${to}:merged:${doc.id}`, to, doc.id);
    }
    db.prepare("UPDATE programmes SET active=0 WHERE id=?").run(from);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(JSON.stringify({ normalized: mappings.length }, null, 2));
db.close();
