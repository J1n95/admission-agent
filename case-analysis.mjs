const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 1000) / 1000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
const summarize = values => values.length ? ({ min: Math.min(...values), max: Math.max(...values), mean: mean(values), median: median(values) }) : null;

export function referenceYearForCases(cases = [], requestedYear = null) {
  const explicit = Number(requestedYear);
  if (requestedYear != null && Number.isFinite(explicit)) return explicit;
  const years = cases.map(item => Number(item.offerYear ?? item.cycle)).filter(Number.isFinite);
  return years.length ? Math.max(...years) : new Date().getFullYear();
}

export function caseYearWeight(year, referenceYear) {
  const numericYear = Number(year);
  const numericReferenceYear = Number(referenceYear);
  if (!Number.isFinite(numericYear) || !Number.isFinite(numericReferenceYear)) return 1;
  // Keep recency directional without letting a small recent sample erase older evidence.
  return round(1 / (1 + 0.2 * Math.max(0, numericReferenceYear - numericYear)));
}

function weightedSummary(entries) {
  if (!entries.length) return null;
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedMean = entries.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
  let accumulated = 0;
  const weightedMedian = [...entries].sort((a, b) => a.value - b.value)
    .find(entry => (accumulated += entry.weight) >= totalWeight / 2)?.value ?? null;
  return { weightedMean: round(weightedMean), weightedMedian, totalWeight: round(totalWeight) };
}

const rounded = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;

const elite985 = new Set("北京大学 清华大学 中国人民大学 北京航空航天大学 北京理工大学 中国农业大学 北京师范大学 中央民族大学 南开大学 天津大学 大连理工大学 东北大学 吉林大学 哈尔滨工业大学 复旦大学 同济大学 上海交通大学 华东师范大学 南京大学 东南大学 浙江大学 中国科学技术大学 厦门大学 山东大学 中国海洋大学 武汉大学 华中科技大学 湖南大学 中南大学 中山大学 华南理工大学 四川大学 重庆大学 电子科技大学 西安交通大学 西北工业大学 西北农林科技大学 兰州大学 国防科技大学".split(" "));
const elite211 = new Set("北京交通大学 北京工业大学 北京科技大学 北京化工大学 北京邮电大学 北京林业大学 北京中医药大学 北京外国语大学 中国传媒大学 中央财经大学 对外经济贸易大学 北京体育大学 中央音乐学院 中国政法大学 华北电力大学 天津医科大学 河北工业大学 太原理工大学 内蒙古大学 辽宁大学 大连海事大学 延边大学 东北师范大学 哈尔滨工程大学 东北农业大学 东北林业大学 华东理工大学 东华大学 上海外国语大学 上海财经大学 上海大学 第二军医大学 苏州大学 南京航空航天大学 南京理工大学 中国矿业大学 河海大学 江南大学 南京农业大学 中国药科大学 南京师范大学 安徽大学 合肥工业大学 福州大学 南昌大学 郑州大学 中国地质大学 武汉理工大学 华中农业大学 华中师范大学 中南财经政法大学 湖南师范大学 暨南大学 华南师范大学 广西大学 海南大学 西南交通大学 四川农业大学 西南财经大学 贵州大学 云南大学 西藏大学 西北大学 西安电子科技大学 长安大学 陕西师范大学 第四军医大学 青海大学 宁夏大学 新疆大学 石河子大学".split(" "));

function inferredSchoolClassification(profile = {}) {
  const explicit = String(profile.schoolClassification || "");
  if (explicit) return explicit;
  const name = String(profile.university || profile.school || profile.undergraduateUniversity || "").replace(/[（(].*?[）)]/g, "").trim();
  if (elite985.has(name) || /985|C9/i.test(name)) return "985本科";
  if (elite211.has(name) || /211|财经211/i.test(name)) return "211本科";
  if (/双一流/.test(name)) return "双一流";
  if (/海本|海外|澳本|英本|美本|加本|国外|University|College/i.test(name)) return "海外本科";
  if (/双非|一本|二本|民办|独立院校/.test(name)) return "双非";
  if (/大学|学院|院校/.test(name)) return "双非";
  return "";
}

export function gpaToComparablePercent(value, scale) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return String(scale) === "100" && numeric >= 0 && numeric <= 100 ? numeric : null;
}

export function estimateFourPointGpa(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return null;
  if (value >= 90) return { min: 3.7, max: 4.0, label: "3.7–4.0" };
  if (value >= 85) return { min: 3.3, max: 3.7, label: "3.3–3.7" };
  if (value >= 80) return { min: 3.0, max: 3.3, label: "3.0–3.3" };
  if (value >= 75) return { min: 2.7, max: 3.0, label: "2.7–3.0" };
  if (value >= 70) return { min: 2.3, max: 2.7, label: "2.3–2.7" };
  return { min: 0, max: 2.3, label: "2.0–2.3或更低" };
}

function backgroundCorrection(profile = {}) {
  const classification = inferredSchoolClassification(profile);
  const tier = Number(profile.schoolTier);
  if (/985/.test(classification)) return { label: "985本科", min: 0, max: 0, default: 0 };
  if (/211/.test(classification)) return { label: "非985的211本科", min: 1, max: 2, default: 1.5 };
  if (/双一流/.test(classification)) return { label: "强双非或双一流双非", min: 2, max: 2.5, default: 2 };
  if (/双非/.test(classification)) return { label: "普通双非", min: 2.5, max: 4, default: 3 };
  if (/二本|民办|专科/.test(classification)) return { label: "普通二本或民办本科", min: 3.5, max: 5, default: 4.25 };
  if (/海外|海本/.test(classification)) return { label: "海外本科", min: 0, max: 0, default: 0 };
  if (tier === 3) return { label: "海外本科或高层次本科（数据库分层）", min: 0, max: 0, default: 0 };
  if (tier === 2) return { label: "211/双一流分层（院校标签待核验）", min: 1, max: 2, default: 1.5 };
  if (tier === 1) return { label: "普通双非分层（院校标签待核验）", min: 2.5, max: 4, default: 3 };
  return null;
}

export function standardizeGpa(profile = {}) {
  const inputScale = String(profile.gpaScale || "");
  const scale = inputScale === "PERCENT_100" ? "100" : inputScale === "GPA_4" ? "4" : inputScale === "GPA_4_3" ? "4.3" : inputScale === "GPA_5" ? "5" : inputScale;
  const value = profile.gpaValue == null || profile.gpaValue === "" ? NaN : Number(profile.gpaValue);
  const result = {
    rawScore: Number.isFinite(value) ? value : null,
    rawScale: scale || null,
    rawLabel: scale === "100" ? "百分制均分" : scale === "4" ? "四分制 GPA" : scale === "4.3" ? "4.3分制 GPA" : scale === "5" ? "五分制 GPA" : "未知分制成绩",
    officialGpa: null,
    officialGpaScale: null,
    estimatedGpa4: null,
    comparablePercent: null,
    backgroundCorrection: null,
    equivalentScore: null,
    confidence: "低",
    notes: []
  };
  if (!Number.isFinite(value)) {
    result.notes.push("尚未提供可计算的成绩；请补充成绩单官方均分或 GPA。");
    return result;
  }
  if (["4", "4.3", "5"].includes(scale)) {
    result.officialGpa = value;
    result.officialGpaScale = scale === "4" ? "4.0" : scale === "4.3" ? "4.3" : "5.0";
    result.notes.push("没有成绩单上的官方百分制均分时，不把 GPA 按满分比例换算成百分制；只与相同分制的案例原值比较。");
    return result;
  }
  if (scale === "100") {
    const comparablePercent = gpaToComparablePercent(value, scale);
    result.comparablePercent = comparablePercent;
    result.estimatedGpa4 = estimateFourPointGpa(value);
    result.backgroundCorrection = backgroundCorrection(profile);
    if (result.backgroundCorrection && Number.isFinite(comparablePercent)) {
      const correction = result.backgroundCorrection;
      result.equivalentScore = {
        min: rounded(comparablePercent - correction.max),
        max: rounded(comparablePercent - correction.min),
        default: rounded(comparablePercent - correction.default)
      };
    } else {
      result.notes.push("未识别本科院校层次，不计算985等效均分。");
    }
    result.notes.push("粗略4.0 GPA仅用于内部比较，不是成绩单官方换算结果。");
    return result;
  }
  result.notes.push("成绩分制未知，不能进行跨分制换算。");
  return result;
}

const profileScale = scale => ({ "100": "PERCENT_100", "4": "GPA_4", "4.3": "GPA_4_3", "5": "GPA_5" }[String(scale)] || scale || "UNKNOWN");

const validPercent = value => Number.isFinite(value) && value >= 40 && value <= 100;
const validGpa = (value, maximum) => Number.isFinite(value) && value >= 1.5 && value <= maximum;

export function caseGpaInput(item = {}) {
  const raw = String(item.gpaRaw || "").replace(/，/g, ",");
  const fractionPattern = /(\d+(?:\.\d+)?)\s*\/\s*(4\.3|4(?:\.0)?|5(?:\.0)?|100)\b/g;
  const fractions = [...raw.matchAll(fractionPattern)].map(match => ({ value: Number(match[1]), denominator: Number(match[2]) }));
  const withoutFractions = raw.replace(fractionPattern, " ");
  const percentRange = withoutFractions.match(/(\d{2}(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(\d{2}(?:\.\d+)?)/);
  const rangePercent = percentRange ? (Number(percentRange[1]) + Number(percentRange[2])) / 2 : null;
  const standaloneNumbers = [...withoutFractions.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  const percentDisclosed = /均分|平均分|加权|百分制|%|\d{2}(?:\.\d+)?\s*分(?!制)/.test(raw)
    || fractions.length > 0 || item.gpaScale === "PERCENT_100";
  const explicitPercent = !percentDisclosed ? null : validPercent(rangePercent)
      ? rangePercent
      : standaloneNumbers.find(validPercent) ?? (item.gpaScale === "PERCENT_100" && !fractions.some(item => item.denominator !== 100)
        && validPercent(Number(item.gpa100)) ? Number(item.gpa100) : null);

  // Some source pages publish both a percentage average and an official GPA.
  // Prefer the percentage value so one record is never misread as e.g. 86.12/4.0.
  if (Number.isFinite(explicitPercent)) return { scale: "PERCENT_100", value: explicitPercent };

  for (const fraction of fractions) {
    if (fraction.denominator === 100 && validPercent(fraction.value)) return { scale: "PERCENT_100", value: fraction.value };
    if (fraction.denominator === 4 && validGpa(fraction.value, 4)) return { scale: "GPA_4", value: fraction.value };
    if (fraction.denominator === 4.3 && validGpa(fraction.value, 4.3)) return { scale: "GPA_4_3", value: fraction.value };
    if (fraction.denominator === 5 && validGpa(fraction.value, 5)) return { scale: "GPA_5", value: fraction.value };
  }

  const declaredScale = String(item.gpaScale || "UNKNOWN");
  const withoutScaleLabels = raw.replace(/(?:4(?:\.0)?|4\.3|5(?:\.0)?)\s*分制/g, " ");
  const values = [...withoutScaleLabels.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  if (declaredScale === "PERCENT_100") {
    const value = values.find(validPercent);
    if (Number.isFinite(value)) return { scale: declaredScale, value };
  }
  const declaredMaximum = { GPA_4: 4, GPA_4_3: 4.3, GPA_5: 5 }[declaredScale];
  if (declaredMaximum) {
    const value = values.find(candidate => validGpa(candidate, declaredMaximum));
    if (Number.isFinite(value)) return { scale: declaredScale, value };
  }

  return { scale: "UNKNOWN", value: null };
}

const caseScale = item => caseGpaInput(item).scale;
const caseGpaValue = item => caseGpaInput(item).value;

function caseSchoolClassification(item) {
  const explicit = String(item.schoolClassification || "");
  if (explicit) return explicit;
  const text = String(item.school || item.undergraduateUniversity || "");
  if (/985/.test(text)) return "985本科";
  if (/211/.test(text)) return "211本科";
  if (/双一流/.test(text)) return "双一流";
  if (/双非/.test(text)) return "双非";
  return null;
}

function standardizedCaseGpa(item) {
  const raw = caseGpaValue(item);
  const scale = caseScale(item);
  if (!Number.isFinite(raw) || scale === "UNKNOWN") return null;
  return standardizeGpa({
    gpaScale: { PERCENT_100: "100", GPA_4: "4", GPA_4_3: "4.3", GPA_5: "5" }[scale],
    gpaValue: raw,
    schoolTier: item.schoolTier,
    schoolClassification: caseSchoolClassification(item),
    university: item.school || item.undergraduateUniversity
  });
}

function groupGpas(cases) {
  const groups = {};
  for (const item of cases) {
    const value = caseGpaValue(item);
    if (!Number.isFinite(value)) continue;
    (groups[caseScale(item)] ||= []).push(value);
  }
  return Object.fromEntries(Object.entries(groups).map(([scale, values]) => [scale, { count: values.length, ...summarize(values) }]));
}

function nearestCase(profile, programme) {
  const cases = programme.cases || [];
  if (!cases.length) return null;
  const scale = profileScale(profile.gpaScale);
  const value = profile.gpaValue == null || profile.gpaValue === "" ? NaN : Number(profile.gpaValue);
  const userEquivalent = scale === "PERCENT_100" ? standardizeGpa(profile).equivalentScore?.default : null;
  const languageTest = profile.languageTest || "IELTS";
  return [...cases].sort((a, b) => {
    const tuple = item => {
      const itemGpa = scale === "PERCENT_100" ? standardizedCaseGpa(item)?.equivalentScore?.default
        : caseScale(item) === scale ? caseGpaValue(item) : null;
      const userGpa = scale === "PERCENT_100" ? userEquivalent : value;
      const comparableGpa = Number.isFinite(itemGpa) && Number.isFinite(userGpa);
      const comparableLanguage = item.languageTest === languageTest && Number.isFinite(item.language) && Number.isFinite(profile.language);
      return [
        item.schoolTier === profile.schoolTier ? 0 : 1,
        item.majorTag === profile.major ? 0 : 1,
        comparableGpa ? 0 : 1,
        comparableGpa ? Math.abs(itemGpa - userGpa) : Number.POSITIVE_INFINITY,
        comparableLanguage ? 0 : 1,
        comparableLanguage ? Math.abs(item.language - profile.language) : Number.POSITIVE_INFINITY
      ];
    };
    const aOrder = tuple(a);
    const bOrder = tuple(b);
    for (let index = 0; index < aOrder.length; index += 1) {
      if (aOrder[index] !== bOrder[index]) return aOrder[index] - bOrder[index];
    }
    return 0;
  })[0];
}

function sameMajor(item, profile) {
  const applicant = String(profile.majorName || '').trim().toLowerCase().replace(/\s+/g, '');
  const recorded = String(item.majorName || '').trim().toLowerCase().replace(/\s+/g, '');
  if (applicant && recorded) {
    const names = [recorded, ...[...recorded.matchAll(/[（(]([^（）()]+)[）)]/g)].map(match => match[1])];
    return names.includes(applicant);
  }
  return Boolean(item.majorTag && profile.major && item.majorTag === profile.major);
}

export function analyzeCaseEvidence(profile, programme) {
  const cases = programme.cases || [];
  const referenceYear = referenceYearForCases(cases, profile.applicationYear);
  const weightOf = item => Number.isFinite(Number(item.yearWeight))
    ? Number(item.yearWeight)
    : caseYearWeight(item.offerYear ?? item.cycle, referenceYear);
  const scale = profileScale(profile.gpaScale);
  const userGpa = profile.gpaValue == null || profile.gpaValue === "" ? NaN : Number(profile.gpaValue);
  const userStandardization = standardizeGpa(profile);
  const percentScale = scale === "PERCENT_100";
  const comparableScale = percentScale ? "985_EQUIVALENT_PERCENT" : ["GPA_4", "GPA_4_3", "GPA_5"].includes(scale) ? scale : null;
  const normalizedUserGpa = percentScale ? userStandardization.equivalentScore?.default ?? null
    : comparableScale && Number.isFinite(userGpa) ? userGpa : null;
  const comparableCases = cases
    .map(item => ({ item, raw: caseGpaValue(item), standardization: standardizedCaseGpa(item) }))
    .map(entry => ({ ...entry, normalized: percentScale ? entry.standardization?.equivalentScore?.default
      : comparableScale && caseScale(entry.item) === scale ? entry.raw : null }))
    .filter(entry => Number.isFinite(entry.normalized));
  const userTierLabel = userStandardization.backgroundCorrection?.label;
  const sameTierCases = comparableCases.filter(({ item, standardization }) => percentScale
    ? userTierLabel && standardization.backgroundCorrection?.label === userTierLabel
    : profile.schoolTier != null && item.schoolTier != null && Number(item.schoolTier) === Number(profile.schoolTier));
  const comparisonCases = sameTierCases.length ? sameTierCases : comparableCases;
  const comparisonValues = comparisonCases.map(entry => entry.normalized);
  const comparisonMedianGpa = comparisonValues.length ? median(comparisonValues) : null;
  const gpaStats = summarize(comparableCases.map(entry => entry.normalized));
  const sameTierStats = summarize(sameTierCases.map(entry => entry.normalized));
  const weightedGpaStats = weightedSummary(comparableCases.map(({ item, normalized }) => ({ value: normalized, weight: weightOf(item) })));
  const weightedSameTierStats = weightedSummary(sameTierCases.map(({ item, normalized }) => ({ value: normalized, weight: weightOf(item) })));
  const weightedComparisonStats = weightedSummary(comparisonCases.map(({ item, normalized }) => ({ value: normalized, weight: weightOf(item) })));

  const languageTest = profile.languageTest || "IELTS";
  const languageCases = cases.filter(item => item.languageTest === languageTest && Number.isFinite(item.language));
  const languageStats = summarize(languageCases.map(item => item.language));
  const weightedLanguageStats = weightedSummary(languageCases.map(item => ({ value: item.language, weight: weightOf(item) })));
  const languageRequirement = languageTest === "IELTS" ? programme.languageMin : null;
  const sameTierCount = sameTierCases.length;
  const sameMajorCount = cases.filter(item => sameMajor(item, profile)).length;
  const sameTierMajorCount = sameTierCases.filter(({ item }) => sameMajor(item, profile)).length;
  const gpaAtOrBelowUser = Number.isFinite(normalizedUserGpa) ? comparableCases.filter(entry => entry.normalized <= normalizedUserGpa).length : 0;
  const gpaInsertionRank = gpaStats && Number.isFinite(normalizedUserGpa)
    ? 1 + comparableCases.filter(entry => entry.normalized > normalizedUserGpa).length
    : null;
  const belowAllComparableCases = gpaInsertionRank != null && gpaInsertionRank > comparableCases.length;

  return {
    comparisonMedianGpa: weightedComparisonStats?.weightedMedian ?? null,
    gpaDelta: comparisonMedianGpa != null && Number.isFinite(normalizedUserGpa) ? normalizedUserGpa - comparisonMedianGpa : null,
    languageMet: languageRequirement == null ? null : profile.language >= languageRequirement,
    nearest: nearestCase(profile, programme),
    evidence: {
      caseCount: cases.length,
      background: {
        sameTierCount,
        sameMajorCount,
        sameTierMajorCount,
        comparableGpaCount: comparableCases.length,
        gpaPercentileAmongSuccessfulCases: comparableCases.length >= 5 && Number.isFinite(normalizedUserGpa)
          ? round(gpaAtOrBelowUser / comparableCases.length * 100)
          : null
      },
      gpa: {
        available: Boolean(gpaStats && Number.isFinite(normalizedUserGpa)),
        scale: comparableScale,
        ...(gpaStats || { min: null, max: null, mean: null, median: null }),
        ...(weightedGpaStats || { weightedMean: null, weightedMedian: null, totalWeight: 0 }),
        referenceYear,
        user: Number.isFinite(normalizedUserGpa) ? normalizedUserGpa : null,
        rawUser: Number.isFinite(userGpa) ? userGpa : null,
        rank: comparableCases.length < 5 || belowAllComparableCases ? null : gpaInsertionRank,
        total: comparableCases.length,
        positionNote: comparableCases.length > 0 && comparableCases.length < 5
          ? `仅 ${comparableCases.length} 条同分制可比成功案例，不展示 GPA 名次；个别成功样本不能证明成绩优势、劣势或录取门槛。`
          : belowAllComparableCases
          ? `低于全部 ${comparableCases.length} 条同分制可比成功案例；案例最低分不是官方录取门槛。`
          : gpaInsertionRank === comparableCases.length
          ? `插入 ${comparableCases.length} 条成功案例后约在第 ${gpaInsertionRank} 位（共有 ${comparableCases.length + 1} 个位置）；这不是现有案例中的名次，申请人成绩并非低于全部案例。`
          : null,
        sameTier: sameTierStats ? { ...sameTierStats, ...(weightedSameTierStats || {}) } : null,
        sameTierCount: sameTierCases.length,
        groups: groupGpas(cases),
        normalization: {
          applied: Boolean(userStandardization.equivalentScore),
          baseline: percentScale ? "985本科" : null,
          comparableCount: comparableCases.length,
          excludedCount: cases.filter(item => Number.isFinite(caseGpaValue(item))).length - comparableCases.length,
          note: percentScale
            ? "只使用已披露的百分制均分，按本科院校层次校正到985本科基准；其他GPA分制不参与换算。"
            : "只比较相同分制的原始GPA；未换算为百分制，也未做985基准校正。"
        },
        note: gpaStats && Number.isFinite(normalizedUserGpa) ? null
          : percentScale ? "没有可比较的百分制审核案例或无法计算院校基准分，不显示GPA位置。"
          : "没有相同分制的审核案例，不把GPA换算成百分制来制造比较。"
      },
      language: {
        available: Boolean(languageStats),
        test: languageTest,
        ...(languageStats || { min: null, max: null, mean: null, median: null }),
        ...(weightedLanguageStats || { weightedMean: null, weightedMedian: null, totalWeight: 0 }),
        referenceYear,
        user: Number.isFinite(profile.language) ? profile.language : null,
        total: languageCases.length,
        required: languageRequirement
      }
    },
    assessmentAvailable: false,
    center: null,
    low: null,
    high: null,
  };
}

export function analyzeAll(profile, programmes) {
  return programmes.map(programme => ({ programme, result: analyzeCaseEvidence(profile, programme) }));
}
