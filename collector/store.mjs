import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { institutionMaster, programmeMaster, resolveInstitution, resolveProgramme } from "../master-data.mjs";
import { resolveReferenceInstitution } from "./reference-store.mjs";
import { programmeSources, programmes as programmeProfiles } from "../data.mjs";

const collectorRoot = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = resolve(process.env.ADMISSION_DATA_DIR || resolve(collectorRoot, "data"), "cases.sqlite");

export function openCaseStore(dbPath = defaultDbPath) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cases (
      fingerprint TEXT PRIMARY KEY,
      target_institution_id TEXT,
      target_programme_id TEXT,
      undergraduate_institution_id TEXT,
      target_university TEXT,
      target_programme TEXT,
      target_programme_en_raw TEXT,
      offer_year INTEGER,
      undergraduate_university TEXT,
      undergraduate_major TEXT,
      gpa_raw TEXT,
      gpa_scale TEXT NOT NULL DEFAULT 'UNKNOWN',
      gpa100 REAL,
      language_test TEXT,
      language_scale TEXT,
      language_score REAL,
      internships_json TEXT NOT NULL,
      work_experience_json TEXT NOT NULL DEFAULT '[]',
      research_json TEXT NOT NULL,
      competitions_json TEXT NOT NULL DEFAULT '[]',
      awards_json TEXT NOT NULL,
      patents_json TEXT NOT NULL DEFAULT '[]',
      projects_json TEXT NOT NULL DEFAULT '[]',
      experiences_json TEXT NOT NULL DEFAULT '[]',
      auxiliary_scores_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      source_published_at TEXT,
      source_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      quality_score INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_target ON cases(target_university, target_programme);
    CREATE INDEX IF NOT EXISTS idx_cases_year ON cases(offer_year);
    CREATE INDEX IF NOT EXISTS idx_cases_review ON cases(review_status);
    CREATE TABLE IF NOT EXISTS case_sources (
      case_fingerprint TEXT NOT NULL,
      source_url TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      comparison_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (case_fingerprint, source_url)
    );
    CREATE TABLE IF NOT EXISTS crawl_sources (
      source_url TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      programme_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      extracted_count INTEGER NOT NULL DEFAULT 0,
      scoped_count INTEGER NOT NULL DEFAULT 0,
      queued_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_sources_status ON crawl_sources(status);
    CREATE TABLE IF NOT EXISTS crawl_source_scopes (
      source_url TEXT NOT NULL,
      programme_id TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      extracted_count INTEGER NOT NULL DEFAULT 0,
      scoped_count INTEGER NOT NULL DEFAULT 0,
      queued_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (source_url, programme_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_source_scopes_programme ON crawl_source_scopes(programme_id, status);
    CREATE TABLE IF NOT EXISTS crawl_extraction_cache (
      source_url TEXT PRIMARY KEY,
      page_hash TEXT NOT NULL,
      model TEXT,
      extraction_method TEXT NOT NULL,
      cases_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_extraction_cache_hash ON crawl_extraction_cache(page_hash);
    CREATE TABLE IF NOT EXISTS crawl_ocr_cache (
      source_url TEXT PRIMARY KEY,
      page_hash TEXT NOT NULL,
      model TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crawl_ocr_cache_hash ON crawl_ocr_cache(page_hash);
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      name_zh TEXT NOT NULL,
      name_en TEXT,
      aliases_json TEXT NOT NULL,
      country_region TEXT,
      classification TEXT,
      score_tier INTEGER,
      ranking_json TEXT NOT NULL,
      source_url TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS programmes (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      region TEXT NOT NULL,
      name_zh TEXT NOT NULL,
      name_en TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      official_code TEXT,
      official_url TEXT NOT NULL,
      curriculum_url TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      major_tags_json TEXT NOT NULL,
      course_tags_json TEXT NOT NULL,
      case_source_urls_json TEXT NOT NULL,
      discovery_terms_json TEXT NOT NULL DEFAULT '{}',
      source_search_terms_json TEXT NOT NULL DEFAULT '{}',
      strict_match_terms_json TEXT NOT NULL DEFAULT '[]',
      search_entrypoints_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
    );
    CREATE TABLE IF NOT EXISTS programme_documents (
      id TEXT PRIMARY KEY,
      programme_id TEXT NOT NULL,
      section TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      provenance TEXT NOT NULL,
      academic_years_json TEXT NOT NULL DEFAULT '[]',
      checked_at TEXT,
      sources_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (programme_id) REFERENCES programmes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_programme_documents_programme ON programme_documents(programme_id);
    CREATE TABLE IF NOT EXISTS case_embeddings (
      fingerprint TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (fingerprint) REFERENCES cases(fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_case_embeddings_model ON case_embeddings(model);
    CREATE TABLE IF NOT EXISTS programme_status (
      programme_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      official_url TEXT,
      final_url TEXT,
      http_status INTEGER,
      official_name_match INTEGER NOT NULL DEFAULT 0,
      history_years_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT,
      checked_at TEXT NOT NULL,
      FOREIGN KEY (programme_id) REFERENCES programmes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_programme_status_status ON programme_status(status);
    CREATE TABLE IF NOT EXISTS programme_scope (
      programme_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      reason TEXT,
      signals_json TEXT NOT NULL DEFAULT '{}',
      checked_at TEXT NOT NULL,
      FOREIGN KEY (programme_id) REFERENCES programmes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_programme_scope_scope ON programme_scope(scope);
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      goal_json TEXT NOT NULL,
      state TEXT NOT NULL,
      stop_reason TEXT,
      pages_attempted INTEGER NOT NULL DEFAULT 0,
      api_calls INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      report_json TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id)
    );
    CREATE TABLE IF NOT EXISTS analysis_records (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      applicant_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_records_created ON analysis_records(created_at DESC);
    CREATE TABLE IF NOT EXISTS analysis_feedback (
      analysis_id TEXT PRIMARY KEY,
      answers_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (analysis_id) REFERENCES analysis_records(id) ON DELETE CASCADE
    );
  `);
  const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  const columns = db.prepare("PRAGMA table_info(cases)").all();
  const programmeColumns = db.prepare("PRAGMA table_info(programmes)").all();
  const programmeAdditions = [
    ["discovery_terms_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["source_search_terms_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["strict_match_terms_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["search_entrypoints_json", "TEXT NOT NULL DEFAULT '[]'"]
  ];
  for (const [name, definition] of programmeAdditions) {
    if (!programmeColumns.some(column => column.name === name)) {
      db.exec(`ALTER TABLE programmes ADD COLUMN ${name} ${definition}`);
    }
  }
  // Version 5 refreshes the search profile for already-seeded programme rows.
  // Keep this separate from the column migration so an existing v3 database
  // does not retain empty JSON profiles forever.
  if (schemaVersion >= 5) return db;
  if (!columns.some(column => column.name === "gpa_scale")) {
    db.exec("ALTER TABLE cases ADD COLUMN gpa_scale TEXT NOT NULL DEFAULT 'UNKNOWN'");
  }
  if (!columns.some(column => column.name === "projects_json")) {
    db.exec("ALTER TABLE cases ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.some(column => column.name === "target_programme_en_raw")) {
    db.exec("ALTER TABLE cases ADD COLUMN target_programme_en_raw TEXT");
  }
  const additions = [
    ["target_institution_id", "TEXT"],
    ["target_programme_id", "TEXT"],
    ["undergraduate_institution_id", "TEXT"],
    ["work_experience_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["competitions_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["patents_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["experiences_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["auxiliary_scores_json", "TEXT NOT NULL DEFAULT '[]'"]
    ,["evidence_json", "TEXT NOT NULL DEFAULT '{}'"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE cases ADD COLUMN ${name} ${definition}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_cases_programme_id ON cases(target_programme_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_case_sources_fingerprint ON case_sources(case_fingerprint)");
  const sourceColumns = db.prepare("PRAGMA table_info(case_sources)").all();
  if (!sourceColumns.some(column => column.name === "comparison_json")) {
    db.exec("ALTER TABLE case_sources ADD COLUMN comparison_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec(`INSERT OR IGNORE INTO case_sources (case_fingerprint, source_url, evidence_json, first_seen_at)
    SELECT fingerprint, source_url, evidence_json, collected_at FROM cases WHERE source_url IS NOT NULL`);
  db.prepare(`UPDATE case_sources SET comparison_json = ? WHERE comparison_json IS NULL OR comparison_json = '{}'`)
    .run(JSON.stringify({ status: "primary", conflicts: [], fields: {} }));
  db.exec(`INSERT OR IGNORE INTO crawl_sources
    (source_url, status, first_seen_at, last_checked_at)
    SELECT source_url, 'completed', MIN(first_seen_at), MAX(first_seen_at)
    FROM case_sources GROUP BY source_url`);
  seedMasterData(db);
  seedProgrammeDocuments(db);
  migrateCaseReferences(db);
  db.exec("UPDATE cases SET review_status = 'pending' WHERE review_status = 'ready'");
  db.exec("PRAGMA user_version = 5");
  return db;
}

function seedMasterData(db) {
  const now = new Date().toISOString();
  const institutionStatement = db.prepare(`
    INSERT INTO institutions (id, name_zh, name_en, aliases_json, country_region, classification, score_tier, ranking_json, source_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name_zh=excluded.name_zh, name_en=excluded.name_en, aliases_json=excluded.aliases_json,
      country_region=excluded.country_region, classification=excluded.classification, score_tier=excluded.score_tier,
      ranking_json=excluded.ranking_json, source_url=excluded.source_url, updated_at=excluded.updated_at
  `);
  for (const institution of institutionMaster) {
    institutionStatement.run(
      institution.id, institution.nameZh, institution.nameEn, JSON.stringify(institution.aliases || []),
      institution.countryRegion, institution.classification, institution.scoreTier,
      JSON.stringify(institution.ranking || {}), institution.ranking?.sourceUrl || null, now
    );
  }
  const programmeStatement = db.prepare(`
    INSERT INTO programmes (id, institution_id, region, name_zh, name_en, aliases_json, official_code, official_url,
      curriculum_url, active, major_tags_json, course_tags_json, case_source_urls_json,
      discovery_terms_json, source_search_terms_json, strict_match_terms_json, search_entrypoints_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET institution_id=excluded.institution_id, region=excluded.region, name_zh=excluded.name_zh,
      name_en=excluded.name_en, aliases_json=excluded.aliases_json, official_code=excluded.official_code,
      official_url=excluded.official_url, curriculum_url=excluded.curriculum_url, active=excluded.active,
      major_tags_json=excluded.major_tags_json, course_tags_json=excluded.course_tags_json,
      case_source_urls_json=excluded.case_source_urls_json,
      discovery_terms_json=excluded.discovery_terms_json,
      source_search_terms_json=excluded.source_search_terms_json,
      strict_match_terms_json=excluded.strict_match_terms_json,
      search_entrypoints_json=excluded.search_entrypoints_json,
      updated_at=excluded.updated_at
  `);
  for (const programme of programmeMaster) {
    programmeStatement.run(
      programme.id, programme.institutionId, programme.region, programme.nameZh, programme.nameEn,
      JSON.stringify(programme.aliases || []), programme.officialCode, programme.officialUrl, programme.curriculumUrl,
      programme.active ? 1 : 0, JSON.stringify(programme.majorTags || []), JSON.stringify(programme.courseTags || []),
      JSON.stringify(programme.caseSourceUrls || []), JSON.stringify(programme.discoveryTerms || {}),
      JSON.stringify(programme.sourceSearchTerms || {}), JSON.stringify(programme.strictMatchTerms || []),
      JSON.stringify(programme.searchEntrypoints || programme.caseSourceUrls || []), now
    );
  }
}

function seedProgrammeDocuments(db) {
  const sections = [
    ["requirements", "项目要求", "officialNote", "official"],
    ["positioning", "项目定位", "overview", "derived"],
    ["duration", "学制与学分", "duration", "official"],
    ["curriculum", "课程结构", "curriculumStructure", "official"],
    ["orientation", "课程取向", "courseOrientation", "official"],
    ["resources", "项目与院校资源", "resources", "official"],
    ["career", "就业与发展", "career", "derived"],
    ["comparison", "相近项目区别", "differentiators", "derived"]
  ];
  const statement = db.prepare(`
    INSERT INTO programme_documents
      (id, programme_id, section, title, text, provenance, academic_years_json, checked_at, sources_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET programme_id=excluded.programme_id, section=excluded.section,
      title=excluded.title, text=excluded.text, provenance=excluded.provenance,
      academic_years_json=excluded.academic_years_json, checked_at=excluded.checked_at,
      sources_json=excluded.sources_json, updated_at=excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const programme of programmeProfiles) {
    const programmeSourceRows = programmeSources.filter(source => source.programmeId === programme.id);
    for (const [section, title, field, provenance] of sections) {
      if (!programme[field]) continue;
      const sources = programmeSourceRows.filter(source => section === "requirements"
        ? source.kind.includes("admission") || source.kind.includes("catalog") || source.kind.includes("programme")
        : source.kind.includes("curriculum") || source.kind.includes("catalog") || source.kind.includes("programme"));
      statement.run(
        `${programme.id}:${section}`, programme.id, section, title, programme[field], provenance,
        JSON.stringify([...new Set(sources.map(source => source.academicYear))]),
        sources.map(source => source.checkedAt).sort().at(-1) || null,
        JSON.stringify(sources.map(source => ({ id: source.id, kind: source.kind, url: source.url }))), now
      );
    }
  }
}
function migrateCaseReferences(db) {
  const rows = db.prepare(`SELECT fingerprint, target_university, target_programme, target_programme_en_raw,
    undergraduate_university, target_institution_id, target_programme_id, undergraduate_institution_id,
    review_status, issues_json FROM cases`).all();
  const update = db.prepare(`UPDATE cases SET target_institution_id=?, target_programme_id=?, undergraduate_institution_id=?,
    target_programme_en_raw=COALESCE(target_programme_en_raw, ?), review_status=?, issues_json=? WHERE fingerprint=?`);
  for (const row of rows) {
    const targetInstitution = row.target_institution_id ? null : resolveInstitution(row.target_university);
    const targetProgramme = row.target_programme_id
      ? programmeMaster.find(item => item.id === row.target_programme_id)
      : resolveProgramme({
        universityName: row.target_university,
        programmeName: row.target_programme,
        programmeEnglishName: row.target_programme_en_raw
      });
    const undergraduateInstitution = row.undergraduate_institution_id
      ? null
      : resolveInstitution(row.undergraduate_university) || resolveReferenceInstitution(row.undergraduate_university);
    let issues;
    try { issues = JSON.parse(row.issues_json || "[]"); } catch { issues = []; }
    if (undergraduateInstitution?.id) {
      issues = issues.filter(issue => issue !== "本科院校未匹配主表");
    }
    const nextStatus = undergraduateInstitution?.id && row.review_status === "needs-review" && issues.length === 0
      ? "pending"
      : row.review_status;
    update.run(
      row.target_institution_id || targetInstitution?.id || null,
      row.target_programme_id || targetProgramme?.id || null,
      row.undergraduate_institution_id || undergraduateInstitution?.id || null,
      row.target_programme_en_raw || targetProgramme?.nameEn || null,
      nextStatus,
      JSON.stringify(issues),
      row.fingerprint
    );
  }
}

const insertSql = `
  INSERT INTO cases (
    fingerprint, target_institution_id, target_programme_id, undergraduate_institution_id,
    target_university, target_programme, target_programme_en_raw, offer_year,
    undergraduate_university, undergraduate_major, gpa_raw, gpa_scale, gpa100,
    language_test, language_scale, language_score,
    internships_json, work_experience_json, research_json, competitions_json,
    awards_json, patents_json, projects_json, experiences_json, auxiliary_scores_json, evidence_json,
    source_published_at, source_url, collected_at,
    quality_score, review_status, issues_json, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fingerprint) DO UPDATE SET
    target_institution_id=excluded.target_institution_id,
    target_programme_id=excluded.target_programme_id,
    undergraduate_institution_id=excluded.undergraduate_institution_id,
    target_university=excluded.target_university,
    target_programme=excluded.target_programme,
    target_programme_en_raw=excluded.target_programme_en_raw,
    offer_year=excluded.offer_year,
    undergraduate_university=excluded.undergraduate_university,
    undergraduate_major=excluded.undergraduate_major,
    gpa_raw=excluded.gpa_raw,
    gpa_scale=excluded.gpa_scale,
    gpa100=excluded.gpa100,
    language_test=excluded.language_test,
    language_scale=excluded.language_scale,
    language_score=excluded.language_score,
    internships_json=excluded.internships_json,
    work_experience_json=excluded.work_experience_json,
    research_json=excluded.research_json,
    competitions_json=excluded.competitions_json,
    awards_json=excluded.awards_json,
    patents_json=excluded.patents_json,
    projects_json=excluded.projects_json,
    experiences_json=excluded.experiences_json,
    auxiliary_scores_json=excluded.auxiliary_scores_json,
    evidence_json=excluded.evidence_json,
    source_published_at=excluded.source_published_at,
    quality_score=excluded.quality_score,
    review_status=excluded.review_status,
    issues_json=excluded.issues_json,
    raw_json=excluded.raw_json
  WHERE cases.review_status <> 'approved' AND excluded.review_status = 'approved'
`;

function candidateValues(item) {
  return [
    item.fingerprint, item.targetInstitutionId, item.targetProgrammeId, item.undergraduateInstitutionId,
    item.targetUniversity, item.targetProgramme, item.targetProgrammeEnglishRaw, item.offerYear,
    item.undergraduateUniversity, item.undergraduateMajor, item.gpaRaw, item.gpaScale, item.gpa100,
    item.languageTest, item.languageScale, item.languageScore,
    JSON.stringify(item.internships || []), JSON.stringify(item.workExperience || []),
    JSON.stringify(item.research || []), JSON.stringify(item.competitions || []),
    JSON.stringify(item.awards || []), JSON.stringify(item.patents || []),
    JSON.stringify(item.projects || []), JSON.stringify(item.experiences || []), JSON.stringify(item.auxiliaryScores || []), JSON.stringify(item.sourceEvidence || {}),
    item.sourcePublishedAt, item.sourceUrl, item.collectedAt,
    item.completenessScore ?? item.qualityScore ?? 0, item.reviewStatus, JSON.stringify(item.issues), JSON.stringify(item)
  ];
}

function normalizeIdentityText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/gpa/gi, "")
    .replace(/[\s·•・,，.。()（）\-_/\\'’]/g, "");
}

function normalizeIdentityGpa(value) {
  const match = String(value || "").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]).toFixed(4) : normalizeIdentityText(value);
}

export function caseIdentityKey(item) {
  const undergraduateInstitution = item.undergraduateInstitutionId || item.undergraduate_institution_id
    || item.undergraduateUniversity || item.undergraduate_university;
  const undergraduateMajor = item.undergraduateMajor || item.undergraduate_major;
  const targetProgramme = item.targetProgrammeId || item.target_programme_id
    || item.targetProgramme || item.target_programme;
  const gpa = item.gpaRaw || item.gpa_raw
    || (item.gpa100 !== null && item.gpa100 !== undefined ? item.gpa100 : null);
  return [
    targetProgramme,
    item.offerYear ?? item.offer_year,
    undergraduateInstitution,
    undergraduateMajor,
    normalizeIdentityGpa(gpa),
    item.languageTest || item.language_test,
    item.languageScore ?? item.language_score
  ].map(normalizeIdentityText).join("|");
}

// Same applicant identity while ignoring the resolved programme ID. This is
// used only as a repair bridge when a previously-unmatched raw programme name
// is later mapped to the master table; the raw programme text remains part of
// the key so separate offers on one aggregate page are not collapsed.
function rawProgrammeIdentityKey(item) {
  const undergraduateInstitution = item.undergraduateInstitutionId || item.undergraduate_institution_id
    || item.undergraduateUniversity || item.undergraduate_university;
  const undergraduateMajor = item.undergraduateMajor || item.undergraduate_major;
  const gpa = item.gpaRaw || item.gpa_raw
    || (item.gpa100 !== null && item.gpa100 !== undefined ? item.gpa100 : null);
  return [
    item.targetProgramme || item.target_programme,
    item.offerYear ?? item.offer_year,
    undergraduateInstitution,
    undergraduateMajor,
    normalizeIdentityGpa(gpa),
    item.languageTest || item.language_test,
    item.languageScore ?? item.language_score
  ].map(normalizeIdentityText).join("|");
}

const valueFrom = (item, camel, snake) => item?.[camel] ?? item?.[snake] ?? null;

export function compareCaseFields(existing, candidate) {
  const fieldValues = {
    targetProgramme: [valueFrom(existing, "targetProgrammeId", "target_programme_id") || valueFrom(existing, "targetProgramme", "target_programme"), candidate.targetProgrammeId || candidate.targetProgramme],
    offerYear: [valueFrom(existing, "offerYear", "offer_year"), candidate.offerYear],
    undergraduateUniversity: [valueFrom(existing, "undergraduateInstitutionId", "undergraduate_institution_id") || valueFrom(existing, "undergraduateUniversity", "undergraduate_university"), candidate.undergraduateInstitutionId || candidate.undergraduateUniversity],
    undergraduateMajor: [valueFrom(existing, "undergraduateMajor", "undergraduate_major"), candidate.undergraduateMajor],
    gpa: [valueFrom(existing, "gpa100", "gpa100") ?? valueFrom(existing, "gpaRaw", "gpa_raw"), candidate.gpa100 ?? candidate.gpaRaw],
    languageTest: [valueFrom(existing, "languageTest", "language_test"), candidate.languageTest],
    languageScore: [valueFrom(existing, "languageScore", "language_score"), candidate.languageScore]
  };
  const fields = Object.fromEntries(Object.entries(fieldValues).map(([field, [left, right]]) => [field, {
    same: normalizeIdentityText(left) === normalizeIdentityText(right),
    existing: left,
    candidate: right
  }]));
  const conflicts = Object.entries(fields).filter(([, value]) => !value.same && value.existing != null && value.candidate != null).map(([field]) => field);
  return { status: conflicts.length ? "conflict" : "match", conflicts, fields, checkedAt: new Date().toISOString() };
}

export function insertCases(db, candidates) {
  candidates = candidates.map(item => item.offerYear != null && item.offerYear <= 2020 ? {
    ...item,
    reviewStatus: "rejected",
    issues: [...new Set([...(item.issues || []), "录取年份早于2021年，按案例保留规则排除"])]
  } : item);
  const statement = db.prepare(insertSql);
  const existingRows = db.prepare(`SELECT fingerprint, target_programme_id, target_programme,
    offer_year, undergraduate_institution_id, undergraduate_university, undergraduate_major,
    gpa_raw, gpa100, language_test, language_score, review_status FROM cases`).all();
  const existingByKey = new Map(existingRows.map(row => [caseIdentityKey(row), row]));
  const existingByRawKey = new Map(existingRows.map(row => [rawProgrammeIdentityKey(row), row]));
  const sourceStatement = db.prepare(`INSERT INTO case_sources
    (case_fingerprint, source_url, evidence_json, comparison_json, first_seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(case_fingerprint, source_url) DO UPDATE SET
      evidence_json=excluded.evidence_json`);
  const inserted = [];
  db.exec("BEGIN");
  try {
    for (const item of candidates) {
      const identityKey = caseIdentityKey(item);
      const existing = existingByRawKey.get(rawProgrammeIdentityKey(item)) || existingByKey.get(identityKey);
      if (existing) {
        if (existing.review_status !== "approved" && item.reviewStatus === "approved") {
          // Programme alias repairs can change the fingerprint while the
          // underlying applicant/offer is still the same identity. Promote
          // the existing row in place so the old needs-review record does not
          // block the newly resolved programme from entering coverage.
          const promoted = { ...item, fingerprint: existing.fingerprint };
          const result = statement.run(...candidateValues(promoted));
          if (result.changes) {
            existingByKey.set(identityKey, { ...promoted, review_status: promoted.reviewStatus });
            existingByRawKey.set(rawProgrammeIdentityKey(promoted), { ...promoted, review_status: promoted.reviewStatus });
            inserted.push(promoted);
          }
        }
        if (item.sourceUrl) sourceStatement.run(existing.fingerprint, item.sourceUrl, JSON.stringify(item.sourceEvidence || {}), JSON.stringify(compareCaseFields(existing, item)), item.collectedAt || new Date().toISOString());
        continue;
      }
      const result = statement.run(...candidateValues(item));
      if (result.changes) {
        const primaryRow = { ...item, fingerprint: item.fingerprint };
        existingByKey.set(identityKey, primaryRow);
        existingByRawKey.set(rawProgrammeIdentityKey(primaryRow), primaryRow);
        if (item.sourceUrl) sourceStatement.run(item.fingerprint, item.sourceUrl, JSON.stringify(item.sourceEvidence || {}), JSON.stringify({ status: "primary", conflicts: [], fields: {}, checkedAt: new Date().toISOString() }), item.collectedAt || new Date().toISOString());
        inserted.push(item);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

export function replaceCasesForSource(db, sourceUrl, candidates) {
  if (!sourceUrl || candidates.some(candidate => candidate.sourceUrl !== sourceUrl)) throw new Error("替换批次必须来自同一个来源URL");
  const approved = db.prepare("SELECT COUNT(*) AS count FROM cases WHERE source_url = ? AND review_status = 'approved'").get(sourceUrl).count;
  if (approved) throw new Error("来源中已有审核通过案例，拒绝自动替换");
  const statement = db.prepare(insertSql);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM case_sources WHERE source_url = ?").run(sourceUrl);
    db.prepare("DELETE FROM cases WHERE source_url = ?").run(sourceUrl);
    const sourceStatement = db.prepare(`INSERT OR IGNORE INTO case_sources
      (case_fingerprint, source_url, evidence_json, comparison_json, first_seen_at) VALUES (?, ?, ?, ?, ?)`);
    for (const item of candidates) {
      statement.run(...candidateValues(item));
      sourceStatement.run(item.fingerprint, item.sourceUrl, JSON.stringify(item.sourceEvidence || {}), JSON.stringify({ status: "primary", conflicts: [], fields: {}, checkedAt: new Date().toISOString() }), item.collectedAt || new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return candidates;
}

function decodeRow(row) {
  if (!row) return null;
  return {
    fingerprint: row.fingerprint,
    targetInstitutionId: row.target_institution_id,
    targetProgrammeId: row.target_programme_id,
    undergraduateInstitutionId: row.undergraduate_institution_id,
    targetUniversity: row.target_university,
    targetProgramme: row.target_programme,
    targetProgrammeEnglishRaw: row.target_programme_en_raw,
    offerYear: row.offer_year,
    undergraduateUniversity: row.undergraduate_university,
    undergraduateMajor: row.undergraduate_major,
    gpaRaw: row.gpa_raw,
    gpaScale: row.gpa_scale,
    gpa100: row.gpa100,
    languageTest: row.language_test,
    languageScale: row.language_scale,
    languageScore: row.language_score,
    internships: JSON.parse(row.internships_json),
    workExperience: JSON.parse(row.work_experience_json || "[]"),
    research: JSON.parse(row.research_json),
    competitions: JSON.parse(row.competitions_json || "[]"),
    awards: JSON.parse(row.awards_json),
    patents: JSON.parse(row.patents_json || "[]"),
    projects: JSON.parse(row.projects_json),
    experiences: JSON.parse(row.experiences_json || "[]"),
    auxiliaryScores: JSON.parse(row.auxiliary_scores_json || "[]"),
    sourceEvidence: JSON.parse(row.evidence_json || "{}"),
    sourcePublishedAt: row.source_published_at,
    sourceUrl: row.source_url,
    collectedAt: row.collected_at,
    completenessScore: row.quality_score,
    reviewStatus: row.review_status,
    issues: JSON.parse(row.issues_json)
  };
}

function addSourceRefs(db, row) {
  const decoded = decodeRow(row);
  if (!decoded) return null;
  decoded.sourceRefs = db.prepare("SELECT source_url, evidence_json, comparison_json, first_seen_at FROM case_sources WHERE case_fingerprint = ? ORDER BY first_seen_at").all(row.fingerprint)
    .map(item => ({
      url: item.source_url,
      evidence: JSON.parse(item.evidence_json || "{}"),
      comparison: JSON.parse(item.comparison_json || "{}"),
      firstSeenAt: item.first_seen_at
    }));
  decoded.sourceUrls = decoded.sourceRefs.map(item => item.url);
  return decoded;
}

function decodeProgrammeDocument(row) {
  return {
    id: row.id,
    programmeId: row.programme_id,
    section: row.section,
    title: row.title,
    text: row.text,
    provenance: row.provenance,
    academicYears: JSON.parse(row.academic_years_json || "[]"),
    checkedAt: row.checked_at,
    sources: JSON.parse(row.sources_json || "[]")
  };
}

export function listProgrammeDocuments(db, programmeIds = []) {
  const ids = [...new Set(programmeIds.filter(Boolean))];
  const whereProgramme = ids.length ? ` WHERE programme_id IN (${ids.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM programme_documents${whereProgramme} ORDER BY programme_id, id`)
    .all(...ids).map(decodeProgrammeDocument);
}

function decodeProgrammeStatus(row) {
  if (!row) return null;
  const parse = (value, fallback) => {
    try { return JSON.parse(value ?? JSON.stringify(fallback)); } catch { return fallback; }
  };
  return {
    programmeId: row.programme_id,
    status: row.status,
    confidence: Number(row.confidence || 0),
    officialUrl: row.official_url || null,
    finalUrl: row.final_url || null,
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    officialNameMatch: Boolean(row.official_name_match),
    historyYears: parse(row.history_years_json, []),
    evidence: parse(row.evidence_json, {}),
    reason: row.reason || null,
    checkedAt: row.checked_at || null
  };
}

export function getProgrammeStatus(db, programmeId) {
  if (!programmeId) return null;
  return decodeProgrammeStatus(db.prepare("SELECT * FROM programme_status WHERE programme_id = ?").get(programmeId));
}

export function listProgrammeStatuses(db, statuses = []) {
  const values = [...new Set(statuses.filter(Boolean))];
  const where = values.length ? ` WHERE status IN (${values.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM programme_status${where} ORDER BY programme_id`).all(...values).map(decodeProgrammeStatus);
}

export function saveProgrammeStatus(db, {
  programmeId,
  status,
  confidence = 0,
  officialUrl = null,
  finalUrl = null,
  httpStatus = null,
  officialNameMatch = false,
  historyYears = [],
  evidence = {},
  reason = null,
  checkedAt = new Date().toISOString()
} = {}) {
  if (!programmeId || !status) throw new Error("项目状态缺少 programmeId 或 status");
  db.prepare(`
    INSERT INTO programme_status
      (programme_id, status, confidence, official_url, final_url, http_status,
       official_name_match, history_years_json, evidence_json, reason, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(programme_id) DO UPDATE SET
      status=excluded.status,
      confidence=excluded.confidence,
      official_url=excluded.official_url,
      final_url=excluded.final_url,
      http_status=excluded.http_status,
      official_name_match=excluded.official_name_match,
      history_years_json=excluded.history_years_json,
      evidence_json=excluded.evidence_json,
      reason=excluded.reason,
      checked_at=excluded.checked_at
  `).run(
    programmeId, status, Number(confidence || 0), officialUrl, finalUrl, httpStatus,
    officialNameMatch ? 1 : 0, JSON.stringify(historyYears || []), JSON.stringify(evidence || {}), reason, checkedAt
  );
  return getProgrammeStatus(db, programmeId);
}

function decodeProgrammeScope(row) {
  if (!row) return null;
  let signals = {};
  try { signals = JSON.parse(row.signals_json || "{}"); } catch { signals = {}; }
  return {
    programmeId: row.programme_id,
    scope: row.scope,
    confidence: Number(row.confidence || 0),
    reason: row.reason || null,
    signals,
    checkedAt: row.checked_at || null
  };
}

export function getProgrammeScope(db, programmeId) {
  if (!programmeId) return null;
  return decodeProgrammeScope(db.prepare("SELECT * FROM programme_scope WHERE programme_id = ?").get(programmeId));
}

export function listProgrammeScopes(db, scopes = []) {
  const values = [...new Set(scopes.filter(Boolean))];
  const where = values.length ? ` WHERE scope IN (${values.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM programme_scope${where} ORDER BY programme_id`).all(...values).map(decodeProgrammeScope);
}

export function saveProgrammeScope(db, {
  programmeId,
  scope,
  confidence = 0,
  reason = null,
  signals = {},
  checkedAt = new Date().toISOString()
} = {}) {
  if (!programmeId || !scope) throw new Error("项目范围缺少 programmeId 或 scope");
  db.prepare(`
    INSERT INTO programme_scope (programme_id, scope, confidence, reason, signals_json, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(programme_id) DO UPDATE SET
      scope=excluded.scope,
      confidence=excluded.confidence,
      reason=excluded.reason,
      signals_json=excluded.signals_json,
      checked_at=excluded.checked_at
  `).run(programmeId, scope, Number(confidence || 0), reason, JSON.stringify(signals || {}), checkedAt);
  return getProgrammeScope(db, programmeId);
}
export function storeStatus(db) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM cases").get().count;
  const states = db.prepare("SELECT review_status, COUNT(*) AS count FROM cases GROUP BY review_status").all();
  return { total, ...Object.fromEntries(states.map(row => [row.review_status, row.count])) };
}

export function getCrawlSource(db, sourceUrl) {
  if (!sourceUrl) return null;
  return db.prepare("SELECT * FROM crawl_sources WHERE source_url = ?").get(sourceUrl) || null;
}

export function getCrawlSourceScope(db, sourceUrl, programmeId) {
  if (!sourceUrl || !programmeId) return null;
  return db.prepare("SELECT * FROM crawl_source_scopes WHERE source_url = ? AND programme_id = ?")
    .get(sourceUrl, programmeId) || null;
}

export function getExtractionCache(db, sourceUrl) {
  if (!sourceUrl) return null;
  const row = db.prepare("SELECT * FROM crawl_extraction_cache WHERE source_url = ?").get(sourceUrl);
  if (!row) return null;
  try {
    return { ...row, cases: JSON.parse(row.cases_json) };
  } catch {
    return null;
  }
}

export function saveExtractionCache(db, {
  sourceUrl,
  pageHash,
  model = null,
  extractionMethod = "llm",
  cases = []
}) {
  if (!sourceUrl || !pageHash || !Array.isArray(cases)) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crawl_extraction_cache
      (source_url, page_hash, model, extraction_method, cases_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      page_hash=excluded.page_hash,
      model=excluded.model,
      extraction_method=excluded.extraction_method,
      cases_json=excluded.cases_json,
      updated_at=excluded.updated_at
  `).run(sourceUrl, pageHash, model, extractionMethod, JSON.stringify(cases), now, now);
}

export function getOcrCache(db, sourceUrl) {
  if (!sourceUrl) return null;
  return db.prepare("SELECT * FROM crawl_ocr_cache WHERE source_url = ?").get(sourceUrl) || null;
}

export function saveOcrCache(db, {
  sourceUrl,
  pageHash,
  model = null,
  text = ""
} = {}) {
  if (!sourceUrl || !pageHash || typeof text !== "string") return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO crawl_ocr_cache
      (source_url, page_hash, model, text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      page_hash=excluded.page_hash,
      model=excluded.model,
      text=excluded.text,
      updated_at=excluded.updated_at
  `).run(sourceUrl, pageHash, model, text, now, now);
}

export function recordCrawlSource(db, {
  sourceUrl, finalUrl = null, status = "completed", programmeId = null,
  extractedCount = 0, scopedCount = 0, queuedCount = 0, error = null,
  checkedAt = new Date().toISOString()
} = {}) {
  const urls = [...new Set([sourceUrl, finalUrl].filter(Boolean))];
  const statement = db.prepare(`
    INSERT INTO crawl_sources
      (source_url, status, programme_id, first_seen_at, last_checked_at, extracted_count, scoped_count, queued_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      status = excluded.status,
      programme_id = COALESCE(excluded.programme_id, crawl_sources.programme_id),
      last_checked_at = excluded.last_checked_at,
      extracted_count = excluded.extracted_count,
      scoped_count = excluded.scoped_count,
      queued_count = excluded.queued_count,
      error = excluded.error
  `);
  for (const url of urls) {
    statement.run(url, status, programmeId, checkedAt, checkedAt, extractedCount, scopedCount, queuedCount, error);
    if (programmeId) {
      db.prepare(`
        INSERT INTO crawl_source_scopes
          (source_url, programme_id, status, first_seen_at, last_checked_at, extracted_count, scoped_count, queued_count, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_url, programme_id) DO UPDATE SET
          status = excluded.status,
          last_checked_at = excluded.last_checked_at,
          extracted_count = excluded.extracted_count,
          scoped_count = excluded.scoped_count,
          queued_count = excluded.queued_count,
          error = excluded.error
      `).run(url, programmeId, status, checkedAt, checkedAt, extractedCount, scopedCount, queuedCount, error);
    }
  }
  return urls.map(url => getCrawlSource(db, url));
}

export function listCases(db, limit = 20) {
  return db.prepare("SELECT * FROM cases ORDER BY collected_at DESC LIMIT ?").all(limit).map(row => addSourceRefs(db, row));
}

export function listCasesByStatus(db, statuses, limit = 100) {
  const values = [...new Set(statuses)].filter(status => ["approved", "rejected", "pending", "needs-review"].includes(status));
  if (!values.length) return [];
  const placeholders = values.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM cases WHERE review_status IN (${placeholders}) ORDER BY collected_at DESC LIMIT ?`)
    .all(...values, limit).map(row => addSourceRefs(db, row));
}

export function getCase(db, fingerprint) {
  return addSourceRefs(db, db.prepare("SELECT * FROM cases WHERE fingerprint = ?").get(fingerprint));
}

export function reviewCase(db, fingerprint, status, audit = null) {
  if (!["approved", "rejected", "pending", "needs-review"].includes(status)) throw new Error(`无效审核状态：${status}`);
  const caseYear = db.prepare("SELECT offer_year FROM cases WHERE fingerprint = ?").get(fingerprint)?.offer_year;
  if (status === "approved" && caseYear != null && caseYear <= 2020) throw new Error("仅保留2021年及之后的案例");
  let result;
  if (audit) {
    const row = db.prepare("SELECT evidence_json FROM cases WHERE fingerprint = ?").get(fingerprint);
    if (!row) throw new Error(`没有找到案例：${fingerprint}`);
    const evidence = JSON.parse(row.evidence_json || "{}");
    const reviewAudit = Array.isArray(evidence.reviewAudit) ? evidence.reviewAudit : [];
    evidence.reviewAudit = [...reviewAudit, { ...audit, status, checkedAt: new Date().toISOString() }].slice(-20);
    result = db.prepare("UPDATE cases SET review_status = ?, evidence_json = ? WHERE fingerprint = ?")
      .run(status, JSON.stringify(evidence), fingerprint);
  } else {
    result = db.prepare("UPDATE cases SET review_status = ? WHERE fingerprint = ?").run(status, fingerprint);
  }
  if (!result.changes) throw new Error(`没有找到案例：${fingerprint}`);
  return getCase(db, fingerprint);
}

export function updateCaseFields(db, fingerprint, input) {
  const current = getCase(db, fingerprint);
  if (!current) throw new Error(`没有找到案例：${fingerprint}`);
  const text = (name, fallback = null) => input[name] === undefined ? fallback : String(input[name] || "").trim() || null;
  const number = (name, fallback = null) => input[name] === undefined ? fallback : (input[name] === "" || input[name] == null ? null : Number(input[name]));
  const targetUniversity = text("targetUniversity", current.targetUniversity);
  const targetProgramme = text("targetProgramme", current.targetProgramme);
  const requestedProgrammeId = text("targetProgrammeId", current.targetProgrammeId);
  const programme = programmeMaster.find(item => item.id === requestedProgrammeId) || resolveProgramme({ universityName: targetUniversity, programmeName: targetProgramme });
  if (requestedProgrammeId && !programme) throw new Error(`项目主表中没有：${requestedProgrammeId}`);
  const undergraduateUniversity = text("undergraduateUniversity", current.undergraduateUniversity);
  const undergraduateInstitution = resolveInstitution(undergraduateUniversity) || resolveReferenceInstitution(undergraduateUniversity);
  const offerYear = number("offerYear", current.offerYear);
  if (offerYear != null && (!Number.isInteger(offerYear) || offerYear < 2000 || offerYear > new Date().getFullYear() + 1)) throw new Error("年份必须是有效的四位年份");
  const languageScore = number("languageScore", current.languageScore);
  if (languageScore != null && !Number.isFinite(languageScore)) throw new Error("语言成绩必须是数字");
  const evidence = current.sourceEvidence || {};
  evidence.reviewAudit = [...(evidence.reviewAudit || []), {
    reviewer: "manual", action: "edit", fields: Object.keys(input), checkedAt: new Date().toISOString()
  }].slice(-20);
  const raw = {
    ...(db.prepare("SELECT raw_json FROM cases WHERE fingerprint=?").get(fingerprint) ? JSON.parse(db.prepare("SELECT raw_json FROM cases WHERE fingerprint=?").get(fingerprint).raw_json || "{}") : {}),
    targetUniversity, targetProgramme, targetProgrammeId: programme?.id || null,
    offerYear, undergraduateUniversity, undergraduateMajor: text("undergraduateMajor", current.undergraduateMajor),
    gpaRaw: text("gpaRaw", current.gpaRaw), languageTest: text("languageTest", current.languageTest),
    languageScore, sourcePublishedAt: text("sourcePublishedAt", current.sourcePublishedAt)
  };
  db.prepare(`UPDATE cases SET target_institution_id=?, target_programme_id=?, undergraduate_institution_id=?,
    target_university=?, target_programme=?, offer_year=?, undergraduate_university=?, undergraduate_major=?,
    gpa_raw=?, language_test=?, language_score=?, source_published_at=?, review_status='needs-review',
    issues_json=?, evidence_json=?, raw_json=? WHERE fingerprint=?`).run(
      programme?.institutionId || resolveInstitution(targetUniversity)?.id || null,
      programme?.id || null, undergraduateInstitution?.id || null,
      targetUniversity, targetProgramme, offerYear, undergraduateUniversity,
      raw.undergraduateMajor, raw.gpaRaw, raw.languageTest, languageScore, raw.sourcePublishedAt,
      JSON.stringify(["人工修改后等待确认"]), JSON.stringify(evidence), JSON.stringify(raw), fingerprint
    );
  return getCase(db, fingerprint);
}

export function reassignCaseProgramme(db, fingerprint, programmeId, audit = {}) {
  const current = getCase(db, fingerprint);
  const programme = programmeMaster.find(item => item.id === programmeId);
  if (!current) throw new Error(`没有找到案例：${fingerprint}`);
  if (!programme) throw new Error(`项目主表中没有：${programmeId}`);
  const evidence = current.sourceEvidence || {};
  evidence.reviewAudit = [...(evidence.reviewAudit || []), {
    reviewer: audit.reviewer || "automation",
    action: "reassign-programme",
    from: current.targetProgrammeId,
    to: programmeId,
    reason: audit.reason || "来源详情页项目名称与历史主表归属不一致",
    checkedAt: new Date().toISOString()
  }].slice(-20);
  const raw = { ...(current.raw || {}), targetProgrammeId: programmeId };
  db.prepare(`UPDATE cases SET target_institution_id=?, target_programme_id=?, evidence_json=?, raw_json=? WHERE fingerprint=?`)
    .run(programme.institutionId || null, programmeId, JSON.stringify(evidence), JSON.stringify(raw), fingerprint);
  return getCase(db, fingerprint);
}

export function listApprovedCases(db, programmeIds = []) {
  const ids = [...new Set(programmeIds.filter(Boolean))];
  const whereProgramme = ids.length ? ` AND target_programme_id IN (${ids.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM cases WHERE review_status = 'approved' AND offer_year >= 2021${whereProgramme} ORDER BY offer_year DESC, collected_at DESC, fingerprint ASC`)
    .all(...ids).map(row => addSourceRefs(db, row));
}

export function listCaseEmbeddings(db, fingerprints = []) {
  const ids = [...new Set(fingerprints.filter(Boolean))];
  const whereFingerprint = ids.length ? ` WHERE fingerprint IN (${ids.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT * FROM case_embeddings${whereFingerprint} ORDER BY fingerprint`)
    .all(...ids)
    .map(row => ({
      fingerprint: row.fingerprint,
      model: row.model,
      dimensions: Number(row.dimensions),
      vector: JSON.parse(row.vector_json),
      textHash: row.text_hash,
      updatedAt: row.updated_at
    }));
}

export function upsertCaseEmbeddings(db, embeddings = []) {
  const statement = db.prepare(`
    INSERT INTO case_embeddings (fingerprint, model, dimensions, vector_json, text_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET model=excluded.model, dimensions=excluded.dimensions,
      vector_json=excluded.vector_json, text_hash=excluded.text_hash, updated_at=excluded.updated_at
  `);
  for (const item of embeddings) {
    const vector = Array.isArray(item.vector) ? item.vector.map(Number).filter(Number.isFinite) : [];
    if (!item.fingerprint || !item.model || !vector.length || !item.textHash) continue;
    statement.run(item.fingerprint, item.model, vector.length, JSON.stringify(vector), item.textHash, item.updatedAt || new Date().toISOString());
  }
}

export function caseCoverage(db, programmeId) {
  const rows = db.prepare(`
    SELECT review_status, COUNT(*) AS count,
      SUM(CASE WHEN offer_year >= 2021 THEN 1 ELSE 0 END) AS approved_2021_count,
      SUM(CASE WHEN offer_year >= 2021 THEN 1 ELSE 0 END) AS current_count,
      SUM(CASE WHEN offer_year >= ? THEN 1 ELSE 0 END) AS recent_count
    FROM cases WHERE target_programme_id = ? GROUP BY review_status
  `).all(new Date().getFullYear() - 2, programmeId);
  const byStatus = Object.fromEntries(rows.map(row => [row.review_status, row.count]));
  const approvedRow = rows.find(row => row.review_status === "approved");
  const pendingRows = rows.filter(row => ["pending", "needs-review"].includes(row.review_status));
  return {
    programmeId,
    total: rows.reduce((sum, row) => sum + row.count, 0),
    approved: byStatus.approved || 0,
    pending: (byStatus.pending || 0) + (byStatus["needs-review"] || 0),
    rejected: byStatus.rejected || 0,
    approved2021: Number(approvedRow?.approved_2021_count || 0),
    pending2021: pendingRows.reduce((sum, row) => sum + Number(row.current_count || 0), 0),
    recentApproved: Number(approvedRow?.recent_count || 0)
  };
}

export function startAgentRun(db, run) {
  const staleBefore = new Date(Date.now() - Number(run.staleAfterMs || 30 * 60 * 1000)).toISOString();
  db.prepare(`UPDATE agent_runs
    SET state='aborted', stop_reason='stale-run-recovered', finished_at=?
    WHERE state='running' AND started_at < ?`).run(new Date().toISOString(), staleBefore);
  db.prepare(`INSERT INTO agent_runs (id, goal_json, state, started_at) VALUES (?, ?, ?, ?)`)
    .run(run.id, JSON.stringify(run.goal), run.state, run.startedAt);
}

export function appendAgentStep(db, runId, step) {
  db.prepare(`INSERT INTO agent_steps (run_id, step_index, action, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, step.index, step.action, step.status, JSON.stringify(step.detail || {}), step.createdAt);
}

export function finishAgentRun(db, runId, report) {
  db.prepare(`UPDATE agent_runs SET state=?, stop_reason=?, pages_attempted=?, api_calls=?, errors=?, finished_at=?, report_json=? WHERE id=?`)
    .run(report.state, report.stopReason, report.pagesAttempted, report.apiCalls, report.errors, report.finishedAt, JSON.stringify(report), runId);
}

export function listAgentRuns(db, limit = 10) {
  return db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit).map(row => ({
    id: row.id,
    goal: JSON.parse(row.goal_json),
    state: row.state,
    stopReason: row.stop_reason,
    pagesAttempted: row.pages_attempted,
    apiCalls: row.api_calls,
    errors: row.errors,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    report: row.report_json ? JSON.parse(row.report_json) : null
  }));
}

export function createAnalysisRecord(db, record) {
  db.prepare(`INSERT INTO analysis_records (id, status, applicant_json, created_at) VALUES (?, 'processing', ?, ?)`)
    .run(record.id, JSON.stringify(record.applicant || {}), record.createdAt || new Date().toISOString());
  return record.id;
}

export function completeAnalysisRecord(db, id, { status = "completed", result = null, error = null, completedAt = new Date().toISOString() } = {}) {
  db.prepare(`UPDATE analysis_records SET status=?, result_json=?, error=?, completed_at=? WHERE id=?`)
    .run(status, result == null ? null : JSON.stringify(result), error, completedAt, id);
}

export function saveAnalysisFeedback(db, analysisId, answers, createdAt = new Date().toISOString()) {
  const record = db.prepare("SELECT id FROM analysis_records WHERE id=?").get(analysisId);
  if (!record) return false;
  db.prepare(`INSERT INTO analysis_feedback (analysis_id, answers_json, created_at) VALUES (?, ?, ?)
    ON CONFLICT(analysis_id) DO UPDATE SET answers_json=excluded.answers_json, created_at=excluded.created_at`)
    .run(analysisId, JSON.stringify(answers || {}), createdAt);
  return true;
}

export function listAnalysisRecords(db, limit = 100) {
  const parse = (value, fallback) => {
    try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
  };
  return db.prepare(`SELECT r.*, f.answers_json, f.created_at AS feedback_at
    FROM analysis_records r LEFT JOIN analysis_feedback f ON f.analysis_id=r.id
    ORDER BY r.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(1000, Number(limit) || 100))).map(row => ({
      id: row.id,
      status: row.status,
      applicant: parse(row.applicant_json, {}),
      result: parse(row.result_json, null),
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      feedback: parse(row.answers_json, null),
      feedbackAt: row.feedback_at
    }));
}

export function listMasterData(db) {
  return {
    institutions: db.prepare("SELECT id, name_zh, name_en, country_region, classification, score_tier FROM institutions ORDER BY id").all(),
    programmes: db.prepare(`SELECT id, institution_id, region, name_zh, name_en, official_code, official_url,
      discovery_terms_json, source_search_terms_json, strict_match_terms_json, search_entrypoints_json
      FROM programmes ORDER BY id`).all()
  };
}
