const categoryPatterns = [
  ["patent", /(?:专利|软著|软件著作权|发明授权|实用新型)/i],
  ["competition", /(?:竞赛|比赛|挑战杯|建模|大赛|赛区|获奖)/i],
  ["award", /(?:奖学金|荣誉|奖项|一等奖|二等奖|三等奖|金奖|银奖|铜奖)/i],
  ["internship", /(?:实习|实训|见习|暑期项目|summer intern)/i],
  ["work", /(?:工作经历|全职|任职|工作于|工程师|分析员|研究助理|助理研究员)/i],
  ["project", /(?:大创|创新训练|项目经历|课程项目|毕业设计|课程设计|创业项目|项目)/i],
  ["research", /(?:科研|研究经历|课题|实验室|论文|发表|研究)/i]
];

const categoryFields = {
  internship: "internships",
  work: "workExperience",
  research: "research",
  paper: "research",
  competition: "competitions",
  award: "awards",
  scholarship: "awards",
  patent: "patents",
  project: "projects",
  course_design: "projects"
};

const chineseNumbers = new Map([
  ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5],
  ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10]
]);

const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const unique = values => [...new Set(values.map(clean).filter(Boolean))];

export function inferExperienceCategory(value) {
  const text = clean(value);
  return categoryPatterns.find(([, pattern]) => pattern.test(text))?.[0] || "unknown";
}

export function splitExperienceText(value) {
  const text = clean(value);
  if (!text) return [];
  const parts = text
    .replace(/(?:^|\s)(?:\d{1,2}|[一二三四五六七八九十])[.、)）]\s*/g, "\n")
    .split(/\n+|[；;]+/)
    .map(clean)
    .filter(Boolean);
  return parts.length ? parts : [text];
}

export function approximateExperienceCount(value) {
  const text = clean(value);
  const exact = text.match(/(?:约|共|有)?\s*(\d{1,2}|[一二两三四五六七八九十])\s*(?:段|项|个|篇|次|份)/);
  if (exact) {
    const count = Number(exact[1]);
    return Number.isFinite(count) ? count : (chineseNumbers.get(exact[1]) || 1);
  }
  if (/(?:多段|多项|多个|多篇|若干)/.test(text)) return 2;
  return text ? 1 : 0;
}

export function classifyExperienceRecords(records = []) {
  const normalized = [];
  for (const record of Array.isArray(records) ? records : []) {
    const raw = clean(typeof record === "string" ? record : record?.raw);
    if (!raw) continue;
    const supplied = clean(typeof record === "object" ? record?.category : "").toLowerCase();
    const fragments = supplied && supplied !== "unknown" ? [raw] : splitExperienceText(raw);
    for (const fragment of fragments) {
      normalized.push({
        raw: fragment,
        category: supplied && supplied !== "unknown" ? supplied : inferExperienceCategory(fragment),
        result: clean(typeof record === "object" ? record?.result : "") || null
      });
    }
  }
  return normalized.filter((item, index, rows) => rows.findIndex(candidate => candidate.raw === item.raw && candidate.category === item.category) === index);
}

export function experienceFieldsFromRecords(records = []) {
  const fields = Object.fromEntries(Object.values(categoryFields).map(field => [field, []]));
  for (const item of classifyExperienceRecords(records)) {
    const field = categoryFields[item.category];
    if (field) fields[field].push(item.raw);
  }
  for (const field of Object.keys(fields)) fields[field] = unique(fields[field]);
  return fields;
}

export function mergeExperienceFields(candidate = {}) {
  const inferred = experienceFieldsFromRecords(candidate.experiences);
  return Object.fromEntries(Object.keys(inferred).map(field => [field, unique([
    ...(Array.isArray(candidate[field]) ? candidate[field] : []),
    ...inferred[field]
  ])]));
}
