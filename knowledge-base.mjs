import { programmeSources, programmes as seededProgrammes } from "./data.mjs";
import { institutionMaster, programmeMaster, resolveInstitution } from "./master-data.mjs";
import { listApprovedCases, listCaseEmbeddings, listProgrammeDocuments, openCaseStore } from "./collector/store.mjs";
import { caseYearWeight, referenceYearForCases } from "./case-analysis.mjs";
import { caseVectorMap, cosineSimilarity } from "./collector/vector-search.mjs";
import { approximateExperienceCount, mergeExperienceFields } from "./collector/experience-classifier.mjs";

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

const programmes = programmeMaster.filter(programme => programme.active !== false).map(programme => {
  const seeded = seededProgrammes.find(candidate => candidate.id === programme.id);
  if (seeded) return { ...programme, ...seeded, focusTags: programme.focusTags || [] };
  const institution = institutionMaster.find(candidate => candidate.id === programme.institutionId);
  return {
    ...programme,
    school: institution?.nameEn || institution?.nameZh || programme.institutionId,
    university: institution?.nameZh || institution?.nameEn || programme.institutionId,
    name: programme.nameEn,
    officialNote: null,
    overview: null,
    duration: null,
    curriculumStructure: null,
    courseOrientation: null,
    resources: null,
    career: null,
    differentiators: null
  };
});

function sourcesFor(programmeId, section) {
  const sources = programmeSources.filter(source => source.programmeId === programmeId);
  if (section === "requirements") {
    return sources.filter(source => source.kind.includes("admission") || source.kind.includes("catalog") || source.kind.includes("programme"));
  }
  return sources.filter(source => source.kind.includes("curriculum") || source.kind.includes("catalog") || source.kind.includes("programme"));
}

const storedProgrammeFields = {
  requirements: "officialNote",
  positioning: "overview",
  duration: "duration",
  curriculum: "curriculumStructure",
  orientation: "courseOrientation",
  resources: "resources",
  career: "career",
  comparison: "differentiators"
};

function enrichProgramme(programme, storedDocuments = []) {
  const enriched = { ...programme, _programmeProvenance: { ...(programme._programmeProvenance || {}) } };
  for (const document of storedDocuments) {
    const field = storedProgrammeFields[document.section];
    const text = String(document.text || "").trim();
    if (field && text) {
      enriched[field] = text;
      enriched._programmeProvenance[field] = document.provenance || "official";
    }
  }
  return enriched;
}

export function buildKnowledgeDocuments(programme, storedDocuments = null) {
  if (storedDocuments) return storedDocuments.filter(document => document.programmeId === programme.id);
  return sections.flatMap(([section, title, field, provenance]) => {
    if (!programme[field]) return [];
    const sources = sourcesFor(programme.id, section);
    return [{
      id: `${programme.id}:${section}`,
      programmeId: programme.id,
      section,
      title,
      text: programme[field],
      provenance,
      academicYears: [...new Set(sources.map(source => source.academicYear))],
      checkedAt: sources.map(source => source.checkedAt).sort().at(-1) || null,
      sources: sources.map(source => ({ id: source.id, kind: source.kind, url: source.url }))
    }];
  });
}

function joinOrUndisclosed(values) {
  if (Array.isArray(values)) {
    const items = values.map(value => String(value || "").trim()).filter(Boolean);
    return items.length ? items.join("；") : "公开页面未披露";
  }
  const text = String(values || "").replace(/\s+/g, " ").trim();
  return text || "公开页面未披露";
}

function disclosureItems(values) {
  if (Array.isArray(values)) return values.flatMap(value => disclosureItems(value));
  const text = String(values || "").replace(/\s+/g, " ").trim();
  if (!text || text === "公开页面未披露") return [];
  return text.split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
}

function disclosureLevel(items) {
  const text = items.join(" ").toLowerCase();
  if (/(国家级|全国|一等奖|金奖|论文|专利|核心|第一作者|主导|发表|头部|华为|腾讯|阿里|字节|美团)/.test(text)) return "较强";
  if (items.length >= 2 || /(省级|二等奖|实习|项目|科研|实验室|研究)/.test(text)) return "中等";
  return "基础";
}

function disclosureSummary(...values) {
  const items = values.flatMap(value => disclosureItems(value));
  const count = items.reduce((total, item) => total + approximateExperienceCount(item), 0);
  return items.length ? { count, level: disclosureLevel(items) } : { count: 0, level: "页面未提及" };
}

function majorTag(major) {
  const text = String(major || "").toLowerCase();
  if (/自动化|控制|automation|control/.test(text)) return "automation";
  if (/通信|communication|telecom/.test(text)) return "communication";
  if (/电气|electrical/.test(text)) return "electrical";
  if (/电子|集成电路|微电子|electronic|circuit/.test(text)) return "electronic";
  if (/计算机|软件|computer|software/.test(text)) return "computer";
  return "other";
}

function toAnalysisCase(item, referenceYear) {
  const offerYear = Number(item.offerYear);
  const yearWeight = caseYearWeight(offerYear, referenceYear);
  const institution = institutionMaster.find(candidate => candidate.id === item.undergraduateInstitutionId)
    || resolveInstitution(item.undergraduateUniversity);
  const experienceFields = mergeExperienceFields(item);
  return {
    fingerprint: item.fingerprint,
    cycle: item.offerYear,
    offerYear,
    yearWeight,
    yearAge: Number.isFinite(offerYear) ? Math.max(0, referenceYear - offerYear) : null,
    school: item.undergraduateUniversity,
    schoolTier: institution?.scoreTier ?? null,
    schoolClassification: institution?.classification ?? null,
    major: item.undergraduateMajor,
    majorTag: majorTag(item.undergraduateMajor),
    gpaRaw: item.gpaRaw,
    gpaScale: item.gpaScale,
    gpa100: item.gpa100,
    language: item.languageScore,
    languageTest: item.languageTest,
    languageScale: item.languageScale,
    internships: joinOrUndisclosed(experienceFields.internships),
    workExperience: joinOrUndisclosed(experienceFields.workExperience),
    research: joinOrUndisclosed(experienceFields.research),
    competitions: joinOrUndisclosed(experienceFields.competitions),
    awards: joinOrUndisclosed(experienceFields.awards),
    projects: joinOrUndisclosed(experienceFields.projects),
    patents: joinOrUndisclosed(experienceFields.patents),
    experienceSummary: {
      internships: disclosureSummary(experienceFields.internships, experienceFields.workExperience),
      research: disclosureSummary(experienceFields.research),
      projects: disclosureSummary(experienceFields.projects),
      competitions: disclosureSummary(experienceFields.competitions, experienceFields.awards),
      patents: disclosureSummary(experienceFields.patents)
    },
    source: new URL(item.sourceUrl).hostname,
    sourceUrl: item.sourceUrl,
    sourceUrls: item.sourceUrls?.length ? item.sourceUrls : [item.sourceUrl],
    sourceRefs: item.sourceRefs || [],
    reviewStatus: item.reviewStatus
  };
}

export function buildCaseDocuments(programme, approvedCases = [], referenceYear = null) {
  return approvedCases.map((item, index) => ({
    id: `${programme.id}:case:${item.fingerprint}`,
    programmeId: programme.id,
    section: "admission-case",
    title: `${item.offerYear}录取案例 · ${item.undergraduateUniversity}`,
    text: `本科${item.undergraduateUniversity}，${item.undergraduateMajor || "专业未披露"}，GPA ${item.gpaRaw || "未披露"}，${item.languageTest || "语言"} ${item.languageScore ?? "未披露"}。实习：${joinOrUndisclosed(item.internships)}；工作：${joinOrUndisclosed(item.workExperience)}；科研：${joinOrUndisclosed(item.research)}；竞赛：${joinOrUndisclosed(item.competitions)}；奖项：${joinOrUndisclosed(item.awards)}；专利：${joinOrUndisclosed(item.patents)}；项目：${joinOrUndisclosed(item.projects)}。`,
    provenance: "public-case",
    academicYears: [String(item.offerYear)],
    checkedAt: null,
    sources: (item.sourceRefs?.length ? item.sourceRefs : (item.sourceUrls?.length ? item.sourceUrls : [item.sourceUrl]).map(url => ({ url, comparison: {} })))
      .map((ref, sourceIndex) => ({
        id: `${programme.id}-case-${index + 1}-${sourceIndex + 1}`,
        kind: "public-case",
        url: ref.url,
        comparison: ref.comparison || {}
      })),
    metadata: {
      fingerprint: item.fingerprint,
      offerYear: Number(item.offerYear),
      yearWeight: caseYearWeight(item.offerYear, referenceYear),
      yearAge: Number.isFinite(Number(item.offerYear)) && Number.isFinite(Number(referenceYear))
        ? Math.max(0, Number(referenceYear) - Number(item.offerYear))
        : null,
      undergraduateInstitutionId: item.undergraduateInstitutionId,
      gpaRaw: item.gpaRaw,
      gpaScale: item.gpaScale,
      gpa100: item.gpa100,
      languageTest: item.languageTest,
      languageScale: item.languageScale,
      languageScore: item.languageScore,
      sourceRefs: item.sourceRefs || [],
      reviewStatus: item.reviewStatus
    }
  }));
}

export const programmeFieldAliases = {
    electronic: ["electronic", "integrated-circuit", "semiconductor", "embedded"],
    communication: ["communication", "communications", "network", "signal"],
    computer: ["computer", "software", "data", "ai"],
    automation: ["automation", "control", "robotics"],
    control: ["control", "automation", "robotics"],
    electrical: ["electrical", "power", "energy"],
    ai: ["ai", "artificial-intelligence", "data", "computer", "software"],
    data: ["data", "analytics", "ai", "computer"],
    software: ["software", "computer", "information-technology"],
    cloud: ["cloud", "computer", "software", "network"],
    robotics: ["robotics", "automation", "control", "mechanical"],
    mechanical: ["mechanical", "manufacturing", "robotics"],
    civil: ["civil", "construction", "built-environment"],
    chemical: ["chemical", "materials"],
    materials: ["materials", "chemical", "nanotechnology"],
    mathematics: ["mathematics", "statistics", "quantitative"],
    statistics: ["statistics", "data", "mathematics", "quantitative"],
    physics: ["physics", "quantum"],
    biology: ["biology", "life-science", "bioscience", "biotechnology"],
    biotechnology: ["biotechnology", "biology", "life-science"],
    biomedical: ["biomedical", "healthcare", "medical"],
    healthcare: ["healthcare", "biomedical", "medical"],
    medicine: ["medicine", "healthcare", "biomedical"],
    pharmacy: ["pharmacy", "healthcare", "medicine"],
    "public-health": ["public-health", "healthcare", "medicine"],
    "food-nutrition": ["food-nutrition", "life-science", "biology"],
    psychology: ["psychology", "behavioural", "social-science"],
    environmental: ["environmental", "energy", "sustainability"],
    energy: ["energy", "environmental", "power", "electrical"],
    power: ["power", "energy", "electrical"],
    network: ["network", "communication", "computer"],
    signal: ["signal", "communication", "electronic"],
    iot: ["iot", "network", "communication", "embedded"],
    "integrated-circuit": ["integrated-circuit", "semiconductor", "electronic"],
    semiconductor: ["semiconductor", "integrated-circuit", "electronic"],
    manufacturing: ["manufacturing", "mechanical", "automation"],
    instrumentation: ["instrumentation", "electronic", "control"],
    optoelectronics: ["optoelectronics", "electronic", "physics"],
    railway: ["railway", "transportation", "civil", "mechanical"],
    business: ["business", "management", "commerce"],
    finance: ["finance", "accounting"],
    accounting: ["accounting", "finance", "business"],
    economics: ["economics", "finance", "business"],
    operations: ["operations", "management", "business", "supply-chain"],
    marketing: ["marketing"],
    law: ["law", "legal"],
    education: ["education", "learning"],
    media: ["media"],
    design: ["design"],
    architecture: ["architecture", "built-environment"],
    "public-policy": ["public-policy", "social-science", "governance"],
    "social-science": ["social-science", "public-policy", "psychology"],
    humanities: ["humanities", "language", "media"],
    "life-science": ["life-science", "biomedical", "healthcare"],
    other: []
};

function relevance(programme, query) {
  const regionMatch = !query.regions?.length || query.regions.includes(programme.region);
  const targetSchools = Array.isArray(query.targetSchools) ? query.targetSchools : [];
  const schoolMatch = !targetSchools.length || targetSchools.includes(programme.university) || targetSchools.includes(programme.school);
  const programmeFields = new Set(programme.focusTags || []);
  const fieldMatches = (query.fields || []).filter(field => field === "other"
    ? programmeFields.size === 0
    : (programmeFieldAliases[field] || [field]).some(alias => programmeFields.has(alias))
  );
  const courseMatches = (query.profile?.courseTags || []).filter(tag => programme.courseTags.includes(tag));
  const profileMajor = String(query.profile?.major || "").toLowerCase();
  const majorAliases = programmeFieldAliases[profileMajor] || [profileMajor];
  const exactMajorMatch = programme.majorTags.includes(profileMajor);
  const majorMatch = exactMajorMatch || majorAliases.some(alias => programme.majorTags.includes(alias));
  const programmeName = `${programme.nameEn || ""} ${programme.nameZh || ""}`.toLowerCase();
  const nameCourseMatches = (query.profile?.courseTags || [])
    .map(tag => String(tag).toLowerCase())
    .filter(tag => tag.length >= 4 && programmeName.includes(tag.replaceAll("-", " ")));
  const applicantGroups = new Set((query.profile?.applicantGroups || []).map(value => String(value).toLowerCase()));
  const workExperienceYears = Number(query.profile?.workExperienceYears || 0);
  const hasProfessionalExperience = workExperienceYears >= 2
    || applicantGroups.has("experienced")
    || (Array.isArray(query.profile?.workExperience) && query.profile.workExperience.length > 0);
  const audienceEligible = !/adb\W*japan scholarship/i.test(programmeName) || applicantGroups.has("adb-jsp");
  const residencyEligible = !/for hk applicants/i.test(programmeName) || applicantGroups.has("hong-kong");
  const experienceEligible = !/(^|\s)(executive master|emba|mba)(\s|$)/i.test(programmeName) || hasProfessionalExperience;
  return {
    eligible: regionMatch && schoolMatch && audienceEligible && residencyEligible && experienceEligible
      && (!query.fields?.length || fieldMatches.length > 0),
    score: (regionMatch ? 10 : 0) + (schoolMatch ? 4 : 0)
      + fieldMatches.reduce((score, field) => score + ([10, 3, 1][Math.min((query.fields || []).indexOf(field), 2)] || 1), 0)
      + (exactMajorMatch ? 8 : majorMatch ? 4 : 0) + courseMatches.length + nameCourseMatches.length * 4,
    matchedFields: fieldMatches,
    matchedCourseTags: courseMatches,
    majorMatch,
    exactMajorMatch,
    nameCourseMatches,
    audienceEligible,
    residencyEligible,
    experienceEligible
  };
}

function loadProgrammeDocuments(options = {}) {
  if (options.db) return listProgrammeDocuments(options.db, options.programmeIds || []);
  const db = openCaseStore(options.dbPath);
  try {
    return listProgrammeDocuments(db, options.programmeIds || []);
  } finally {
    db.close();
  }
}
function loadApprovedCases(options = {}) {
  if (Array.isArray(options.approvedCases)) return options.approvedCases;
  if (options.db) return listApprovedCases(options.db, options.programmeIds || []);
  const db = openCaseStore(options.dbPath);
  try {
    return listApprovedCases(db);
  } finally {
    db.close();
  }
}

function loadCaseEmbeddings(options = {}, fingerprints = []) {
  if (Array.isArray(options.caseEmbeddings)) return options.caseEmbeddings;
  if (options.db) return listCaseEmbeddings(options.db, fingerprints);
  const db = openCaseStore(options.dbPath);
  try {
    return listCaseEmbeddings(db, fingerprints);
  } finally {
    db.close();
  }
}

export function retrieveProgrammeKnowledge(query = {}, options = {}) {
  const includeCases = options.includeCases !== false;
  const programmeIds = new Set((options.programmeIds || []).filter(Boolean));
  const restrictToProgrammeIds = options.restrictToProgrammeIds === true || programmeIds.size > 0;
  const approvedCases = includeCases ? loadApprovedCases(options) : [];
  const queryEmbedding = Array.isArray(options.queryEmbedding) && options.queryEmbedding.length ? options.queryEmbedding : null;
  const embeddings = queryEmbedding
    ? caseVectorMap(loadCaseEmbeddings(options, approvedCases.map(item => item.fingerprint)))
    : new Map();
  const officialDocuments = options.includeOfficialDocuments === false ? [] : loadProgrammeDocuments(options);
  const documentsByProgramme = new Map(programmes.map(programme => [programme.id, officialDocuments.filter(document => document.programmeId === programme.id)]));
  const referenceYear = referenceYearForCases(approvedCases, query.profile?.applicationYear);
  return programmes
    .filter(programme => !restrictToProgrammeIds || programmeIds.has(programme.id))
    .map(programme => {
      const storedDocuments = documentsByProgramme.get(programme.id) || [];
      const enrichedProgramme = enrichProgramme(programme, storedDocuments);
      const programmeCases = includeCases ? approvedCases.filter(item => item.targetProgrammeId === programme.id) : [];
      const caseDocuments = buildCaseDocuments(enrichedProgramme, programmeCases, referenceYear);
      const scoredCaseDocuments = caseDocuments.map(document => {
        const embedding = embeddings.get(document.metadata?.fingerprint);
        const vectorScore = embedding ? cosineSimilarity(queryEmbedding, embedding.vector) : null;
        return vectorScore == null
          ? document
          : { ...document, metadata: { ...document.metadata, vectorScore, vectorModel: embedding.model } };
      });
      return {
        programme: { ...enrichedProgramme, cases: programmeCases.map(item => toAnalysisCase(item, referenceYear)) },
        retrieval: { ...relevance(enrichedProgramme, query), vectorSearch: Boolean(queryEmbedding), indexedCaseCount: scoredCaseDocuments.filter(document => Number.isFinite(document.metadata?.vectorScore)).length },
        documents: [
          ...buildKnowledgeDocuments(enrichedProgramme, storedDocuments),
          ...(includeCases ? scoredCaseDocuments : [])
        ]
      };
    })
    .filter(entry => options.includeIneligible === true || entry.retrieval.eligible)
    .sort((a, b) => b.retrieval.score - a.retrieval.score || a.programme.id.localeCompare(b.programme.id));
}

export function knowledgeStatus(options = {}) {
  const approvedCases = loadApprovedCases(options);
  const officialDocuments = loadProgrammeDocuments(options);
  const programmeDocuments = officialDocuments;
  const structuredSections = new Set(Object.keys(storedProgrammeFields));
  const structuredProgrammeIds = new Set(officialDocuments
    .filter(document => structuredSections.has(document.section) && document.text)
    .map(document => document.programmeId));
  const rawProgrammeIds = new Set(officialDocuments
    .filter(document => document.section === "official-page" && document.text)
    .map(document => document.programmeId));
  const caseDocuments = programmes.flatMap(programme => buildCaseDocuments(programme, approvedCases.filter(item => item.targetProgrammeId === programme.id)));
  const officialSources = officialDocuments.flatMap(document => document.sources || []);
  return {
    programmes: programmes.length,
    documents: programmeDocuments.length + caseDocuments.length,
    programmeDocuments: programmeDocuments.length,
    rawProgrammeCount: rawProgrammeIds.size,
    structuredProgrammeCount: structuredProgrammeIds.size,
    caseDocuments: caseDocuments.length,
    approvedCases: approvedCases.length,
    officialSources: new Set(officialSources.map(source => source.id || source.url)).size,
    checkedAt: officialDocuments.map(document => document.checkedAt).filter(Boolean).sort().at(-1) || null,
    academicYears: [...new Set(officialDocuments.flatMap(document => document.academicYears || []))],
    vectorEmbeddings: loadCaseEmbeddings(options).length,
    vectorSearchConfigured: Boolean(options.vectorSearchConfigured)
  };
}
