import { analyzeAll } from "./case-analysis.mjs";
import { programmeFieldAliases, retrieveProgrammeKnowledge } from "./knowledge-base.mjs";
import { hybridEvidenceScore } from "./collector/vector-search.mjs";

export function selectAssessmentEvidence(entry, result) {
  const documents = entry?.documents || [];
  const officialDocuments = documents.filter(document => document.provenance !== "public-case");
  const preferredSections = new Set(["requirements", "curriculum", "orientation", "catalogue-card"]);
  const structuredOfficial = officialDocuments.filter(document => preferredSections.has(document.section));
  const official = structuredOfficial.length ? structuredOfficial : officialDocuments.slice(0, 1);
  const nearestFingerprint = result?.nearest?.fingerprint || "";
  const cases = documents.filter(document => document.provenance === "public-case")
    .sort((a, b) => {
      const aPriority = a.metadata?.fingerprint === nearestFingerprint ? 0 : 1;
      const bPriority = b.metadata?.fingerprint === nearestFingerprint ? 0 : 1;
      const aWeight = Number.isFinite(Number(a.metadata?.yearWeight)) ? Number(a.metadata.yearWeight) : 0;
      const bWeight = Number.isFinite(Number(b.metadata?.yearWeight)) ? Number(b.metadata.yearWeight) : 0;
      const aHybrid = hybridEvidenceScore(a.metadata?.vectorScore, aWeight);
      const bHybrid = hybridEvidenceScore(b.metadata?.vectorScore, bWeight);
      const aYear = Number(a.metadata?.offerYear) || 0;
      const bYear = Number(b.metadata?.offerYear) || 0;
      const vectorPresence = Number(bHybrid != null) - Number(aHybrid != null);
      return aPriority - bPriority || vectorPresence || (bHybrid ?? 0) - (aHybrid ?? 0) || bWeight - aWeight || bYear - aYear || String(a.id).localeCompare(String(b.id));
    });
  return [...official, ...cases];
}

function clipScreeningText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text || null;
}

export function screeningFieldMatches(entry, field) {
  const aliases = new Set(programmeFieldAliases[field] || [field]);
  return (entry?.programme?.focusTags || []).some(tag => aliases.has(tag));
}

export function buildProgrammeScreeningContext(input = {}, options = {}) {
  const ranked = retrieveProgrammeKnowledge({
    regions: input.regions || [],
    targetSchools: input.targetSchools || [],
    fields: input.fields || [],
    profile: input.profile
  }, { ...options, includeCases: false });
  const maximum = Math.max(8, Number(options.maximumCandidates || 16));
  const anchors = [];
  const addAnchors = entries => {
    for (const entry of entries) {
      if (!anchors.some(item => item.programme.id === entry.programme.id)) anchors.push(entry);
    }
  };
  const requestedFields = input.fields?.length ? input.fields : options.requestedFields || [];
  const fields = [...new Set(requestedFields.map(String).map(value => value.toLowerCase()).filter(Boolean))];
  for (const field of fields) {
    addAnchors(ranked
      .filter(entry => screeningFieldMatches(entry, field))
      .sort((a, b) => Number(b.programme.majorTags?.includes(input.profile?.major)) - Number(a.programme.majorTags?.includes(input.profile?.major))
        || b.retrieval.score - a.retrieval.score
        || a.programme.id.localeCompare(b.programme.id))
      .slice(0, 1));
  }
  const exactMajorCandidates = input.profile?.major
    ? ranked.filter(entry => entry.retrieval.exactMajorMatch)
    : [];
  const schoolCoveragePool = new Set(exactMajorCandidates.map(entry => entry.programme.institutionId).filter(Boolean)).size >= 2
    ? exactMajorCandidates
    : ranked;
  const institutions = [...new Set(schoolCoveragePool.map(entry => entry.programme.institutionId).filter(Boolean))];
  for (const institutionId of institutions) {
    addAnchors(schoolCoveragePool.filter(entry => entry.programme.institutionId === institutionId).slice(0, 1));
  }
  if (input.profile?.major) {
    addAnchors(ranked
      .filter(entry => entry.programme.majorTags?.includes(input.profile.major))
      .slice(0, 2));
  }
  const retrieved = [...anchors, ...ranked].filter((entry, index, entries) =>
    entries.findIndex(candidate => candidate.programme.id === entry.programme.id) === index
  ).slice(0, maximum);
  const retrievalById = Object.fromEntries(retrieved.map(entry => [entry.programme.id, entry]));
  return { retrieved, retrievalById };
}

export function validateScreeningRecall(entries = [], { fields = [], profileMajor = null } = {}) {
  const missingFields = [...new Set(fields.map(String).map(value => value.toLowerCase()).filter(Boolean))]
    .filter(field => !entries.some(entry => screeningFieldMatches(entry, field)));
  const missingMajor = profileMajor
    ? !entries.some(entry => entry.programme.majorTags?.includes(String(profileMajor).toLowerCase()))
    : false;
  return { pass: missingFields.length === 0 && !missingMajor, missingFields, missingMajor };
}

function programmeIdentity(entry) {
  const programme = entry.programme;
  return {
    id: programme.id,
    name: `${programme.university} ${programme.nameZh}`,
    nameEn: programme.nameEn,
    officialCode: programme.officialCode,
    officialUrl: programme.officialUrl
  };
}

export function buildProgrammeScreeningProjects(entries = [], { fullEvidence = false, programmeIds = [] } = {}) {
  const allowed = new Set(programmeIds.filter(Boolean));
  return entries
    .filter(entry => !allowed.size || allowed.has(entry.programme.id))
    .map(entry => {
      const programme = entry.programme;
      const project = programmeIdentity(entry);
      if (fullEvidence) {
        return {
          ...project,
          officialRequirements: programme.officialNote,
          positioning: programme.overview,
          curriculum: programme.courseOrientation,
          officialEvidence: entry.documents
        };
      }
      return {
        ...project,
        officialCard: {
          documentId: `${programme.id}:card`,
          region: programme.region,
          focusTags: programme.focusTags || [],
          majorTags: programme.majorTags || [],
          courseTags: programme.courseTags || [],
          languageMin: programme.languageMin ?? null,
          languageRequirement: programme.languageMin == null ? null : { test: "IELTS", minimum: programme.languageMin },
          requirements: clipScreeningText(programme.officialNote, 900),
          positioning: clipScreeningText(programme.overview, 700),
          duration: programme.duration || null,
          orientation: clipScreeningText(programme.courseOrientation, 900)
        }
      };
    });
}

export function mergeProgrammeScreening(cardResult = {}, fullResult = {}, availableEntries = []) {
  const cardDecisions = cardResult?.programmeDecisions || cardResult?.decisions || {};
  const uncertainIds = new Set(Object.entries(cardDecisions)
    .filter(([, value]) => String(value?.decision || value || "").toLowerCase() === "uncertain")
    .map(([id]) => id));
  const fullDecisions = fullResult?.programmeDecisions || fullResult?.decisions || {};
  const decisions = { ...cardDecisions };
  for (const id of uncertainIds) {
    if (fullDecisions[id]) decisions[id] = fullDecisions[id];
  }
  return normalizeProgrammeScreening({
    selectedProgrammeIds: [
      ...(Array.isArray(cardResult?.selectedProgrammeIds) ? cardResult.selectedProgrammeIds : []),
      ...(Array.isArray(fullResult?.selectedProgrammeIds) ? fullResult.selectedProgrammeIds : [])
    ],
    programmeDecisions: decisions,
    configured: Boolean(cardResult?.configured || fullResult?.configured)
  }, availableEntries);
}

export function normalizeProgrammeScreening(value, availableEntries = []) {
  const availableIds = availableEntries.map(entry => entry.programme.id);
  const availableSet = new Set(availableIds);
  const decisions = value?.programmeDecisions || value?.decisions || {};
  const explicitIds = Array.isArray(value?.selectedProgrammeIds)
    ? value.selectedProgrammeIds.map(String).filter(id => availableSet.has(id))
    : [];
  const decisionEntries = availableIds
    .map(id => [id, String(decisions[id]?.decision || decisions[id] || "").toLowerCase()])
    .filter(([, decision]) => ["include", "uncertain", "exclude"].includes(decision));
  const configured = Boolean(value?.configured);
  const hasUsableSelection = explicitIds.length > 0 || decisionEntries.length > 0;
  const excludedIds = new Set(decisionEntries
    .filter(([, decision]) => decision === "exclude")
    .map(([id]) => id));
  const selectedProgrammeIds = hasUsableSelection
    ? [...new Set(explicitIds.filter(id => !excludedIds.has(id)))]
    : configured ? [] : availableIds;
  return {
    selectedProgrammeIds,
    decisions,
    configured,
    applied: hasUsableSelection || configured
  };
}

export function limitProgrammeScreening(screening, availableEntries = [], maximum = 8) {
  if (!screening?.applied) return { ...screening, selectedProgrammeIds: [] };
  const eligible = new Set(availableEntries.filter(entry => entry.retrieval.eligible).map(entry => entry.programme.id));
  const selectedProgrammeIds = [...new Set(screening.selectedProgrammeIds || [])]
    .filter(id => eligible.has(id)
      && String(screening.decisions?.[id]?.decision || '').toLowerCase() !== 'exclude'
      && !['adjacent', 'weak'].includes(String(screening.decisions?.[id]?.directionFit || '').toLowerCase()))
    .slice(0, maximum);
  return {
    ...screening,
    selectedProgrammeIds
  };
}

export function ensureProgrammeScreeningRecall(screening, availableEntries = [], { profileMajor = null, requestedFields = [], maximum = 8 } = {}) {
  if (screening?.configured) {
    return { ...screening, recallProtected: false };
  }
  const decisions = { ...(screening?.decisions || {}) };
  const selected = new Set(screening?.selectedProgrammeIds || []);
  const major = String(profileMajor || "").toLowerCase();
  const fields = [...new Set(requestedFields.map(String).map(value => value.toLowerCase()).filter(Boolean))];
  const candidates = availableEntries
    .filter(entry => entry.retrieval.eligible)
    .sort((a, b) => Number(b.programme.majorTags?.includes(major)) - Number(a.programme.majorTags?.includes(major))
      || b.retrieval.score - a.retrieval.score || a.programme.id.localeCompare(b.programme.id));
  const matchesField = (entry, field) => {
    const tags = entry?.programme.focusTags || [];
    if (field === "integrated-circuit") return tags.includes("integrated-circuit") || tags.includes("semiconductor");
    const aliases = new Set(programmeFieldAliases[field] || [field]);
    return tags.some(tag => aliases.has(tag));
  };
  const representedBy = field => [...selected].filter(id => {
    const entry = availableEntries.find(item => item.programme.id === id);
    return matchesField(entry, field);
  });
  for (const field of fields) {
    if (representedBy(field).length) continue;
    const anchor = candidates
      .filter(entry => matchesField(entry, field) && !selected.has(entry.programme.id))
      .sort((a, b) => Number(b.programme.focusTags?.includes(field)) - Number(a.programme.focusTags?.includes(field))
        || b.retrieval.score - a.retrieval.score
        || a.programme.id.localeCompare(b.programme.id))[0];
    if (!anchor) continue;
    if (selected.size >= maximum) {
      const replaceable = [...selected]
        .map(id => availableEntries.find(entry => entry.programme.id === id))
        .filter(Boolean)
        .filter(entry => fields.every(otherField => representedBy(otherField).length !== 1 || !representedBy(otherField).includes(entry.programme.id)))
        .sort((a, b) => a.retrieval.score - b.retrieval.score || b.programme.id.localeCompare(a.programme.id))[0];
      if (!replaceable) continue;
      selected.delete(replaceable.programme.id);
    }
    selected.add(anchor.programme.id);
    decisions[anchor.programme.id] = {
      decision: "include",
      directionFit: "direct",
      reason: `本地召回保护：申请人明确选择的${field}方向存在项目候选`
    };
  }
  return { ...screening, decisions, selectedProgrammeIds: [...selected].slice(0, maximum), recallProtected: true };
}

export function buildAnalysisContext(input = {}, options = {}) {
  const retrieved = retrieveProgrammeKnowledge({
    regions: input.regions || [],
    targetSchools: input.targetSchools || [],
    fields: input.fields || [],
    profile: input.profile
  }, options);
  const comparisons = analyzeAll(input.profile, retrieved.map(entry => entry.programme));
  const retrievalById = Object.fromEntries(retrieved.map(entry => [entry.programme.id, entry]));
  return { retrieved, comparisons, retrievalById };
}
