const normalizeText = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();

const tierOrYear = value => {
  const text = normalizeText(value);
  return /^(?:985|211|985&211|211&985|双一流|双非|双非一本|海本|19\d{2}|20\d{2})$/i.test(text);
};

function convertGpa(raw, scaleHint = null) {
  const value = normalizeText(raw);
  if (!value || tierOrYear(value)) return null;
  const scoreOnly = Number(value);
  if (scaleHint === "PERCENT_100" && Number.isFinite(scoreOnly) && scoreOnly >= 50 && scoreOnly <= 100) {
    return { gpaRaw: value, gpaScale: "PERCENT_100", gpa100: scoreOnly };
  }
  if (Number.isFinite(scoreOnly) && scoreOnly >= 50 && scoreOnly <= 100) {
    return { gpaRaw: value, gpaScale: "PERCENT_100", gpa100: scoreOnly };
  }
  const ratio = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!ratio) return { gpaRaw: value, gpaScale: "UNKNOWN", gpa100: null };
  const score = Number(ratio[1]);
  const denominator = Number(ratio[2]);
  if (!Number.isFinite(score) || !Number.isFinite(denominator) || denominator === 0) return null;
  if (denominator !== 100 && (denominator < 4 || denominator > 10)) return null;
  if (denominator !== 100 && score > denominator) return null;
  if (denominator === 100 && (score < 50 || score > 100)) return null;
  return {
    gpaRaw: value,
    gpaScale: denominator === 100 ? "PERCENT_100" : `GPA_${denominator}`,
    gpa100: score / denominator * 100
  };
}

function maskNonGpaNumbers(text) {
  let masked = text;
  // These numbers are not undergraduate GPA values. Mask the whole token so
  // 985/211, years, and standardized tests cannot become a bare score.
  masked = masked.replace(/(?:985|211)(?=大学|院校|本|一本|&|和|\b)/gi, " ");
  masked = masked.replace(/\b(?:19|20)\d{2}\b/g, " ");
  masked = masked.replace(/(?:雅思|IELTS|托福|TOEFL|GRE|GMAT|SAT|ACT|PTE|多邻国)\s*(?:总分|成绩|分数|score)?\s*[:：]?\s*\d+(?:\.\d+)?(?:\s*[（(]\s*\d+(?:\.\d+)?\s*[）)])?/gi, " ");
  return masked;
}

function validRatio(raw) {
  const match = normalizeText(raw).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return convertGpa(`${match[1]}/${match[2]}`);
}

export function extractMastermateGpa(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const labeledMatch = text.match(/(?:GPA|均分|平均分|绩点)\s*[:：]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)/i);
  if (labeledMatch) {
    const parsed = convertGpa(labeledMatch[1]);
    if (parsed) return parsed;
  }

  const masked = maskNonGpaNumbers(text);
  const ratioTokens = [...masked.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?!\d)/g)];
  const ratioMatches = ratioTokens.map(match => validRatio(`${match[1]}/${match[2]}`)).filter(Boolean);
  if (ratioMatches.length) return ratioMatches[0];
  if (ratioTokens.length) return { gpaRaw: `${ratioTokens[0][1]}/${ratioTokens[0][2]}`, gpaScale: "UNKNOWN", gpa100: null };

  const percentMatch = masked.match(/(?<![\d.])(\d{2}(?:\.\d+)?)\s*(?:分|%)(?![\d.])/i);
  if (percentMatch) {
    const parsed = convertGpa(percentMatch[1], "PERCENT_100");
    if (parsed) return parsed;
  }

  const bareMatches = [
    ...masked.matchAll(/(?<![\d./])(\d{2}(?:\.\d{1,2})?)(?![\d/])/g),
    ...masked.matchAll(/(?<![\d./])(\d+\.\d{1,2})(?![\d/])/g)
  ]
    .sort((a, b) => a.index - b.index)
    .map(match => convertGpa(match[1], Number(match[1]) >= 50 ? "PERCENT_100" : null))
    .filter(Boolean);
  return bareMatches[0] || null;
}

const majorWord = /工程|科学|技术|管理|经济|金融|计算机|电子|通信|自动化|数学|物理|化学|材料|机械|机器人|信息|软件|数据|网络|控制|建筑|设计|法律|法学|医学|药|统计|会计|市场营销|营销|商务|商业|工商|财政|传播|传媒|新闻|文学|语言|社会科学|社会学|政治|心理|教育|生物|环境|能源|地理|哲学|历史|国际关系|Business|Economics|Finance|Computer|Engineering|Science|Technology|Management|Information|Mathematics|Physics|Chemistry|Material|Mechanical|Robotics|Software|Data|Network|Control|Architecture|Design|Law|Medicine|Statistics|Accounting|Marketing|Business Administration|Communication|Journalism|Literature|Language|Education|Biology|Environment|Energy|Geography|Psychology/i;
const majorStop = /(?:GPA|均分|平均分|绩点|雅思|IELTS|托福|TOEFL|GRE|GMAT|SAT|ACT|PTE|多邻国|申请优势|优势总结|实习|银行|券商|工作经验|工作|研究经历|科研|论文|奖学金|毕业|大四|大三|在读)/i;

function cleanMajor(value) {
  return normalizeText(value)
    .replace(/^[\s:：+，,;；、。·•]+|[\s:：+，,;；、。·•]+$/g, "")
    .replace(/(?:本科|主修|专业)\s*[:：]?\s*/g, "")
    .replace(/\s*(?:GPA|均分|平均分|绩点).*$/i, "")
    .replace(/\s*(?:雅思|IELTS|托福|TOEFL|GRE|GMAT|SAT|ACT|PTE|多邻国).*$/i, "")
    .replace(/\s*\d{2}(?:\.\d{1,2})?\s*(?:分|%|\/\s*\d+(?:\.\d+)?)?.*$/i, "")
    .trim()
    .replace(/专业$/, "")
    .trim();
}

function findInstitution(text) {
  const first = text.split(/[，,;；+]/)[0].trim();
  const bracket = text.match(/[（(【\[]\s*(?:985(?:\s*[&和]\s*211)?|211(?:\s*[&和]\s*985)?|双一流|双非(?:一本)?|海本[^）)】\]]*|海外本科[^）)】\]]*)\s*[）)】\]]/i);
  if (bracket) return normalizeText(bracket[0]).replace(/^[（(【\[]|[）)】\]]$/g, "");
  const tier = first.match(/^(?:985\s*(?:大学|院校)?\s*(?:[&和]\s*211)?|211\s*(?:大学|院校)?\s*(?:[&和]\s*985)?|双一流(?:一本)?|双非(?:一本|财经院校|综合院校|理工院校)?|海本[^\s，,;；+]*|海外本科[^\s，,;；+]*)/i);
  if (tier) return normalizeText(tier[0]);
  const university = first.match(/^.*?(?:大学|学院)(?=\s|$|[，,;；+])/);
  if (university) return normalizeText(university[0]);
  if (/985|211|双一流|双非|海本|海外本科/i.test(first)) return first;
  return first || null;
}

function findMajor(text, institution) {
  const start = institution ? text.indexOf(institution) + institution.length : 0;
  let body = start > 0 ? text.slice(start) : text;
  body = body.replace(/^[\s:：+，,;；、。()（）【】\[\]]+/, "");

  const segments = body.split(/[，,;；+]/).map(item => item.trim()).filter(Boolean);
  const beforeStop = body.slice(0, body.search(majorStop) >= 0 ? body.search(majorStop) : body.length);
  const score = beforeStop.match(/(?<![\d.])(?:\d+\.\d+\s*\/\s*\d+|\d{2}(?:\.\d{1,2})?\s*(?:分|%))(?!\d)/);
  const beforeScore = score ? beforeStop.slice(0, score.index) : beforeStop;
  const afterLeadingScore = body.replace(/^\d{2}(?:\.\d{1,2})?\s*(?:分|%)?\s*/, "").split(majorStop)[0];
  const candidates = [
    ...segments,
    beforeScore,
    afterLeadingScore
  ];
  for (const candidate of candidates) {
    const cleaned = cleanMajor(candidate)
      .replace(/^\d{4}年(?:毕业|入学)?\s*/, "")
      .replace(/^\d{2,3}\s*(?:分|%)?\s*/, "")
      .trim();
    if (!cleaned || majorStop.test(cleaned) || /^(?:大四在读|本科|硕士|研究生|QS\s*\d+)$/i.test(cleaned)) continue;
    if (majorWord.test(cleaned)) return cleaned;
  }
  const firstSegment = cleanMajor(segments[0] || beforeScore);
  if (firstSegment && !majorStop.test(firstSegment) && !/^(?:本科|硕士|研究生|大四在读|QS\s*\d+)$/i.test(firstSegment)) {
    return firstSegment;
  }
  return null;
}

export function extractMastermateBackground(value) {
  const text = normalizeText(value);
  if (!text) return { institution: null, major: null };
  const undergraduatePart = text.match(/本科\s*[:：]\s*(.+?)(?=[;；]\s*(?:硕士|研究生)\s*[:：]|$)/i)?.[1] || text;
  const institution = findInstitution(undergraduatePart);
  const major = findMajor(undergraduatePart, institution);
  const language = text.match(/(雅思|IELTS|托福|TOEFL)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
  return {
    institution,
    major,
    ...(extractMastermateGpa(undergraduatePart) || {}),
    languageTest: language?.[1] || null,
    languageScore: language ? Number(language[2]) : null
  };
}
