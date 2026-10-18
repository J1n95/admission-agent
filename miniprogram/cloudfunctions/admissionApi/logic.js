const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·•・,，.。()（）\-_/\\'’]/g, '');

const FIELD_KEYWORDS = {
  automation: ['自动化', 'automation', '控制', 'control', '机器人', 'robotic'],
  control: ['控制', 'control', '自动化', 'automation', '机器人', 'robotic'], electrical: ['电气', '电机', 'electrical'],
  electronic: ['电子', 'electronic'], communication: ['通信', 'communication', 'telecommunication'],
  ai: ['人工智能', 'artificialintelligence', 'machinelearning'], computer: ['计算机', 'computer', 'computing'],
  mechanical: ['机械', 'mechanical'], civil: ['土木', 'civil'],
  robotics: ['机器人', 'robotic', '自动化', 'automation', '控制', 'control'],
  data: ['数据', 'data', 'analytics'], software: ['软件', 'software'], iot: ['物联网', 'internetofthings'],
  network: ['网络', 'network'], cloud: ['云计算', 'cloud'], signal: ['信号', 'signal'],
  'integrated-circuit': ['集成电路', 'integratedcircuit'], semiconductor: ['半导体', 'semiconductor'],
  manufacturing: ['制造', 'manufacturing'], chemical: ['化学工程', 'chemicalengineering'],
  biomedical: ['生物医学', 'biomedical'], healthcare: ['健康', 'health'], materials: ['材料', 'material'],
  biology: ['生命科学', 'biology', 'lifescience'], biotechnology: ['生物技术', 'biotechnology'],
  medicine: ['医学', 'medical', 'medicine'], pharmacy: ['药学', 'pharmacy', 'pharmaceutical'],
  'public-health': ['公共卫生', 'publichealth'], 'food-nutrition': ['食品', '营养', 'food', 'nutrition'],
  psychology: ['心理', 'psychology'], environmental: ['环境', 'environment'], energy: ['能源', 'energy'],
  power: ['电力', 'power'], mathematics: ['数学', '统计', 'mathematics', 'statistics'], physics: ['物理', 'physics'],
  optoelectronics: ['光电', 'optical', 'photonics'], instrumentation: ['仪器', 'instrumentation'],
  railway: ['轨道', 'railway'], architecture: ['建筑', '规划', 'architecture', 'planning'],
  business: ['商业', '管理', 'business', 'management'], finance: ['金融', 'finance', 'fintech'],
  accounting: ['会计', '审计', 'accounting'], economics: ['经济', 'economics'],
  operations: ['运营', '供应链', '物流', 'operations', 'supplychain', 'logistics'], marketing: ['市场', '营销', 'marketing'],
  law: ['法律', 'law'], education: ['教育', '教学', 'education', 'teaching'], media: ['传媒', '新闻', 'media', 'journalism'],
  design: ['设计', 'design'], 'public-policy': ['公共政策', '公共管理', 'publicpolicy', 'publicadministration'],
  'social-science': ['社会科学', 'socialscience'], humanities: ['语言', '人文', 'language', 'humanities']
};

const programmeTitle = item => normalize([item.nameZh, item.name].filter(Boolean).join(' '));
const hasDirectTitleMatch = (item, field) => (FIELD_KEYWORDS[field] || []).some(keyword => programmeTitle(item).includes(normalize(keyword)));
const uniqueFields = values => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
const CROSS_DOMAIN_FIELDS = new Set([
  'business', 'finance', 'accounting', 'economics', 'operations', 'marketing', 'law', 'education', 'media', 'design',
  'public-policy', 'social-science', 'humanities', 'healthcare', 'medicine', 'pharmacy', 'public-health', 'food-nutrition',
  'psychology', 'biology', 'biotechnology'
]);

function searchInstitutions(catalogue, query, limit = 8) {
  const needle = normalize(query);
  if (!needle) return [];
  const score = item => {
    const terms = [item.nameZh, item.nameEn, ...(item.aliases || [])].map(normalize).filter(Boolean);
    if (terms.includes(needle)) return 0;
    if (terms.some(term => term.startsWith(needle))) return 1;
    return 2;
  };
  return catalogue.filter(item => [item.nameZh, item.nameEn, ...(item.aliases || [])]
    .some(value => normalize(value).includes(needle)))
    .sort((left, right) => score(left) - score(right) || left.nameZh.localeCompare(right.nameZh, 'zh-CN'))
    .slice(0, limit)
    .map(item => ({
      id: item.id, nameZh: item.nameZh, nameEn: item.nameEn,
      classification: item.classification, scoreTier: item.scoreTier, city: item.city
    }));
}

function searchMajors(catalogue, query, limit = 20) {
  const needle = normalize(query);
  if (!needle) return [];
  const score = item => {
    const terms = [item.code, item.name, ...(item.aliases || [])].map(normalize).filter(Boolean);
    if (terms.includes(needle)) return 0;
    if (terms.some(term => term.startsWith(needle))) return 1;
    return 2;
  };
  return catalogue.filter(item => [item.code, item.name, item.categoryName, item.className, ...(item.aliases || [])]
    .some(value => normalize(value).includes(needle)))
    .sort((left, right) => score(left) - score(right) || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, limit);
}

function standardizeGpa(profile = {}) {
  const comparablePercent = Number(profile.gpaStandardization?.comparablePercent);
  if (Number.isFinite(comparablePercent)) return clamp(comparablePercent, 0, 100);
  const value = Number(profile.gpaStandardization?.rawScore ?? profile.gpaValue);
  const scale = String(profile.gpaStandardization?.rawScale ?? profile.gpaScale);
  if (!Number.isFinite(value)) return null;
  if (scale === '100') return clamp(value, 0, 100);
  if (scale === '4') return clamp(value * 25, 0, 100);
  if (scale === '5') return clamp(value * 20, 0, 100);
  return null;
}

function caseGpa100(item = {}) {
  const raw = String(item.gpa?.raw || '').replace(/，/g, ',').trim();
  const range = raw.match(/(\d{2}(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(\d{2}(?:\.\d+)?)/);
  if (range) return clamp((Number(range[1]) + Number(range[2])) / 2, 0, 100);
  const fraction = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*(4\.3|4(?:\.0)?|5(?:\.0)?|100)\b/);
  if (fraction) {
    const value = Number(fraction[1]);
    const maximum = Number(fraction[2]);
    if (maximum === 100) return value >= 40 && value <= 100 ? value : null;
    if (value < 1.5 || value > maximum) return null;
    const fourPointValue = maximum === 4.3 ? value / 4.3 * 4 : maximum === 5 ? value / 5 * 4 : value;
    const points = [[0, 0], [2, 65], [2.3, 70], [2.7, 75], [3, 80], [3.3, 85], [3.7, 90], [4, 100]];
    const bounded = clamp(fourPointValue, 0, 4);
    const upperIndex = points.findIndex(([input]) => input >= bounded);
    if (upperIndex <= 0) return points[0][1];
    const [lowerInput, lowerOutput] = points[upperIndex - 1];
    const [upperInput, upperOutput] = points[upperIndex];
    return lowerOutput + (bounded - lowerInput) / (upperInput - lowerInput) * (upperOutput - lowerOutput);
  }
  const rawPercent = [...raw.matchAll(/(?<![\d.])(\d{2}(?:\.\d+)?)(?![\d/])/g)]
    .map(match => Number(match[1])).find(value => value >= 40 && value <= 100);
  if (Number.isFinite(rawPercent)) return rawPercent;
  const value = Number(item.gpa?.value100);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

function selectCandidates(programmes, input, maximum = 8) {
  const regions = new Set((input.regions || []).map(String));
  const schools = new Set((input.targetSchools || []).map(String));
  const fields = new Set((input.fields || []).map(String));
  const major = String(input.profile?.major || '');
  const rankingFields = uniqueFields(fields.size ? [...fields] : [major]);
  return programmes
    .filter(item => !regions.size || regions.has(item.region))
    .filter(item => !schools.size || schools.has(item.university))
    .map(item => {
      const tags = new Set(item.majorTags || []);
      const fieldMatches = [...fields].filter(value => tags.has(value)).length;
      const majorMatch = major && tags.has(major) ? 1 : 0;
      const directMatches = rankingFields.filter(field => hasDirectTitleMatch(item, field)).length;
      const crossDomainPenalty = [...tags].filter(field => CROSS_DOMAIN_FIELDS.has(field) && !rankingFields.includes(field)).length;
      const relevanceScore = directMatches * 10 - crossDomainPenalty * 11;
      return { item, fieldMatches, majorMatch, relevanceScore };
    })
    .filter(value => !fields.size || value.fieldMatches > 0)
    .sort((left, right) => right.relevanceScore - left.relevanceScore
      || right.majorMatch - left.majorMatch
      || right.fieldMatches - left.fieldMatches
      || Number(right.item.caseCount || 0) - Number(left.item.caseCount || 0)
      || left.item.id.localeCompare(right.item.id))
    .slice(0, maximum)
    .map(value => value.item);
}

function caseSimilarity(item, profile = {}) {
  const profileGpa = standardizeGpa(profile);
  const caseGpa = caseGpa100(item);
  const profileTags = new Set([
    profile.major,
    ...(profile.targetFields || []),
    ...(profile.internships || []).map(value => value.direction),
    ...(profile.researches || []).map(value => value.direction),
    ...(profile.awards || []).map(value => value.category)
  ].filter(Boolean));
  const caseTags = new Set(item.experienceTags || []);
  const tagMatches = [...profileTags].filter(value => caseTags.has(value)).length;
  const companyTypes = new Set((profile.internships || []).flatMap(value => value.companyTypes || []));
  const companyMatches = (item.companyTypes || []).filter(value => companyTypes.has(value)).length;
  const majorMatch = profile.major && item.undergraduate?.majorField === profile.major ? 1 : 0;
  const gpaScore = Number.isFinite(profileGpa) && Number.isFinite(caseGpa) ? Math.max(0, 30 - Math.abs(profileGpa - caseGpa) * 2) : 0;
  const language = Number(profile.language);
  const caseLanguage = Number(item.language?.score);
  const languageScore = profile.languageTest && profile.languageTest === item.language?.test
    && Number.isFinite(language) && Number.isFinite(caseLanguage) ? Math.max(0, 10 - Math.abs(language - caseLanguage) * 4) : 0;
  return gpaScore + majorMatch * 18 + tagMatches * 8 + companyMatches * 4
    + languageScore + Math.max(0, Number(item.offerYear || 0) - 2020) + Number(item.qualityScore || 0) / 20;
}

function selectEvidenceCases(cases, profile = {}, maximum = 5) {
  return [...cases]
    .sort((left, right) => caseSimilarity(right, profile) - caseSimilarity(left, profile)
      || Number(right.offerYear || 0) - Number(left.offerYear || 0)
      || String(left._id).localeCompare(String(right._id)))
    .slice(0, maximum);
}

function reportedCount(items = []) {
  return (items || []).reduce((total, item) => {
    const text = String(item || '');
    if (!text || /(^|[：:])\s*(无|没有)$/.test(text)) return total;
    const match = text.match(/(\d+)\s*(?:段|个|项|篇)/);
    return total + (match ? Number(match[1]) : 1);
  }, 0);
}

function isOpenidLimitExempt(openid, configured) {
  const target = String(openid || '').trim();
  return Boolean(target) && String(configured || '').split(/[\s,;]+/).filter(Boolean).includes(target);
}

function summarizeEvidenceCase(item = {}, profile = {}) {
  const experiences = item.experiences || {};
  const value100 = caseGpa100(item);
  const profileGpa = standardizeGpa(profile);
  const gpaText = Number.isFinite(value100) && value100 > 0
    ? `统一成绩 ${value100.toFixed(1)}`
    : String(item.gpa?.raw || '成绩未披露');
  const languageScore = Number(item.language?.score);
  const comparison = [];
  if (profile.major && item.undergraduate?.majorField) {
    comparison.push(profile.major === item.undergraduate.majorField ? '本科方向相同' : '本科方向不同');
  }
  if (Number.isFinite(profileGpa) && Number.isFinite(value100) && value100 > 0) {
    const delta = value100 - profileGpa;
    comparison.push(Math.abs(delta) < 1 ? '成绩接近' : `案例成绩${delta > 0 ? '高于' : '低于'}你 ${Math.abs(delta).toFixed(1)} 分`);
  }
  if (profile.languageTest && profile.languageTest === item.language?.test
    && Number.isFinite(Number(profile.language)) && Number.isFinite(languageScore) && languageScore > 0) {
    const delta = languageScore - Number(profile.language);
    comparison.push(Math.abs(delta) < 0.1 ? `${profile.languageTest} 相同` : `案例${profile.languageTest}${delta > 0 ? '高' : '低'} ${Math.abs(delta).toFixed(1)}`);
  }
  return {
    id: String(item._id || ''),
    year: Number(item.offerYear || 0) || '年份未披露',
    background: [item.undergraduate?.university, item.undergraduate?.classification, item.undergraduate?.major].filter(Boolean).join(' · ') || '本科背景未完整披露',
    gpa: gpaText,
    language: item.language?.test && Number.isFinite(languageScore) && languageScore > 0
      ? `${item.language.test} ${languageScore}`
      : '语言未披露',
    comparison: comparison.join(' · ') || '与当前背景的可比较字段不足',
    experience: [
      ['实习', reportedCount(experiences.internships)],
      ['科研', reportedCount(experiences.research)],
      ['项目', reportedCount(experiences.projects)],
      ['竞赛/奖项', reportedCount([...(experiences.competitions || []), ...(experiences.awards || [])])]
    ].filter(([, count]) => count > 0).map(([label, count]) => `${label}${count}`).join(' · ') || '经历未披露'
  };
}

module.exports = {
  searchInstitutions, searchMajors, selectCandidates, selectEvidenceCases, summarizeEvidenceCase,
  standardizeGpa, caseGpa100, isOpenidLimitExempt
};
