import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { institutionMaster, normalizeMasterName } from "../master-data.mjs";
import { classifyMoeInstitution } from "../verified-school-tiers.mjs";

const root = dirname(fileURLToPath(import.meta.url));
export const referenceDbPath = resolve(process.env.ADMISSION_REFERENCE_DB_PATH || resolve(root, "data", "reference", "institutions.sqlite"));

function escapeLike(value) {
  return String(value || "").replaceAll("%", "").replaceAll("_", "");
}

function masterResult(item) {
  return {
    id: item.id,
    nameZh: item.nameZh,
    nameEn: item.nameEn,
    classification: item.classification,
    scoreTier: item.scoreTier,
    countryRegion: item.countryRegion,
    source: "master"
  };
}

function moeResult(row) {
  return {
    id: `moe:${row.institution_code}`,
    nameZh: row.name,
    nameEn: null,
    ...classifyMoeInstitution(row.name, row.education_level, row.note),
    countryRegion: row.city,
    authority: row.authority,
    educationLevel: row.education_level,
    note: row.note,
    source: "MOE"
  };
}

function moeResults(db, raw, limit) {
  try {
    return db.prepare(`SELECT institution_code, name, authority, city, education_level, note
      FROM moe_institutions WHERE name LIKE ? LIMIT ?`).all(`%${escapeLike(raw)}%`, limit).map(moeResult);
  } catch (error) {
    // The MOE table is an optional second-stage index; old ROR-only databases remain valid.
    if (error?.code === "SQLITE_ERROR") return [];
    throw error;
  }
}

function overseasResults(db, raw, limit) {
  try {
    const pattern = `%${escapeLike(raw)}%`;
    return db.prepare(`SELECT overseas_id, name, country, country_code, domains, web_pages, state_province
      FROM overseas_institutions WHERE name LIKE ? OR domains LIKE ? LIMIT ?`).all(pattern, pattern, limit).map(row => ({
      id: row.overseas_id,
      nameZh: row.name,
      nameEn: row.name,
      classification: "海外本科身份库",
      scoreTier: null,
      countryRegion: row.country,
      countryCode: row.country_code,
      domains: JSON.parse(row.domains || "[]"),
      website: JSON.parse(row.web_pages || "[]")[0] || null,
      stateProvince: row.state_province,
      source: "HIPO"
    }));
  } catch (error) {
    if (error?.code === "SQLITE_ERROR" || /no such table/i.test(error?.message || "")) return [];
    throw error;
  }
}

export function searchInstitutions(query, limit = 8, dbPath = referenceDbPath) {
  const raw = String(query || "").trim();
  if (!raw) return institutionMaster.slice(0, limit).map(masterResult);
  const normalized = normalizeMasterName(raw);
  const masterMatches = institutionMaster.filter(item => [item.nameZh, item.nameEn, ...(item.aliases || [])]
    .filter(Boolean).some(name => normalizeMasterName(name).includes(normalized))).map(masterResult);
  if (!existsSync(dbPath) || masterMatches.length >= limit) return masterMatches.slice(0, limit);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const moeMatches = moeResults(db, raw, limit * 2);
    const overseasMatches = overseasResults(db, raw, limit * 2);
    const pattern = `%${escapeLike(raw)}%`;
    const rows = db.prepare(`SELECT ror_id, name, aliases, acronyms, country_code, country_name, website
      FROM organizations WHERE name LIKE ? OR aliases LIKE ? OR acronyms LIKE ? LIMIT ?`)
      .all(pattern, pattern, pattern, limit * 3);
    const knownNames = new Set([...masterMatches, ...moeMatches].flatMap(item => [item.nameZh, item.nameEn])
      .filter(Boolean).map(normalizeMasterName));
    const referenceMatches = rows.filter(row => !knownNames.has(normalizeMasterName(row.name))).map(row => ({
      id: row.ror_id,
      nameZh: row.name,
      nameEn: row.name,
      aliases: row.aliases,
      classification: null,
      scoreTier: null,
      countryRegion: row.country_name,
      website: row.website,
      source: "ROR"
    }));
    return [...masterMatches, ...moeMatches, ...overseasMatches, ...referenceMatches].slice(0, limit);
  } finally {
    db.close();
  }
}

export function resolveReferenceInstitution(name, dbPath = referenceDbPath) {
  const raw = String(name || "").trim();
  if (!raw || !existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    try {
      const row = db.prepare(`SELECT institution_code, name, authority, city, education_level, note
        FROM moe_institutions WHERE name = ? COLLATE NOCASE LIMIT 1`).get(raw);
      if (row) return moeResult(row);
    } catch (error) {
      if (error?.code !== "SQLITE_ERROR" && !/no such table/i.test(error?.message || "")) throw error;
    }
    try {
      const rows = db.prepare(`SELECT overseas_id, name, country, country_code, domains, web_pages, state_province
        FROM overseas_institutions WHERE name = ? COLLATE NOCASE OR name LIKE ? LIMIT 20`).all(raw, `%${escapeLike(raw)}%`);
      const normalized = normalizeMasterName(raw);
      const row = rows.find(item => normalizeMasterName(item.name) === normalized);
      if (row) return {
        id: row.overseas_id,
        nameZh: row.name,
        nameEn: row.name,
        classification: "海外本科身份库",
        scoreTier: null,
        countryRegion: row.country,
        countryCode: row.country_code,
        domains: JSON.parse(row.domains || "[]"),
        website: JSON.parse(row.web_pages || "[]")[0] || null,
        stateProvince: row.state_province,
        source: "HIPO"
      };
    } catch (error) {
      if (error?.code !== "SQLITE_ERROR" && !/no such table/i.test(error?.message || "")) throw error;
    }
    const pattern = `%${escapeLike(raw)}%`;
    const rows = db.prepare(`SELECT ror_id, name, aliases, country_code, country_name, website
      FROM organizations WHERE name = ? COLLATE NOCASE OR aliases LIKE ? LIMIT 20`).all(raw, pattern);
    const normalized = normalizeMasterName(raw);
    const row = rows.find(item => normalizeMasterName(item.name) === normalized
      || String(item.aliases).split("|").some(alias => normalizeMasterName(alias) === normalized));
    return row ? {
      id: row.ror_id,
      nameZh: row.name,
      nameEn: row.name,
      aliases: row.aliases,
      classification: null,
      scoreTier: null,
      countryRegion: row.country_name,
      website: row.website,
      source: "ROR"
    } : null;
  } finally {
    db.close();
  }
}
