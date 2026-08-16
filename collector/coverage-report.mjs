import { openCaseStore } from "./store.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targetIds = ["hku", "cuhk", "hkust", "cityu-hk", "polyu-hk", "hkbu", "lingnan-hk", "eduhk", "nus", "ntu"];
const db = openCaseStore();
const placeholders = targetIds.map(() => "?").join(",");
const schools = db.prepare(`
  SELECT i.id, i.name_en,
    COUNT(DISTINCT p.id) AS programmes,
    COUNT(DISTINCT CASE WHEN d.id IS NOT NULL THEN p.id END) AS documented,
    COUNT(DISTINCT CASE WHEN d.provenance <> 'official-catalogue' THEN p.id END) AS full_page_documented,
    COUNT(DISTINCT CASE WHEN c.review_status='approved' THEN c.fingerprint END) AS approved_cases,
    COUNT(DISTINCT CASE WHEN c.review_status='needs-review' THEN c.fingerprint END) AS needs_review,
    COUNT(DISTINCT CASE WHEN c.review_status='rejected' THEN c.fingerprint END) AS rejected
  FROM institutions i
  JOIN programmes p ON p.institution_id=i.id AND p.active=1
  LEFT JOIN programme_documents d ON d.programme_id=p.id
  LEFT JOIN cases c ON c.target_programme_id=p.id
  WHERE i.id IN (${placeholders})
  GROUP BY i.id, i.name_en ORDER BY i.id
`).all(...targetIds);
const coverage = db.prepare(`
  SELECT COUNT(*) AS programmes,
    SUM(CASE WHEN approved=0 THEN 1 ELSE 0 END) AS zero,
    SUM(CASE WHEN approved>0 THEN 1 ELSE 0 END) AS with_cases,
    SUM(CASE WHEN approved>=8 THEN 1 ELSE 0 END) AS ge8,
    SUM(CASE WHEN approved>=15 THEN 1 ELSE 0 END) AS ge15
  FROM (
    SELECT p.id, COUNT(CASE WHEN c.review_status='approved' THEN 1 END) approved
    FROM programmes p LEFT JOIN cases c ON c.target_programme_id=p.id
    WHERE p.active=1 AND p.institution_id IN (${placeholders}) GROUP BY p.id
  )
`).get(...targetIds);
const sources = db.prepare(`
  SELECT CASE
      WHEN source_url LIKE '%hksg.org%' THEN 'HKSg'
      WHEN source_url LIKE '%mastermate.cn%' THEN 'Mastermate'
      ELSE 'Other'
    END source,
    review_status, COUNT(*) count
  FROM cases WHERE target_institution_id IN (${placeholders})
  GROUP BY source, review_status ORDER BY source, review_status
`).all(...targetIds);
const report = { generatedAt: new Date().toISOString(), schools, coverage, sources };
const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "coverage-report.json");
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, outputPath }, null, 2));
db.close();
