import { courseGroups, programmes, schools } from "./data.mjs";
import { analyzeAll, standardizeGpa } from "./case-analysis.mjs";
import { majorMaster } from "./major-master.mjs";
import { buildComparison } from "./comparison.mjs";
import { readableEvidenceIds } from "./display-evidence.mjs";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const desktopSettingsButton = $("#desktop-model-settings");
if (window.admissionDesktop?.openSettings) {
  desktopSettingsButton.hidden = false;
  desktopSettingsButton.addEventListener("click", () => window.admissionDesktop.openSettings());
}
const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const directionOptions = [
  ["automation", "自动化 / PLC / 控制"], ["control", "控制工程"], ["electrical", "电气 / 电力"],
  ["electronic", "电子 / 嵌入式 / 芯片"], ["communication", "通信 / 信号"],
  ["ai", "人工智能 / 数据"], ["computer", "软件 / 计算机"],
  ["mechanical", "机械 / 智能制造"], ["civil", "土木 / 建造"],
  ["robotics", "机器人"], ["data", "数据科学 / 分析"], ["software", "软件工程"],
  ["iot", "物联网"], ["network", "网络"], ["cloud", "云计算"], ["signal", "信号处理"],
  ["integrated-circuit", "集成电路"], ["semiconductor", "半导体"], ["manufacturing", "智能制造"],
  ["chemical", "化学工程"], ["biomedical", "生物医学"], ["healthcare", "健康 / 医疗"],
  ["materials", "材料 / 纳米"], ["biology", "生物 / 生命科学"], ["biotechnology", "生物技术"],
  ["medicine", "医学 / 临床"], ["pharmacy", "医药 / 药学"], ["public-health", "公共卫生"],
  ["food-nutrition", "食品 / 营养"], ["psychology", "心理 / 行为科学"],
  ["environmental", "环境"], ["energy", "能源"], ["power", "电力系统"], ["mathematics", "数学 / 统计"], ["physics", "物理"],
  ["optoelectronics", "光电 / 光学"], ["instrumentation", "仪器仪表"], ["railway", "轨道交通"],
  ["architecture", "建筑 / 城市规划"], ["business", "商业 / 管理"], ["finance", "金融"], ["accounting", "会计 / 审计"], ["economics", "经济学"],
  ["operations", "产品 / 运营 / 供应链"], ["marketing", "市场 / 营销"], ["law", "法律"],
  ["education", "教育"], ["media", "传媒 / 新闻"], ["design", "设计 / 艺术"],
  ["public-policy", "公共政策 / 公共管理"], ["social-science", "社会科学"],
  ["humanities", "语言 / 人文"], ["other", "其他 / 未分类项目"]
];

const majorOptions = [
  ["automation", "自动化"], ["electrical", "电气工程"], ["electronic", "电子信息 / 电子工程"],
  ["communication", "通信工程"], ["computer", "计算机"], ["data", "数据科学"],
  ["mechanical", "机械 / 机电"], ["civil", "土木 / 建筑"], ["chemical", "化学工程"],
  ["biomedical", "生物医学"], ["business", "工商管理 / 商科"], ["finance", "金融"],
  ["economics", "经济学"], ["law", "法学"], ["education", "教育学"],
  ["media", "传媒 / 新闻"], ["design", "设计"], ["medicine", "医学"],
  ["life-science", "生命科学"], ["engineering", "其他工科"], ["math", "数学"],
  ["physics", "物理学"], ["psychology", "心理学"], ["biology", "生物科学"],
  ["agriculture", "农学"], ["language", "语言文学"], ["history", "历史学"],
  ["art", "艺术学"], ["other", "其他专业"]
];

const companyTierOptions = [
  ["top", "知名大厂 / 世界500强"], ["established", "大型企业 / 知名机构"],
  ["medium", "中型企业"], ["small", "小型企业 / 初创公司 / 其他"]
];

const researchTypeOptions = [
  ["lab", "导师课题 / 实验室"], ["paper", "论文研究"], ["innovation", "大学生创新项目"],
  ["thesis", "毕业论文 / 毕业设计"], ["course", "课程研究项目"],
  ["industry", "企业联合研究"], ["assistant", "科研助理"], ["personal", "个人研究项目"]
];

const researchOutputOptions = [
  ["none", "暂无公开成果"], ["report", "研究报告"], ["project", "项目结题 / 系统成果"],
  ["paper", "论文 / 会议论文"], ["patent", "专利 / 软件著作权"], ["competition", "科研竞赛成果"]
];

const internshipDurationOptions = [
  ["less-3", "少于3个月"], ["3-6", "3–6个月"], ["6-12", "6–12个月"], ["over-12", "超过12个月"]
];

const awardLevelOptions = [
  ["international", "国际级"], ["national", "国家级"], ["provincial", "省级"],
  ["school", "校级"]
];

const awardCategoryOptions = [
  ["modeling", "数学建模"], ["electronic", "电子设计竞赛"], ["innovation", "创新创业竞赛"],
  ["student-innovation", "大学生创新训练计划"], ["programming", "程序设计 / 算法竞赛"],
  ["robotics", "机器人 / 智能车竞赛"], ["scholarship", "奖学金 / 学业奖项"],
  ["debate", "辩论 / 表达类竞赛"], ["business", "商业 / 案例竞赛"], ["finance", "金融 / 经济竞赛"],
  ["data", "数据分析 / 商业分析竞赛"], ["engineering", "工程实践 / 智能制造竞赛"],
  ["chemistry", "化学 / 材料竞赛"], ["biology", "生物 / 医学竞赛"],
  ["media", "传媒 / 广告 / 策划竞赛"], ["law", "模拟法庭 / 法律竞赛"],
  ["language", "外语 / 翻译竞赛"], ["education", "教学技能竞赛"],
  ["design", "设计 / 建筑 / 创意竞赛"], ["research", "科研 / 论文成果"], ["other", "其他"]
];

const optionHtml = (options, selected) => `${selected === "" ? "<option value=\"\" selected>请选择</option>" : ""}${options.map(([value, label]) =>
  `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
).join("")}`;

const defaultCourses = major => courseGroups.flatMap(group => group.courses)
  .filter(course => course.defaults.includes(major)).map(course => course.name);

function syncTargetSchoolChoices() {
  const regions = new Set($$("input[name='region']:checked").map(input => input.value));
  const allSchoolsLabel = $("#all-schools")?.closest("label")?.querySelector("span");
  if (allSchoolsLabel) allSchoolsLabel.textContent = regions.size === 1 ? `全部${[...regions][0]}学校` : "全部学校";
  $$('label[data-school-region]').forEach(label => {
    const visible = regions.has(label.dataset.schoolRegion);
    label.hidden = !visible;
    if (!visible) {
      const input = label.querySelector("input");
      input.checked = false;
      input.removeAttribute("checked");
    }
  });
  if (!$$("input[name='targetSchool']:checked").some(input => input.id !== "all-schools")) {
    $("#all-schools").checked = true;
  }
}

const emptyInternship = () => ({ company: "", role: "", duration: "", companyTier: "", direction: "", details: "" });
const emptyResearch = () => ({ title: "", institution: "", direction: "", type: "", role: "", duration: "", output: "", details: "" });
const emptyAward = () => ({ name: "", level: "", category: "", year: "", result: "", details: "" });

const initialState = {
  profile: {
    university: "", schoolTier: "", major: "", majorCode: "", majorName: "",
    gpaScale: "", gpaValue: "", languageTest: "", language: ""
  },
  internships: [],
  researches: [],
  awards: [],
  selectedCourses: [],
  additionalCourses: "",
  regions: ["香港", "新加坡"],
  targetSchools: [],
  fields: [],
  surveyCompleted: false,
  survey: null
};

const stored = sessionStorage.getItem("admission-reference-v3") || sessionStorage.getItem("admission-reference-v2");
const state = stored ? JSON.parse(stored) : structuredClone(initialState);
state.profile = { ...initialState.profile, ...(state.profile || {}) };
state.regions = Array.isArray(state.regions) && state.regions.length ? state.regions : [...initialState.regions];
state.targetSchools = Array.isArray(state.targetSchools) ? state.targetSchools : [];
state.fields = Array.isArray(state.fields) ? state.fields : [];
state.selectedCourses = Array.isArray(state.selectedCourses) ? state.selectedCourses : defaultCourses(state.profile.major);
if (!sessionStorage.getItem("admission-reference-v3")) state.fields = [];
const companyTierMigration = { tech: "top", fortune: "top", large: "established", institution: "established" };
const legacyBlankInternship = item => ![item.company, item.role, item.details].some(value => String(value || "").trim())
  && ["", "3-6"].includes(item.duration || "") && ["", "medium"].includes(item.companyTier || "")
  && ["", "automation"].includes(item.direction || "");
const legacyBlankResearch = item => ![item.title, item.institution, item.role, item.duration, item.details].some(value => String(value || "").trim())
  && ["", "lab"].includes(item.type || "") && ["", "none"].includes(item.output || "")
  && ["", "ai"].includes(item.direction || "");
const legacyBlankAward = item => ![item.name, item.year, item.result, item.details].some(value => String(value || "").trim())
  && ["", "provincial"].includes(item.level || "") && ["", "modeling"].includes(item.category || "");
const legacyDefaultProfile = state.profile.university === "中国矿业大学"
  && state.profile.major === "automation" && state.profile.gpaValue === 85
  && state.profile.languageTest === "IELTS" && state.profile.language === 7
  && (!Array.isArray(state.internships) || state.internships.every(legacyBlankInternship))
  && (!Array.isArray(state.researches) || state.researches.every(legacyBlankResearch))
  && (!Array.isArray(state.awards) || state.awards.every(legacyBlankAward));
if (legacyDefaultProfile) {
  state.profile = structuredClone(initialState.profile);
  state.selectedCourses = [];
}
state.internships = (Array.isArray(state.internships) ? state.internships : []).filter(item => item && !legacyBlankInternship(item)).map(item => ({
  ...emptyInternship(), ...item,
  companyTier: companyTierMigration[item.companyTier] || item.companyTier
}));
state.researches = (Array.isArray(state.researches) ? state.researches : []).filter(item => item && !legacyBlankResearch(item)).map(item => ({ ...emptyResearch(), ...item }));
state.awards = (Array.isArray(state.awards) ? state.awards : []).filter(item => item && !legacyBlankAward(item)).map(item => ({ ...emptyAward(), ...item, level: item.level === "department" ? "school" : item.level }));
state.additionalCourses ||= "";
state.surveyCompleted = Boolean(state.surveyCompleted);
let latestResults = [];
let latestProfile = null;
let personalizedInsights = {};
let latestAnalysisId = null;
let latestCalibrationValid = false;

function saveState() {
  sessionStorage.setItem("admission-reference-v3", JSON.stringify(state));
}

function closeMenus(except) {
  $$(".select-menu, .school-options").forEach(menu => {
    if (menu !== except) menu.hidden = true;
  });
  $$(".select-trigger[aria-expanded='true']").forEach(trigger => trigger.setAttribute("aria-expanded", "false"));
  $("#university")?.setAttribute("aria-expanded", except === $("#university-options") ? "true" : "false");
  $("#major-search")?.setAttribute("aria-expanded", except === $("#major-search-options") ? "true" : "false");
}

function enhanceSelects(root = document) {
  [...root.querySelectorAll("select:not([data-enhanced])")].forEach(select => {
    select.dataset.enhanced = "true";
    const ui = document.createElement("div");
    ui.className = "select-ui";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "select-menu";
    menu.role = "listbox";
    menu.hidden = true;
    select.before(ui);
    ui.append(select, trigger, menu);

    const sync = () => {
      trigger.textContent = select.options[select.selectedIndex]?.text || "";
      [...menu.children].forEach(option => option.setAttribute("aria-selected", String(option.dataset.value === select.value)));
    };
    [...select.options].forEach(option => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-option";
      item.role = "option";
      item.dataset.value = option.value;
      item.textContent = option.text;
      item.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        closeMenus();
        trigger.focus();
      });
      menu.append(item);
    });
    trigger.addEventListener("click", () => {
      const open = menu.hidden;
      closeMenus(open ? menu : null);
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    });
    trigger.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      (menu.querySelector("[aria-selected='true']") || menu.firstElementChild)?.focus();
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeMenus();
        trigger.focus();
      }
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const items = [...menu.children];
        const next = Math.max(0, Math.min(items.length - 1, items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1)));
        items[next]?.focus();
      }
    });
    select.addEventListener("change", sync);
    sync();
  });
}

function majorSearchMatches(query = "") {
  const needle = String(query).trim().toLocaleLowerCase();
  const rows = majorMaster.filter(item => !needle || [item.code, item.name, item.categoryName, item.className, ...(item.aliases || [])]
    .join(" ").toLocaleLowerCase().includes(needle));
  return rows.sort((a, b) => {
    const aExact = a.name.toLocaleLowerCase() === needle;
    const bExact = b.name.toLocaleLowerCase() === needle;
    return Number(bExact) - Number(aExact) || a.name.localeCompare(b.name, "zh-CN");
  }).slice(0, 40);
}

function renderMajorSearchOptions(query = "") {
  const options = $("#major-search-options");
  if (!options) return;
  const rows = majorSearchMatches(query);
  options.innerHTML = rows.length ? rows.map(item => `
    <button class="school-option major-option" type="button" data-major-code="${escapeHtml(item.code)}">
      <strong>${escapeHtml(item.name)}</strong>
      <span>${escapeHtml(item.categoryName)} · ${escapeHtml(item.className || "交叉专业")} · ${escapeHtml(item.code)}</span>
    </button>
  `).join("") : `<p class="school-empty">没有找到匹配专业，请尝试输入专业名称或专业代码。</p>`;
  options.hidden = false;
  $("#major-search")?.setAttribute("aria-expanded", "true");
}

function selectMajorMaster(item) {
  state.profile.major = item.field;
  state.profile.majorCode = item.code;
  state.profile.majorName = item.name;
  $("#major").value = item.field;
  $("#major-search").value = item.name;
  $("#major-search-options").hidden = true;
  $("#major-search").setAttribute("aria-expanded", "false");
  state.selectedCourses = defaultCourses(item.field);
  renderCourses();
  $("#course-note").textContent = `已根据${item.name}预选${item.categoryName}相关课程。取消没有学过的课程，只勾选实际修读的课程。`;
  saveState();
}

const normalizeSchoolName = value => String(value).trim().toLocaleLowerCase();
let remoteSchoolMatches = [];

const availableSchools = () => [...schools, ...remoteSchoolMatches].filter((school, index, rows) =>
  rows.findIndex(candidate => normalizeSchoolName(candidate.name) === normalizeSchoolName(school.name)) === index);

function findSchool(value) {
  const query = normalizeSchoolName(value);
  return availableSchools().find(school => [school.name, ...(school.aliases || [])].some(name => normalizeSchoolName(name) === query));
}

function paintSchoolOptions(query = "") {
  const normalizedQuery = normalizeSchoolName(query);
  const matches = availableSchools().filter(school => !normalizedQuery || [school.name, ...(school.aliases || [])]
    .some(name => normalizeSchoolName(name).includes(normalizedQuery))).slice(0, 8);
  $("#university-options").innerHTML = matches.map(school => `
    <button type="button" class="school-option" role="option" data-school="${escapeHtml(school.name)}">
      <strong>${escapeHtml(school.name)}</strong><span>${escapeHtml(school.aliases?.[0] || school.classification)}</span>
    </button>
  `).join("");
  $("#university-options").hidden = !matches.length;
  $("#university").setAttribute("aria-expanded", String(Boolean(matches.length)));
}

async function renderSchoolOptions(query = "") {
  paintSchoolOptions(query);
  if (String(query).trim().length < 2) return;
  try {
    const response = await fetch(`/api/institutions/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) return;
    const payload = await response.json();
    if ($("#university").value !== query) return;
    remoteSchoolMatches = (payload.results || []).map(item => ({
      name: item.nameZh || item.nameEn,
      aliases: [item.nameEn, item.aliases].filter(Boolean),
      classification: item.classification || "待主表分类",
      scoreTier: item.scoreTier,
      qs: null,
      arwu: null,
      source: item.source
    }));
    paintSchoolOptions(query);
  } catch {}
}

function renderSchoolMatch() {
  const school = findSchool($("#university").value);
  $("#school-tier").value = school?.scoreTier ?? "";
  if (!school) {
    $("#school-match").innerHTML = `<strong>暂未识别</strong><span>可继续填写；系统不会凭名称猜测985/211或排名。</span>`;
    return;
  }
  if (school.source === "ROR" && school.scoreTier == null) {
    $("#school-match").innerHTML = `<strong>全球院校身份已匹配</strong><span>来源 ROR；院校层次与排名尚未核验，因此不参与分层比较。</span>`;
    return;
  }
  $("#school-match").innerHTML = `
    <strong>${escapeHtml(school.classification)}</strong>
    <span>QS ${escapeHtml(school.qs || "待接入年度榜单")} · 软科/ARWU ${escapeHtml(school.arwu || "待接入年度榜单")}</span>
  `;
}

function setView(view) {
  if (view === "results" && !latestResults.length) return;
  $$("[data-view]").forEach(page => {
    const active = page.dataset.view === view;
    page.hidden = !active;
    page.classList.toggle("is-active", active);
  });
  $$("[data-view-target]").forEach(button => button.classList.toggle("is-active", button.dataset.viewTarget === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function hydrateAcademicForm() {
  Object.entries(state.profile).forEach(([name, value]) => {
    const control = $(`[name="${name}"]`);
    if (control) control.value = value;
  });
  $$("input[name='region']").forEach(input => { input.checked = state.regions.includes(input.value); });
  const allSchools = !state.targetSchools.length;
  $("#all-schools").checked = allSchools;
  $$('input[name="targetSchool"]').forEach(input => {
    if (input.id !== "all-schools") input.checked = !allSchools && state.targetSchools.includes(input.value);
  });
  const allFields = !state.fields.length;
  $("#all-fields").checked = allFields;
  $$("input[name='field']").forEach(input => {
    if (input.id !== "all-fields") input.checked = !allFields && state.fields.includes(input.value);
  });
  const majorRecord = majorMaster.find(item => item.code === state.profile.majorCode)
    || majorMaster.find(item => item.name === state.profile.majorName);
  $("#major-search").value = state.profile.majorName || majorRecord?.name || majorOptions.find(([key]) => key === state.profile.major)?.[1] || "";
  $("#additional-courses").value = state.additionalCourses || "";
  updateGpaControl(false);
  updateLanguageControl(false);
  renderSchoolMatch();
  syncTargetSchoolChoices();
}

function updateGpaControl(convertValue = true) {
  const scale = $("#gpa-scale").value;
  const input = $("#gpa-value");
  const config = {
    "100": { label: "加权平均分（推荐）", max: 100, help: "填写成绩单中的百分制加权平均分；系统不会把它简单除以25当作正式GPA。" },
    "4": { label: "四分制 GPA", max: 4, help: "同分制可比案例较少，分析效果不佳；如成绩单另有官方加权均分，建议填写加权均分。" },
    "5": { label: "五分制 GPA", max: 5, help: "同分制可比案例较少，分析效果不佳；不会把 3.5/5 换算成 70 分。如成绩单另有官方加权均分，建议填写加权均分。" }
  }[scale] || { label: "成绩", max: 100, help: "请选择成绩制式，并填写成绩单中的官方成绩。" };
  $("#gpa-label").textContent = config.label;
  $("#gpa-help").textContent = config.help;
  input.max = config.max;
  input.step = "0.01";
  if (convertValue) {
    const current = Number(input.value);
    input.value = Number.isFinite(current) && current >= 0 && current <= config.max ? current : "";
  }
  state.profile.gpaScale = scale;
}

function updateLanguageControl(convertValue = true) {
  const test = $("#language-test").value;
  const input = $("#language");
  const config = test === "TOEFL"
    ? { min: 0, max: 120, step: 1, fallback: 95 }
    : test === "IELTS"
      ? { min: 0, max: 9, step: .5 }
      : { min: 0, max: 120, step: 1 };
  input.min = config.min;
  input.max = config.max;
  input.step = config.step;
  if (convertValue) {
    const raw = String(input.value || "").trim();
    const current = Number(raw);
    if (!raw || !Number.isFinite(current) || current < config.min || current > config.max) input.value = "";
  }
  state.profile.languageTest = test;
}

function renderInternships() {
  $("#internship-list").innerHTML = state.internships.map((item, index) => `
    <div class="repeat-row">
      <div class="field"><label>公司层级</label><select data-list="internships" data-index="${index}" data-key="companyTier">${optionHtml(companyTierOptions, item.companyTier)}</select></div>
      <div class="field"><label>工作方向</label><select data-list="internships" data-index="${index}" data-key="direction">${optionHtml(directionOptions, item.direction)}</select></div>
      <button class="remove-button" type="button" data-remove="internships" data-index="${index}">删除</button>
    </div>
  `).join("");
}

function renderResearches() {
  $("#research-list").innerHTML = state.researches.map((item, index) => `
    <div class="repeat-row">
      <div class="field"><label>研究方向</label><select data-list="researches" data-index="${index}" data-key="direction">${optionHtml(directionOptions, item.direction)}</select></div>
      <div class="field"><label>参与形式</label><select data-list="researches" data-index="${index}" data-key="type">${optionHtml(researchTypeOptions, item.type)}</select></div>
      <button class="remove-button" type="button" data-remove="researches" data-index="${index}">删除</button>
    </div>
  `).join("");
}

function renderAwards() {
  $("#award-list").innerHTML = state.awards.map((item, index) => `
    <div class="repeat-row">
      <div class="field"><label>奖项层级</label><select data-list="awards" data-index="${index}" data-key="level">${optionHtml(awardLevelOptions, item.level)}</select></div>
      <div class="field"><label>比赛类别</label><select data-list="awards" data-index="${index}" data-key="category">${optionHtml(awardCategoryOptions, item.category)}</select></div>
      <button class="remove-button" type="button" data-remove="awards" data-index="${index}">删除</button>
    </div>
  `).join("");
}

function addRepeatItem(type) {
  if (type === "internship") state.internships.push(emptyInternship());
  if (type === "research") state.researches.push(emptyResearch());
  if (type === "award") state.awards.push(emptyAward());
  renderAllRepeatLists();
  saveState();
}

function renderCourses() {
  const major = $("#major")?.value || state.profile.major;
  const visibleGroups = courseGroups.map(group => ({
    ...group,
    courses: group.courses.filter(course => course.defaults.includes(major))
  })).filter(group => group.courses.length);
  $("#course-groups").innerHTML = visibleGroups.length ? visibleGroups.map(group => `
    <fieldset class="course-group">
      <legend>${escapeHtml(group.name)}</legend>
      ${group.courses.map(course => `
        <label class="course-row">
          <input type="checkbox" name="course" value="${escapeHtml(course.name)}" data-tag="${course.tag}" ${state.selectedCourses.includes(course.name) ? "checked" : ""}>
          <span>${escapeHtml(course.name)}</span>
        </label>
      `).join("")}
    </fieldset>
  `).join("") : `<p class="course-empty">该专业暂时没有预设课程，课程信息不会影响其他资料的填写。</p>`;
}

function syncRepeatListInputs() {
  $$('[data-list]').forEach(control => {
    const list = state[control.dataset.list];
    const item = list?.[Number(control.dataset.index)];
    if (item) item[control.dataset.key] = control.value;
  });
}

function collectProfile() {
  syncRepeatListInputs();
  const data = new FormData($("#application-form"));
  const gpaScale = String(data.get("gpaScale"));
  const gpaRaw = String(data.get("gpaValue") || "").trim();
  const gpaValue = gpaRaw ? Number(gpaRaw) : null;
  const school = findSchool(data.get("university"));
  return {
    university: String(data.get("university")).trim(),
    schoolTier: school?.scoreTier ?? null, schoolClassification: school?.classification ?? null, major: String(data.get("major")),
    majorCode: state.profile.majorCode || "", majorName: state.profile.majorName || $("#major-search").value.trim(),
    gpaScale, gpaValue,
    languageTest: String(data.get("languageTest") || ""),
    language: String(data.get("language") || "").trim() ? Number(data.get("language")) : null,
    internships: state.internships, researches: state.researches, awards: state.awards,
    courseNames: $$("input[name='course']:checked").map(input => input.value),
    courseTags: [...new Set($$("input[name='course']:checked").map(input => input.dataset.tag))],
    additionalCourses: String($("#additional-courses")?.value || "").trim()
  };
}

function filteredProgrammes() {
  return programmes
    .filter(programme => state.regions.includes(programme.region))
    .filter(programme => !state.targetSchools.length || state.targetSchools.includes(programme.university))
    .filter(programme => !state.fields.length || state.fields.some(field => programme.majorTags.includes(field)))
    .map(programme => ({ ...programme, cases: [] }));
}

const formatNumber = value => Number(value.toFixed(1));
const optionLabel = (options, value) => options.find(([key]) => key === value)?.[1] || value;

function position(value, min, max) {
  const padding = Math.max(1, (max - min) * 0.08);
  return ((value - (min - padding)) / (max - min + padding * 2)) * 100;
}

function gpaEvidence(result) {
  const stats = result.evidence.gpa;
  const percent = stats.scale === "985_EQUIVALENT_PERCENT";
  const scoreName = percent ? "985基准比较分" : stats.scale === "GPA_5" ? "五分制 GPA"
    : stats.scale === "GPA_4_3" ? "4.3分制 GPA" : "四分制 GPA";
  if (!stats.available) {
    return `
      <div class="evidence-block gpa-evidence">
        <h3>GPA案例位置</h3>
        <p>${escapeHtml(stats.note || "当前没有同分制的审核案例，因此不显示容易误导的GPA分布。")}</p>
      </div>
    `;
  }
  const domainMin = Math.min(stats.min, stats.user);
  const domainMax = Math.max(stats.max, stats.user);
  const sameTier = stats.sameTier
    ? `同层案例 ${stats.sameTierCount} 个，${scoreName}中位数 ${formatNumber(stats.sameTier.median)}，范围 ${formatNumber(stats.sameTier.min)}–${formatNumber(stats.sameTier.max)}。`
    : "当前没有同院校层次且同分制案例，暂不单独展示同层参照。";
  const positionText = stats.positionNote && stats.total < 5
    ? stats.positionNote
    : stats.user > stats.max
    ? `你的${scoreName}高于当前最高案例 ${formatNumber(stats.user - stats.max)}。`
    : stats.user < stats.min
      ? `你的${scoreName}低于当前最低案例 ${formatNumber(stats.min - stats.user)}；公开成功案例最低分不是项目官方录取门槛。`
      : `按 ${stats.total} 条同分制可比成功案例的分数排序，你的${scoreName}若插入，约位于第 ${stats.rank} 位。`;
  return `
    <div class="evidence-block gpa-evidence">
      <h3>${scoreName}与案例参照</h3>
      <div class="range-plot" aria-label="你的${scoreName}与录取案例分布">
        <div class="range-line">
          <i class="case-range" style="left:${position(stats.min, domainMin, domainMax)}%;width:${position(stats.max, domainMin, domainMax) - position(stats.min, domainMin, domainMax)}%"></i>
          <i class="stat-tick median-tick" style="left:${position(stats.median, domainMin, domainMax)}%" title="中位数 ${formatNumber(stats.median)}"></i>
          <i class="stat-tick mean-tick" style="left:${position(stats.mean, domainMin, domainMax)}%" title="平均数 ${formatNumber(stats.mean)}"></i>
          <i class="user-point" style="left:${position(stats.user, domainMin, domainMax)}%" title="你的${scoreName} ${formatNumber(stats.user)}"></i>
        </div>
      </div>
      <dl class="stat-row">
        <div><dt>最低</dt><dd>${formatNumber(stats.min)}</dd></div>
        <div><dt>平均</dt><dd>${formatNumber(stats.mean)}</dd></div>
        <div><dt>中位</dt><dd>${formatNumber(stats.median)}</dd></div>
        <div><dt>最高</dt><dd>${formatNumber(stats.max)}</dd></div>
        <div class="is-user"><dt>你的${percent ? "比较分" : "GPA"}</dt><dd>${formatNumber(stats.user)}</dd></div>
      </dl>
      <p>${positionText}</p><p>${sameTier}</p>
      <p>${escapeHtml(stats.normalization?.note || "")}</p>
    </div>
  `;
}

function languageEvidence(result) {
  const stats = result.evidence.language;
  if (!stats.available) {
    return `
      <div class="evidence-block language-evidence">
        <h3>语言成绩位置</h3>
        <p>当前没有与申请人相同考试类型的审核案例，因此不显示语言分布。</p>
      </div>
    `;
  }
  const domainValues = [stats.min, stats.user, stats.required].filter(Number.isFinite);
  const domainMin = Math.min(...domainValues);
  const domainMax = Math.max(stats.max, ...domainValues);
  const requiredTick = Number.isFinite(stats.required)
    ? `<i class="stat-tick required-tick" style="left:${position(stats.required, domainMin, domainMax)}%" title="项目参考线 ${formatNumber(stats.required)}"></i>` : "";
  const requirementText = Number.isFinite(stats.required)
    ? `项目总分参考线 ${formatNumber(stats.required)}，你的总分${stats.user >= stats.required ? "已经达到" : "尚未达到"}；当前版本不判断单项分数。`
    : `当前项目资料库尚未录入${escapeHtml(stats.test)}对应的官方参考线。`;
  return `
    <div class="evidence-block language-evidence">
      <h3>语言成绩位置</h3>
      <div class="range-plot" aria-label="你的${escapeHtml(stats.test)}与录取案例分布">
        <div class="range-line">
          <i class="case-range" style="left:${position(stats.min, domainMin, domainMax)}%;width:${position(stats.max, domainMin, domainMax) - position(stats.min, domainMin, domainMax)}%"></i>
          <i class="stat-tick median-tick" style="left:${position(stats.median, domainMin, domainMax)}%" title="中位数 ${formatNumber(stats.median)}"></i>
          <i class="stat-tick mean-tick" style="left:${position(stats.mean, domainMin, domainMax)}%" title="平均数 ${formatNumber(stats.mean)}"></i>
          ${requiredTick}
          <i class="user-point" style="left:${position(stats.user, domainMin, domainMax)}%" title="你的${escapeHtml(stats.test)} ${formatNumber(stats.user)}"></i>
        </div>
      </div>
      <dl class="stat-row">
        <div><dt>最低</dt><dd>${formatNumber(stats.min)}</dd></div>
        <div><dt>平均</dt><dd>${formatNumber(stats.mean)}</dd></div>
        <div><dt>中位</dt><dd>${formatNumber(stats.median)}</dd></div>
        <div><dt>最高</dt><dd>${formatNumber(stats.max)}</dd></div>
        <div class="is-user"><dt>你的${escapeHtml(stats.test)}</dt><dd>${formatNumber(stats.user)}</dd></div>
      </dl>
      <p>${requirementText}</p>
    </div>
  `;
}

function evidenceSummary(result) {
  return `
    ${gpaEvidence(result)}
    ${languageEvidence(result)}
  `;
}

function profileForApi(profile) {
  return {
    ...profile,
    major: profile.major,
    internships: profile.internships.map(item => ({
      ...item,
      companyTier: optionLabel(companyTierOptions, item.companyTier),
      direction: optionLabel(directionOptions, item.direction)
    })),
    researches: profile.researches.map(item => ({
      ...item,
      direction: optionLabel(directionOptions, item.direction),
      type: optionLabel(researchTypeOptions, item.type),
      output: optionLabel(researchOutputOptions, item.output)
    })),
    awards: profile.awards.map(item => ({
      ...item,
      level: optionLabel(awardLevelOptions, item.level),
      category: optionLabel(awardCategoryOptions, item.category)
    }))
  };
}

const hiddenPublicCaseFingerprints = new Set(["a514c36aa5a4a1fd62c8"]);

function caseDetails(item) {
  if (!item || hiddenPublicCaseFingerprints.has(item.fingerprint)) return `<p>目前没有需要展示的公开案例。</p>`;
  const summary = key => {
    const value = item.experienceSummary?.[key];
    const count = Number(value?.count || 0);
    return count ? `约${count}段 · ${value?.level || "一般"}` : "页面未提供";
  };
  const disclosureFields = [
    ["实习经历", summary("internships")],
    ["科研经历", summary("research")],
    ["项目经历", summary("projects")],
    ["竞赛与奖项", summary("competitions")],
    ["专利成果", summary("patents")]
  ];
  const hasDisclosure = disclosureFields.some(([, value]) => value !== "页面未提供");
  return `
    <details class="case-detail">
      <summary>
        <span>${item.cycle} · ${escapeHtml(item.school)} · ${escapeHtml(item.major)}</span>
        <span>GPA ${escapeHtml(item.gpaRaw || "未披露")} · ${escapeHtml(item.languageTest || "语言")} ${item.language ?? "未披露"}</span>
        <em>${hasDisclosure ? "查看经历摘要" : "仅公开成绩字段"}</em>
      </summary>
      <div class="case-background">
        <dl><dt>成绩</dt><dd>GPA ${escapeHtml(item.gpaRaw || "未披露")} · ${escapeHtml(item.languageTest || "语言")} ${item.language ?? "未披露"}</dd></dl>
        ${disclosureFields.map(([label, value]) => `<dl><dt>${label}</dt><dd>${escapeHtml(value)}</dd></dl>`).join("")}
      </div>
    </details>
  `;
}

function renderProgrammeDetail(programme) {
  const text = (value, fallback = "暂无资料") => escapeHtml(value || fallback);
  const detail = (field, value, fallback) => {
    const provenance = programme._programmeProvenance?.[field];
    const badge = provenance === "derived-ai" || provenance === "derived"
      ? `<small class="programme-provenance">AI基于官方项目资料推断</small>`
      : provenance === "official-structured-snapshot"
        ? `<small class="programme-provenance">本地官方资料结构化快照（${escapeHtml(programme._programmeEvidenceSnapshot || "日期未记录")}）；未复核当前官网</small>`
        : "";
    return `<p>${text(value, fallback)}${badge}</p>`;
  };
  const positioning = [programme.overview, programme.duration].filter(Boolean).join(" ");
  const curriculum = programme.curriculumStructure || programme.courseOrientation;
  const officialLink = programme.officialUrl
    ? `<a href="${escapeHtml(programme.officialUrl)}" target="_blank" rel="noreferrer">官方页面</a>`
    : "暂无官方页面链接";
  const curriculumLink = programme.curriculumUrl
    ? `<a href="${escapeHtml(programme.curriculumUrl)}" target="_blank" rel="noreferrer">官方页面</a>`
    : "暂无课程页面链接";
  return `
    <h3>项目要求</h3>
    ${detail("requirements", programme.officialNote, "官方项目要求尚未从本地项目卡片核验，请以学校官网为准。")}
    <h3>项目定位与学制</h3>
    ${detail("positioning", positioning, "官方项目定位与学制尚未补齐。")}
    <h3>课程结构与取向</h3>
    ${detail("curriculum", curriculum, "官方课程结构尚未补齐。")}
    ${programme.courseOrientation && programme.courseOrientation !== curriculum ? detail("orientation", programme.courseOrientation, "") : ""}
    <h3>可使用的项目与院校资源</h3>
    ${detail("resources", programme.resources, "官方资料暂未核验到具体院系、实验室或行业资源。")}
    <h3>就业与发展</h3>
    ${detail("career", programme.career, "官方资料暂未给出就业说明，不能把推测当成学校承诺。")}
    <h3>与相近项目的区别</h3>
    ${detail("comparison", programme.differentiators, "尚未完成与相近项目的结构化比较。")}
    <p class="source-links">申请要求：${officialLink} · 课程结构：${curriculumLink}</p>
  `;
}

function assessmentFailureText(error) {
  const message = String(error || "");
  if (/too many requests|concurrency|rate limit/i.test(message)) return "模型服务并发受限，本项目未完成；请稍后重新分析。";
  if (/证据契约校验/.test(message)) return "模型返回内容未通过证据校验，因此不显示数值。";
  if (/超时|timeout/i.test(message)) return "模型请求超时，本项目未完成；请稍后重新分析。";
  return message ? "模型调用或输出校验未完成，因此不显示数值。" : "模型未返回可用判断，因此不显示数值。";
}

function renderAssessmentReview(insight) {
  const reasoning = Array.isArray(insight.reasoning) ? insight.reasoning : [];
  const uncertainties = Array.isArray(insight.uncertainties) ? insight.uncertainties : [];
  const sources = new Map((insight.reviewEvidence || []).map(item => [String(item.id), item]));
  const citations = Array.isArray(insight.evidenceUsed) ? insight.evidenceUsed : [];
  const show = value => escapeHtml(readableEvidenceIds(value));
  const provenanceLabel = value => value === "public-case" ? "本地案例摘要"
    : value === "catalogue-card" ? "项目目录卡片"
      : String(value).startsWith("derived") ? "未核验的项目方向推断" : "本地项目资料快照";
  return `<div class="assessment-reasoning">
    <h4>判断依据与待核对项</h4>
    <p class="personalized-status">以下依据来自本机记录，可展开核对；本次未实时联网。未核验的推断不能当作官方要求。</p>
    <h5>模型判断理由</h5>
    ${reasoning.length ? `<ul>${reasoning.map(item => `<li>${show(item)}</li>`).join("")}</ul>` : `<p class="personalized-status">模型未留下可展示的判断理由。</p>`}
    <h5>分析依据</h5>
    ${citations.length ? citations.map(item => {
      const source = sources.get(String(item.documentId));
      return `<div class="assessment-citation">
        <p><strong>${source ? provenanceLabel(source.provenance) : "引用依据未保存"}</strong></p>
        <p>${show(item.comparison || "模型未说明如何使用这项依据")}${item.missing ? " · 信息有缺口" : ""}</p>
        ${source ? `<details class="assessment-source"><summary>查看依据原文</summary><p>${show(source.text || "暂无文字")}</p>${source.checkedAt ? `<small>资料记录日期：${escapeHtml(String(source.checkedAt).slice(0, 10))}</small>` : ""}</details>` : `<p class="personalized-status">这份旧记录没有保存可供核对的依据；请重新分析或查看项目资料。</p>`}
      </div>`;
    }).join("") : `<p class="personalized-status">模型未留下逐条引用，不能据此验收事实准确性。</p>`}
    <h5>模型列出的不确定性</h5>
    ${uncertainties.length ? `<ul>${uncertainties.map(item => `<li>${show(item)}</li>`).join("")}</ul>` : `<p class="personalized-status">模型未列出；不等于没有风险。请对照官方页面复核申请条件。</p>`}
  </div>`;
}

function renderResults(profile, results = analyzeAll(profile, filteredProgrammes()), insights = {}, analysisNote = "", calibrationValid = false) {
  latestProfile = profile;
  latestCalibrationValid = calibrationValid;
  personalizedInsights = { insights };
  latestResults = [...results].sort((left, right) => {
    const leftReady = left.result?.assessmentAvailable && Number.isFinite(left.result.center);
    const rightReady = right.result?.assessmentAvailable && Number.isFinite(right.result.center);
    return Number(rightReady) - Number(leftReady) || Number(right.result?.center || 0) - Number(left.result?.center || 0);
  });
  const comparison = buildComparison(latestResults);
  const hasAssessment = latestResults.some(item => item.result.assessmentAvailable);
  const standardized = standardizeGpa(profile);
  const scoreLabel = standardized.rawScale === "100" ? "百分制" : standardized.rawScale === "4" ? "4.0 GPA" : standardized.rawScale === "5" ? "5.0 GPA" : "成绩";
  $("#results-subtitle").textContent = `${profile.university} · ${profile.gpaValue}/${scoreLabel} · ${profile.languageTest} ${profile.language}${hasAssessment ? " · 已生成申请评估" : " · 分析未完成"}`;
  $("[data-view-target='results']").disabled = false;
  $("#survey-form").hidden = state.surveyCompleted || !latestAnalysisId;
  $("#feedback-saved").hidden = !state.surveyCompleted;
  $("#download-panel").hidden = false;
  $(".result-note").textContent = `公开案例只有成功样本，模型数值未经统计校准，不是真实录取率。${analysisNote || "请先看项目要求、相似案例及信息缺口。"}`;
  $("#comparison-summary").innerHTML = `
    <h2>数值依据</h2>
    <p>你的申请资料 + 本地项目资料（部分项目仅有目录信息或未核验推断）+ 本地审核成功案例统计及最多 6 条代表案例，由你配置的模型综合分析。本次分析不会实时浏览学校官网。</p>
    <p>${comparison.total ? `已有 ${comparison.total} 个项目获得模型参考值，${latestCalibrationValid ? '按模型横向排序展示（仅通过格式与部分证据边界检查）' : '仅按单项目估计值从高到低展示，横向排序未通过校验'}；无数值项目置于末尾。` : "本次没有项目获得通过校验的模型参考值。"}百分比未经成功与失败样本校准，不是真实录取率。</p>`;

  $("#results-list").innerHTML = latestResults.map(({ programme, result, assessmentError }, index) => {
    const position = comparison.byId.get(programme.id);
    const hasAssessment = Boolean(position);
    const caseCount = Number(programme.caseCount ?? result.evidence?.caseCount ?? programme.cases?.length ?? 0);
    const evidenceLabel = caseCount === 0 ? "没有公开案例，判断依据有限" : caseCount < 5
      ? `仅 ${caseCount} 条成功案例，判断依据有限` : `${caseCount} 条公开成功案例`;
    const fitClue = insights[programme.id]?.fit?.find(item => typeof item === "string" && item.trim());
    return `
    <article class="programme-record">
      <header class="programme-heading">
        <div class="programme-name">
          <span>${String(index + 1).padStart(2, "0")} · ${programme.region} · ${programme.school}</span>
          <h2>${escapeHtml(programme.nameZh)}</h2>
          <p>${escapeHtml(programme.name)}</p>
        </div>
        <div class="probability">
          <span>模型机会参考 · 未经统计校准</span>
          <strong>${hasAssessment ? `${result.center}%` : "暂无数值"}</strong>
          ${hasAssessment ? `<span>参考范围 ${result.low}%–${result.high}% · ${latestCalibrationValid && position.total > 1 ? `相对第 ${position.rank}/${position.total}` : position.total > 1 ? '横向排序未通过校验' : "仅 1 个项目，无法排序"}</span>` : ""}
          <em>${evidenceLabel}</em>
          <p class="experimental-value">${hasAssessment ? "模型估计，非真实录取率；请核对官方申请条件。" : escapeHtml(assessmentFailureText(assessmentError))}</p>
          ${hasAssessment && fitClue ? `<p class="result-rationale">匹配线索：${escapeHtml(readableEvidenceIds(fitClue))}</p>` : ""}
        </div>
      </header>
      <details class="analysis-detail">
        <summary>展开案例参照与项目分析</summary>
        <div class="analysis-body">
          <section class="evidence-profile">
            <h2>案例数据参照</h2>
            ${evidenceSummary(result)}
          </section>
          <section class="programme-profile">
            ${renderProgrammeDetail(programme)}
          </section>
        </div>
        <section class="personalized-section" data-personalized="${programme.id}">
          <h3>你的个性化分析</h3>
          ${hasAssessment && insights[programme.id]
            ? `${renderAssessmentReview(insights[programme.id])}<div class="personalized-grid">
                <div><h4>匹配点与已知劣势</h4><ul>${(insights[programme.id].fit || []).map(item => `<li>${escapeHtml(readableEvidenceIds(item))}</li>`).join("")}</ul></div>
                <div><h4>PS / CV怎么写</h4><ul>${(insights[programme.id].psCv || []).map(item => `<li>${escapeHtml(readableEvidenceIds(item))}</li>`).join("")}</ul></div>
              </div>`
            : `<p class="personalized-status">本项目未通过模型输出校验，或本次调用未完成；无法提供可靠的个性化分析。仍可查看项目资料与公开案例。</p>`}
        </section>
        <section class="nearest-case">
          <h3>最接近的录取案例</h3>
          ${caseDetails(result.nearest, 0)}
        </section>
        <section class="case-list">
          <h3>已收录的公开案例</h3>
          <p>案例仅展示申请分析所需字段和经历披露情况；完整经历原文与逐条来源仅保留在内部审核记录中。</p>
           ${programme.cases.filter(item => !hiddenPublicCaseFingerprints.has(item.fingerprint)).length
             ? programme.cases.filter(item => !hiddenPublicCaseFingerprints.has(item.fingerprint)).map(caseDetails).join("")
             : "<p>当前没有需要展示的公开案例；系统仍会根据官方项目资料和申请人背景独立分析，但判断区间会更宽。</p>"}
        </section>
      </details>
    </article>
  `;
  }).join("");
}

const processingCopy = {
  profile: ["正在核对申请背景", "验证成绩、课程与经历信息。"],
  rag: ["正在检索项目与案例库", "读取目标地区、官方项目资料与近五年公开案例。"],
  evidence: ["正在整理案例证据", "汇总GPA、语言、院校与公开经历，不使用人工概率公式。"],
  ai: ["正在生成项目判断", "调用你配置的模型，结合项目资料和案例证据分析。"],
  archive: ["正在整理申请评估", "按项目判断整理结果。"]
};

function updateProcessing(stage, progress, statusOverride = "") {
  const [title, status] = processingCopy[stage];
  $("#processing-title").textContent = title;
  $("#processing-status").textContent = statusOverride || status;
  $("#progress-bar").style.width = `${progress}%`;
  const track = $(".progress-track");
  track.setAttribute("aria-valuenow", String(progress));
  const order = Object.keys(processingCopy);
  $$(".processing-stages li").forEach(item => {
    const itemIndex = order.indexOf(item.dataset.stage);
    const stageIndex = order.indexOf(stage);
    item.classList.toggle("is-active", itemIndex === stageIndex);
    item.classList.toggle("is-complete", itemIndex < stageIndex);
  });
}

const briefPause = (milliseconds = 180) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function runAnalysis(profile) {
  setView("processing");
  $("#processing-note").textContent = "本机读取案例和项目资料；申请资料会发送给你配置的模型服务商。";
  updateProcessing("profile", 8);
  await briefPause();

  updateProcessing("rag", 27);
  const selectedProgrammes = filteredProgrammes();
  await briefPause();

  updateProcessing("evidence", 52);
  const localResults = analyzeAll(profile, selectedProgrammes);
  await briefPause();

  updateProcessing("ai", 70);
  let results = localResults;
  let insights = {};
  let analysisNote = "";
  let calibrationValid = false;
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, profileText: profileForApi(profile), regions: state.regions, targetSchools: state.targetSchools, fields: state.fields, consent: true })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "分析服务暂不可用");
    const data = await response.json();
    latestAnalysisId = data.analysisId || null;
    results = data.results?.length ? data.results : localResults;
    insights = data.insights || {};
    calibrationValid = data.assessmentExecution?.calibrationValid === true;
    analysisNote = data.message || "已完成项目与案例检索，并由AI基于检索证据生成项目判断。结果不代表学校承诺。";
  } catch (error) {
    latestAnalysisId = null;
    analysisNote = `分析未完成：${error.message}。本页只展示项目资料和案例分布，不生成模型数值。`;
    $("#processing-note").textContent = analysisNote;
  }

  updateProcessing("archive", 92);
  await briefPause(220);
  renderResults(profile, results, insights, analysisNote, calibrationValid);
  updateProcessing("archive", 100, "申请评估已整理。正在打开结果。");
  await briefPause(120);
  setView("results");
}

function downloadReport() {
  const format = $("#export-format").value;
  const profile = collectProfile();
  const comparison = buildComparison(latestResults);
  const rows = latestResults.map(({ programme, result, assessmentError }) => {
    const insight = personalizedInsights.insights?.[programme.id] || {};
    const sources = new Map((insight.reviewEvidence || []).map(item => [String(item.id), item]));
    const show = value => readableEvidenceIds(value);
    return {
      project: `${programme.university} ${programme.nameZh}`,
      assessment: comparison.byId.has(programme.id)
        ? `模型参考值 ${result.center}%（范围 ${result.low}%–${result.high}%；${latestCalibrationValid && comparison.total > 1 ? `相对第 ${comparison.byId.get(programme.id).rank}/${comparison.total}` : comparison.total > 1 ? '横向排序未通过校验，仅按单项目估计值展示' : "仅1个项目，无法排序"}；未经校准，非真实录取率）`
        : `未生成模型数值：${assessmentFailureText(assessmentError)}`,
      fit: insight.fit?.map(show).join("；") || "个性化分析API未生成",
      psCv: insight.psCv?.map(show).join("；") || "个性化分析API未生成",
      reasoning: insight.reasoning?.map(show).join("；") || "未保存模型判断理由",
      citations: (insight.evidenceUsed || []).map(item => {
        const source = sources.get(String(item.documentId));
        return `${show(item.comparison || "模型未说明如何使用这项依据")}；${source ? `${source.provenance === "public-case" ? "本地案例摘要" : source.provenance === "catalogue-card" ? "项目目录卡片" : String(source.provenance).startsWith("derived") ? "未核验的项目方向推断" : "本地项目资料快照"}：${show(String(source.text || "").replace(/\s+/g, " "))}` : "本次未保存对应依据"}`;
      }).join("；") || "未保存模型引用",
      uncertainties: insight.uncertainties?.map(show).join("；") || "模型未列出，不等于没有风险",
      url: programme.officialUrl
    };
  });
  let content;
  let type;
  if (format === "csv") {
    const escapeCsv = value => `"${String(value).replaceAll('"', '""')}"`;
    content = ["项目,申请评估,个性化匹配点,PS与CV建议,模型判断理由,引用与本地资料,模型列出的不确定性,官方网址", ...rows.map(row => Object.values(row).map(escapeCsv).join(","))].join("\n");
    type = "text/csv;charset=utf-8";
  } else if (format === "md") {
    content = [`# 申请评估`, ``, `公开案例只有成功样本；实验性 AI 数值未经校准，不是真实录取率。`, ``, `${profile.university}，GPA ${profile.gpaValue}/${profile.gpaScale}制，${profile.languageTest} ${profile.language}`, ``];
    rows.forEach((row, index) => content.push(`## ${index + 1}. ${row.project}`, ``, `- 申请评估：${row.assessment}`, `- 个性化匹配点：${row.fit}`, `- PS / CV建议：${row.psCv}`, `- 模型判断理由：${row.reasoning}`, `- 引用与本地资料：${row.citations}`, `- 模型列出的不确定性：${row.uncertainties}`, `- 官方网址：${row.url}`, ``));
    content = content.join("\n");
    type = "text/markdown;charset=utf-8";
  } else {
    content = [`申请评估`, `公开案例只有成功样本；实验性 AI 数值未经校准，不是真实录取率。`, `${profile.university} / GPA ${profile.gpaValue}/${profile.gpaScale}制 / ${profile.languageTest} ${profile.language}`, ``];
    rows.forEach((row, index) => content.push(`${index + 1}. ${row.project}`, `申请评估：${row.assessment}`, `个性化匹配点：${row.fit}`, `PS / CV建议：${row.psCv}`, `模型判断理由：${row.reasoning}`, `引用与本地资料：${row.citations}`, `模型列出的不确定性：${row.uncertainties}`, `官方网址：${row.url}`, ``));
    content = content.join("\n");
    type = "text/plain;charset=utf-8";
  }
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `申请评估.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}

$("#application-form").addEventListener("submit", async event => {
  event.preventDefault();
  state.regions = $$("input[name='region']:checked").map(input => input.value);
  const allSchools = $("#all-schools")?.checked;
  state.targetSchools = allSchools ? [] : $$("input[name='targetSchool']:checked").map(input => input.value);
  const allFields = $("#all-fields")?.checked;
  state.fields = allFields ? [] : $$("input[name='field']:checked").map(input => input.value);
  if (!event.currentTarget.reportValidity() || !state.regions.length || (!allSchools && !state.targetSchools.length) || (!allFields && !state.fields.length)) {
    $("#form-error").hidden = false;
    return;
  }
  $("#form-error").hidden = true;
  state.selectedCourses = $$("input[name='course']:checked").map(input => input.value);
  const profile = collectProfile();
  state.additionalCourses = profile.additionalCourses;
  state.surveyCompleted = false;
  state.survey = null;
  state.profile = { university: profile.university, schoolTier: profile.schoolTier, schoolClassification: profile.schoolClassification, major: profile.major, majorCode: profile.majorCode, majorName: profile.majorName, gpaScale: profile.gpaScale, gpaValue: profile.gpaValue, languageTest: profile.languageTest, language: profile.language };
  saveState();
  await runAnalysis(profile);
});

$("#all-fields")?.addEventListener("change", event => {
  if (!event.currentTarget.checked) return;
  $$('input[name="field"]').forEach(input => {
    if (input.id !== "all-fields") input.checked = false;
  });
});

$("#all-schools")?.addEventListener("change", event => {
  if (!event.currentTarget.checked) return;
  $$('input[name="targetSchool"]').forEach(input => {
    if (input.id !== "all-schools") input.checked = false;
  });
});

$$('input[name="region"]').forEach(input => input.addEventListener("change", syncTargetSchoolChoices));

$$('input[name="targetSchool"]').filter(input => input.id !== "all-schools").forEach(input => {
  input.addEventListener("change", () => {
    if (input.checked) {
      $("#all-schools").checked = false;
    } else if (!$$('input[name="targetSchool"]:checked').some(item => item.id !== "all-schools")) {
      $("#all-schools").checked = true;
    }
  });
});

  $$('input[name="field"]').filter(input => input.id !== "all-fields").forEach(input => {
  input.addEventListener("change", () => {
    if (input.checked) {
      $("#all-fields").checked = false;
    } else if (!$$('input[name="field"]:checked').some(item => item.id !== "all-fields")) {
      $("#all-fields").checked = true;
    }
  });
});

document.addEventListener("click", event => {
  const schoolOption = event.target.closest("[data-school]");
  if (schoolOption) {
    $("#university").value = schoolOption.dataset.school;
    closeMenus();
    renderSchoolMatch();
  } else if (!event.target.closest(".select-ui, .school-combobox, .major-combobox")) {
    closeMenus();
  }

  const viewButton = event.target.closest("[data-view-target]");
  if (viewButton) setView(viewButton.dataset.viewTarget);

  const removeButton = event.target.closest("[data-remove]");
  if (removeButton && !removeButton.disabled) {
    state[removeButton.dataset.remove].splice(Number(removeButton.dataset.index), 1);
    renderAllRepeatLists();
    saveState();
  }
});

document.addEventListener("change", event => {
  const control = event.target.closest("[data-list]");
  if (control) {
    state[control.dataset.list][Number(control.dataset.index)][control.dataset.key] = control.value;
    saveState();
  }
});

$("#gpa-scale").addEventListener("change", () => updateGpaControl(true));
$("#language-test").addEventListener("change", () => updateLanguageControl(true));
$("#university").addEventListener("input", event => {
  renderSchoolOptions(event.target.value);
  renderSchoolMatch();
});
$("#university").addEventListener("focus", event => renderSchoolOptions(event.target.value));
$("#university").addEventListener("change", renderSchoolMatch);
$("#university").addEventListener("keydown", event => {
  const firstOption = $("#university-options .school-option");
  if (event.key === "ArrowDown" && firstOption) {
    event.preventDefault();
    firstOption.focus();
  }
  if (event.key === "Escape") closeMenus();
});
$("#university-options").addEventListener("keydown", event => {
  const options = $$("#university-options .school-option");
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const next = Math.max(0, Math.min(options.length - 1, options.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1)));
    options[next]?.focus();
  }
  if (event.key === "Escape") {
    closeMenus();
    $("#university").focus();
  }
});
const majorSearch = $("#major-search");
const majorSearchOptions = $("#major-search-options");
const openMajorSearch = event => {
  event.stopPropagation();
  closeMenus(majorSearchOptions);
  renderMajorSearchOptions(majorSearch.value);
};
majorSearch.addEventListener("input", openMajorSearch);
majorSearch.addEventListener("focus", openMajorSearch);
majorSearch.addEventListener("click", openMajorSearch);
majorSearch.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    (majorSearchOptions.querySelector("[data-major-code]") || majorSearchOptions.firstElementChild)?.focus();
  }
  if (event.key === "Escape") {
    closeMenus();
    majorSearch.focus();
  }
});
majorSearchOptions.addEventListener("click", event => {
  event.stopPropagation();
  const option = event.target.closest("[data-major-code]");
  if (!option) return;
  const major = majorMaster.find(item => item.code === option.dataset.majorCode);
  if (major) selectMajorMaster(major);
});
$("#survey-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const answers = new FormData(event.currentTarget);
  const survey = Object.fromEntries(answers.entries());
  const status = $("#survey-status");
  status.hidden = true;
  try {
    if (!latestAnalysisId) throw new Error("本次分析没有可关联的记录，请重新生成档案");
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId: latestAnalysisId, ...survey })
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "问卷提交失败");
    state.survey = survey;
    state.surveyCompleted = true;
    saveState();
    event.currentTarget.hidden = true;
    $("#feedback-saved").hidden = false;
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
  }
});
$("#download-report").addEventListener("click", downloadReport);

function renderAllRepeatLists() {
  renderInternships(); renderResearches(); renderAwards();
  enhanceSelects($("#application-form"));
}

hydrateAcademicForm();
renderAllRepeatLists();
renderCourses();
enhanceSelects();
$("#application-form").querySelectorAll("[data-add]").forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    addRepeatItem(button.dataset.add);
  });
});
