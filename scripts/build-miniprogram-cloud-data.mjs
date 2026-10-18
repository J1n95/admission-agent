import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { institutionMaster, programmeMaster } from '../master-data.mjs';
import { majorMaster } from '../major-master.mjs';
import { programmes as seededProgrammes } from '../data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·•・,，.。()（）\-_/\\'’]/g, '');
const median = values => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(1));
};
const round = value => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(1)) : null;
const parse = (value, fallback) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };
const hashId = (prefix, value) => `${String(prefix).slice(0, 1)}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
const redact = value => String(value || '')
  .replace(/https?:\/\/\S+/gi, '[链接已移除]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已移除]')
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已移除]')
  .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号已移除]')
  .replace(/(?:微信|wechat|vx|联系方式)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/gi, '[联系方式已移除]')
  .replace(/\s+/g, ' ').trim();
const cleanList = (value, maximum = 8) => (Array.isArray(value) ? value : [])
  .map(item => redact(typeof item === 'string' ? item : item?.raw || item?.result || ''))
  .filter(Boolean).slice(0, maximum).map(item => item.slice(0, 300));
const writeJsonLines = (path, rows) => writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

const fieldPatterns = new Map([
  ['automation', /自动化|控制|PLC|运动控制|机电一体化/i], ['electronic', /电子|电路|嵌入式|芯片|FPGA|单片机|PCB/i],
  ['communication', /通信|信号|5G|射频|天线|网络/i], ['computer', /软件|计算机|开发|编程|算法|系统/i],
  ['ai', /人工智能|机器学习|深度学习|计算机视觉|自然语言|大模型/i], ['data', /数据分析|数据科学|统计|商业分析/i],
  ['robotics', /机器人|机械臂|智能车|无人机/i], ['mechanical', /机械|制造|结构设计|工业工程/i],
  ['civil', /土木|建筑|施工|结构工程|城市规划/i], ['chemical', /化工|化学工程|催化|高分子/i],
  ['materials', /材料|纳米|金属|陶瓷/i], ['biology', /生物|生命科学|细胞|基因|蛋白/i],
  ['biomedical', /生物医学|医疗器械|医学工程/i], ['healthcare', /医疗|临床|医院|公共卫生/i],
  ['environmental', /环境|环保|污染|碳排放/i], ['energy', /能源|新能源|储能|电池/i],
  ['power', /电力|电网|电气工程/i], ['finance', /金融|证券|投行|量化|银行/i],
  ['business', /管理|咨询|商业|战略|人力资源/i], ['operations', /运营|供应链|物流|产品经理/i],
  ['marketing', /市场|营销|品牌|广告/i], ['media', /传媒|新闻|内容|公关/i],
  ['law', /法律|法务|律所|司法/i], ['education', /教育|教学|课程设计/i]
]);
const inferTags = text => [...fieldPatterns].filter(([, pattern]) => pattern.test(text)).map(([field]) => field);
const inferCompanyTypes = text => [
  [/国企|央企|国有/, 'state-owned'], [/上市|证券交易所/, 'listed'], [/外企|跨国|合资/, 'foreign'],
  [/高校|大学|实验室|研究院|研究所/, 'research'], [/创业|初创|中小企业/, 'startup'],
  [/头部|世界500强|五百强|大型企业|大厂/, 'large']
].filter(([pattern]) => pattern.test(text)).map(([, value]) => value);

const referenceDb = new DatabaseSync(resolve(root, 'collector/data/reference/institutions.sqlite'), { readOnly: true });
const masterByName = new Map(institutionMaster.flatMap(item => [item.nameZh, item.nameEn, ...(item.aliases || [])]
  .filter(Boolean).map(name => [normalize(name), item])));
const domestic = referenceDb.prepare(`
  SELECT institution_code AS id, name, city
  FROM moe_institutions
  WHERE education_level = '本科'
  ORDER BY name
`).all().map(row => {
  const master = masterByName.get(normalize(row.name));
  return {
    id: `moe:${row.id}`,
    nameZh: row.name,
    nameEn: master?.nameEn || '',
    aliases: master?.aliases || [],
    classification: master?.classification || '普通本科',
    scoreTier: master?.scoreTier ?? 1,
    city: row.city || ''
  };
});
referenceDb.close();

const institutions = [...domestic, ...institutionMaster.map(item => ({
  id: item.id,
  nameZh: item.nameZh || item.nameEn,
  nameEn: item.nameEn || '',
  aliases: item.aliases || [],
  classification: item.classification || '',
  scoreTier: item.scoreTier ?? null,
  city: item.countryRegion || ''
}))].filter((item, index, rows) => rows.findIndex(candidate => normalize(candidate.nameZh) === normalize(item.nameZh)) === index);

const caseDb = new DatabaseSync(resolve(root, 'collector/data/cases.sqlite'), { readOnly: true });
const caseGroups = new Map();
const approvedRows = caseDb.prepare(`
  SELECT fingerprint, target_institution_id AS targetInstitutionId, target_programme_id AS programmeId,
         undergraduate_institution_id AS undergraduateInstitutionId, offer_year AS offerYear,
         undergraduate_university AS undergraduateUniversity, undergraduate_major AS undergraduateMajor,
         gpa_raw AS gpaRaw, gpa_scale AS gpaScale, gpa100,
         language_test AS languageTest, language_scale AS languageScale, language_score AS languageScore,
         internships_json AS internshipsJson, work_experience_json AS workExperienceJson,
         research_json AS researchJson, competitions_json AS competitionsJson, awards_json AS awardsJson,
         patents_json AS patentsJson, projects_json AS projectsJson, evidence_json AS evidenceJson,
         quality_score AS qualityScore
  FROM cases
  WHERE review_status = 'approved' AND target_programme_id IS NOT NULL
`).all();
for (const row of approvedRows) {
  if (!caseGroups.has(row.programmeId)) caseGroups.set(row.programmeId, []);
  caseGroups.get(row.programmeId).push(row);
}
const programmeEvidenceRows = caseDb.prepare(`
  SELECT id, programme_id AS programmeId, section, title, text, provenance,
         academic_years_json AS academicYearsJson, checked_at AS checkedAt
  FROM programme_documents
  WHERE programme_id IS NOT NULL AND text IS NOT NULL AND trim(text) != ''
`).all();
caseDb.close();

const programmes = programmeMaster
  .filter(item => ['香港', '新加坡'].includes(item.region))
  .map(item => {
    const institution = institutionMaster.find(value => value.id === item.institutionId) || {};
    const cases = caseGroups.get(item.id) || [];
    const gpas = cases.map(value => value.gpa100).filter(Number.isFinite);
    const ielts = cases.filter(value => /IELTS/i.test(`${value.languageTest || ''} ${value.languageScale || ''}`))
      .map(value => value.languageScore).filter(Number.isFinite);
    return {
      id: item.id,
      institutionId: item.institutionId,
      region: item.region,
      school: institution.nameEn ? institution.nameEn.replace(/[^A-Z]/g, '').slice(0, 8) : '',
      university: institution.nameZh || institution.nameEn || item.institutionId,
      name: item.nameEn || '',
      nameZh: item.nameZh || item.nameEn || '',
      majorTags: [...new Set([...(item.majorTags || []), ...(item.focusTags || [])])],
      focusTags: item.focusTags || [],
      courseTags: item.courseTags || [],
      languageMin: item.languageMin ?? null,
      officialNote: item.officialNote || '',
      overview: item.overview || '',
      caseCount: cases.length,
      caseStats: {
        gpaCount: gpas.length, min: gpas.length ? round(Math.min(...gpas)) : null,
        avg: gpas.length ? round(gpas.reduce((sum, value) => sum + value, 0) / gpas.length) : null,
        median: median(gpas), max: gpas.length ? round(Math.max(...gpas)) : null,
        ieltsCount: ielts.length, ieltsMedian: median(ielts)
      }
    };
  });

const majors = majorMaster.map(item => ({
  code: item.code, name: item.name, categoryName: item.categoryName,
  className: item.className, field: item.field, aliases: item.aliases || []
}));

const output = resolve(root, 'miniprogram/cloudfunctions/admissionApi/catalog.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ institutions, majors, programmes }));

const institutionById = new Map(institutionMaster.map(item => [item.id, item]));
const institutionByName = new Map(institutionMaster.flatMap(item => [item.nameZh, item.nameEn, ...(item.aliases || [])]
  .filter(Boolean).map(name => [normalize(name), item])));
const majorByName = new Map(majorMaster.flatMap(item => [item.name, ...(item.aliases || [])]
  .filter(Boolean).map(name => [normalize(name), item])));

const caseDocuments = approvedRows.map(row => {
  const undergraduate = institutionById.get(row.undergraduateInstitutionId)
    || institutionByName.get(normalize(row.undergraduateUniversity)) || {};
  const major = majorByName.get(normalize(row.undergraduateMajor)) || {};
  const experiences = {
    internships: cleanList(parse(row.internshipsJson, [])),
    work: cleanList(parse(row.workExperienceJson, [])),
    research: cleanList(parse(row.researchJson, [])),
    competitions: cleanList(parse(row.competitionsJson, [])),
    awards: cleanList(parse(row.awardsJson, [])),
    patents: cleanList(parse(row.patentsJson, [])),
    projects: cleanList(parse(row.projectsJson, []))
  };
  const experienceText = Object.values(experiences).flat().join('；');
  const evidence = parse(row.evidenceJson, {});
  return {
    _id: hashId('case', row.fingerprint),
    programmeId: row.programmeId,
    targetInstitutionId: row.targetInstitutionId || null,
    offerYear: Number(row.offerYear) || null,
    undergraduate: {
      institutionId: row.undergraduateInstitutionId
        ? (/^https?:/i.test(row.undergraduateInstitutionId) ? hashId('institution', row.undergraduateInstitutionId) : row.undergraduateInstitutionId)
        : null,
      university: redact(row.undergraduateUniversity).slice(0, 120),
      classification: undergraduate.classification || null,
      scoreTier: undergraduate.scoreTier ?? null,
      major: redact(row.undergraduateMajor).slice(0, 120),
      majorField: major.field || null
    },
    gpa: { raw: redact(row.gpaRaw).slice(0, 60), scale: row.gpaScale || null, value100: round(row.gpa100) },
    language: { test: row.languageTest || null, scale: row.languageScale || null, score: round(row.languageScore) },
    experiences,
    experienceTags: inferTags(experienceText),
    companyTypes: inferCompanyTypes(experienceText),
    qualityScore: Number(row.qualityScore) || 0,
    evidence: {
      matchedCount: Array.isArray(evidence.matched) ? evidence.matched.length : 0,
      missingCount: Array.isArray(evidence.missing) ? evidence.missing.length : 0,
      checkedAt: evidence.checkedAt || null
    },
    reviewStatus: 'approved'
  };
});

const seededById = new Map(seededProgrammes.map(item => [item.id, item]));
const programmeDocuments = programmeMaster.filter(item => ['香港', '新加坡'].includes(item.region)).map(item => {
  const institution = institutionById.get(item.institutionId) || {};
  const seeded = seededById.get(item.id) || {};
  return {
    _id: hashId('programme', item.id), programmeId: item.id, institutionId: item.institutionId,
    region: item.region, university: institution.nameZh || institution.nameEn || item.institutionId,
    school: institution.nameEn || institution.nameZh || '', nameZh: item.nameZh || item.nameEn || '', nameEn: item.nameEn || '',
    majorTags: [...new Set([...(item.majorTags || []), ...(item.focusTags || [])])],
    focusTags: item.focusTags || [],
    courseTags: item.courseTags || [], languageMin: seeded.languageMin ?? item.languageMin ?? null,
    requirements: redact(seeded.officialNote || item.officialNote || '').slice(0, 5000),
    positioning: redact(seeded.overview || item.overview || '').slice(0, 5000),
    duration: redact(seeded.duration || item.duration || '').slice(0, 3000),
    curriculum: redact(seeded.curriculumStructure || item.curriculumStructure || '').slice(0, 7000),
    orientation: redact(seeded.courseOrientation || item.courseOrientation || '').slice(0, 5000),
    resources: redact(seeded.resources || item.resources || '').slice(0, 5000),
    career: redact(seeded.career || item.career || '').slice(0, 5000),
    differentiators: redact(seeded.differentiators || item.differentiators || '').slice(0, 5000),
    caseCount: caseGroups.get(item.id)?.length || 0
  };
});

const evidenceDocuments = programmeEvidenceRows
  .filter(row => programmeDocuments.some(item => item.programmeId === row.programmeId))
  .map(row => ({
    _id: hashId('evidence', row.id), programmeId: row.programmeId,
    section: row.section, title: redact(row.title).slice(0, 300), text: redact(row.text).slice(0, 10000),
    provenance: row.provenance || 'official', academicYears: parse(row.academicYearsJson, []), checkedAt: row.checkedAt || null
  }));

const importRoot = resolve(root, 'miniprogram/cloud-data');
mkdirSync(importRoot, { recursive: true });
const importFiles = {
  cases: resolve(importRoot, 'cases.json'),
  programmes: resolve(importRoot, 'programmes.json'),
  programmeEvidence: resolve(importRoot, 'programme_evidence.json')
};
writeJsonLines(importFiles.cases, caseDocuments);
writeJsonLines(importFiles.programmes, programmeDocuments);
writeJsonLines(importFiles.programmeEvidence, evidenceDocuments);

console.log(JSON.stringify({
  output, institutions: institutions.length, majors: majors.length, programmes: programmes.length,
  imports: { cases: caseDocuments.length, programmes: programmeDocuments.length, programmeEvidence: evidenceDocuments.length },
  importFiles
}));
