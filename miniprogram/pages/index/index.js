const { request } = require('../../utils/api');

const gpaScales = ['百分制', '4.0 GPA', '5.0 GPA'];
const languageTests = ['IELTS', 'TOEFL'];

const regionOptions = [
  { value: '香港', label: '香港' },
  { value: '新加坡', label: '新加坡' }
];

const schoolOptions = [
  { value: '香港大学', label: '香港大学', region: '香港' },
  { value: '香港中文大学', label: '香港中文大学', region: '香港' },
  { value: '香港科技大学', label: '香港科技大学', region: '香港' },
  { value: '香港理工大学', label: '香港理工大学', region: '香港' },
  { value: '香港城市大学', label: '香港城市大学', region: '香港' },
  { value: '香港浸会大学', label: '香港浸会大学', region: '香港' },
  { value: '岭南大学', label: '岭南大学', region: '香港' },
  { value: '香港教育大学', label: '香港教育大学', region: '香港' },
  { value: '新加坡国立大学', label: '新加坡国立大学', region: '新加坡' },
  { value: '南洋理工大学', label: '南洋理工大学', region: '新加坡' }
];

// Keep this list aligned with the web application. Empty selection means all directions.
const directionOptions = [
  ['automation', '自动化 / PLC / 控制'], ['control', '控制工程'], ['electrical', '电气 / 电力'],
  ['electronic', '电子 / 嵌入式 / 芯片'], ['communication', '通信 / 信号'],
  ['ai', '人工智能 / 数据'], ['computer', '软件 / 计算机'],
  ['mechanical', '机械 / 智能制造'], ['civil', '土木 / 建造'],
  ['robotics', '机器人'], ['data', '数据科学 / 分析'], ['software', '软件工程'],
  ['iot', '物联网'], ['network', '网络'], ['cloud', '云计算'], ['signal', '信号处理'],
  ['integrated-circuit', '集成电路'], ['semiconductor', '半导体'], ['manufacturing', '智能制造'],
  ['chemical', '化学工程'], ['biomedical', '生物医学'], ['healthcare', '健康 / 医疗'],
  ['materials', '材料 / 纳米'], ['biology', '生物 / 生命科学'], ['biotechnology', '生物技术'],
  ['medicine', '医学 / 临床'], ['pharmacy', '医药 / 药学'], ['public-health', '公共卫生'],
  ['food-nutrition', '食品 / 营养'], ['psychology', '心理 / 行为科学'],
  ['environmental', '环境'], ['energy', '能源'], ['power', '电力系统'],
  ['mathematics', '数学 / 统计'], ['physics', '物理'], ['optoelectronics', '光电 / 光学'],
  ['instrumentation', '仪器仪表'], ['railway', '轨道交通'], ['architecture', '建筑 / 城市规划'],
  ['business', '商业 / 管理'], ['finance', '金融'], ['accounting', '会计 / 审计'],
  ['economics', '经济学'], ['operations', '产品 / 运营 / 供应链'], ['marketing', '市场 / 营销'],
  ['law', '法律'], ['education', '教育'], ['media', '传媒 / 新闻'], ['design', '设计 / 艺术'],
  ['public-policy', '公共政策 / 公共管理'], ['social-science', '社会科学'],
  ['humanities', '语言 / 人文'], ['other', '其他 / 未分类项目']
];

const majorFieldLabels = {};
directionOptions.forEach(([value, label]) => { majorFieldLabels[value] = label; });
const fieldOptions = directionOptions.map(([value, label]) => ({ value, label }));

const optionList = (placeholder, options) => [
  { value: '', label: placeholder },
  ...options.map(([value, label]) => ({ value, label }))
];
const awardLevelOptions = optionList('请选择奖项级别', [
  ['international', '国际级'], ['national', '国家级'], ['provincial', '省级'], ['school', '校级']
]);
const awardCategoryOptions = optionList('请选择竞赛方向', [
  ['modeling', '数学建模'], ['electronic', '电子设计竞赛'], ['innovation', '创新创业竞赛'],
  ['student-innovation', '大学生创新训练计划'], ['programming', '程序设计 / 算法竞赛'],
  ['robotics', '机器人 / 智能车竞赛'], ['scholarship', '奖学金 / 学业奖项'],
  ['debate', '辩论 / 表达类竞赛'], ['business', '商业 / 案例竞赛'], ['finance', '金融 / 经济竞赛'],
  ['data', '数据分析 / 商业分析竞赛'], ['engineering', '工程实践 / 智能制造竞赛'],
  ['chemistry', '化学 / 材料竞赛'], ['biology', '生物 / 医学竞赛'],
  ['media', '传媒 / 广告 / 策划竞赛'], ['law', '模拟法庭 / 法律竞赛'],
  ['language', '外语 / 翻译竞赛'], ['education', '教学技能竞赛'],
  ['design', '设计 / 建筑 / 创意竞赛'], ['research', '科研 / 论文成果'], ['other', '其他']
]);

const labelsOf = options => options.map(item => item.label);
const optionLabel = (options, value) => {
  const item = options.find(option => option.value === value);
  return item && item.value ? item.label : '';
};
const directionSelectOptions = [{ value: '', label: '' }, ...directionOptions.map(([value, label]) => ({ value, label }))];
const companyTypeOptions = [
  { value: 'large', label: '头部企业 / 大型企业' },
  { value: 'listed', label: '上市公司' },
  { value: 'state-owned', label: '国企 / 央企' },
  { value: 'foreign', label: '外企 / 合资' },
  { value: 'research', label: '高校 / 科研机构' },
  { value: 'startup', label: '中小企业 / 初创' },
  { value: 'unknown', label: '不确定 / 不填写' }
];
const blankForm = () => ({
  university: '', major: '', gpaScale: '', gpaValue: '', languageTest: '', language: ''
});

let experienceSeed = 0;
const nextExperienceId = type => `${type}-${Date.now()}-${experienceSeed++}`;
const emptyInternship = () => ({
  id: nextExperienceId('internship'), direction: '', directionIndex: 0,
  companyTypes: [], companyTypeOptions: companyTypeOptions.map(item => ({ ...item, checked: false }))
});
const emptyResearch = () => ({
  id: nextExperienceId('research'), direction: '', directionIndex: 0
});
const emptyAward = () => ({
  id: nextExperienceId('award'), level: '', category: '',
  levelIndex: 0, categoryIndex: 0
});

const isChecked = event => {
  const detail = event.detail || {};
  if (typeof detail.checked === 'boolean') return detail.checked;
  if (typeof detail.value === 'boolean') return detail.value;
  if (Array.isArray(detail.value)) return detail.value.length > 0;
  return ['true', 'on', 'consent'].includes(String(detail.value || ''));
};

Page({
  data: {
    gpaScales, languageTests, gpaScaleIndex: 0, languageIndex: 0, form: blankForm(),
    directionLabels: ['请选择方向', ...directionOptions.map(item => item[1])],
    awardLevelLabels: labelsOf(awardLevelOptions),
    awardCategoryLabels: labelsOf(awardCategoryOptions),
    regionOptions: regionOptions.map(item => ({ ...item, checked: true })), selectedRegions: regionOptions.map(item => item.value),
    schoolMatches: [], schoolMeta: null, schoolMetaText: '', schoolBound: false, schoolSearchState: '',
    majorMatches: [], majorMeta: null, majorMetaText: '', majorBound: false, majorSearchState: '',
    schoolOptions: schoolOptions.map(item => ({ ...item, visible: true, checked: false })), selectedSchools: [], allSchoolsSelected: true,
    fieldOptions: fieldOptions.map(item => ({ ...item, checked: false })), selectedFields: [], allFieldsSelected: true,
    internships: [], researches: [], awards: [], consent: false, submitting: false, error: ''
  },

  onUniversityInput(event) {
    const query = event.detail.value;
    clearTimeout(this.schoolSearchTimer);
    this.schoolSearchToken = (this.schoolSearchToken || 0) + 1;
    const token = this.schoolSearchToken;
    this.setData({ 'form.university': query, schoolMatches: [], schoolMeta: null, schoolMetaText: '', schoolBound: false, schoolSearchState: query.trim().length >= 2 ? 'searching' : '', error: '' });
    if (query.trim().length < 2) return;
    this.schoolSearchTimer = setTimeout(async () => {
      try {
        const payload = await request(`/api/institutions/search?q=${encodeURIComponent(query.trim())}`);
        if (token !== this.schoolSearchToken) return;
        const rawMatches = (payload.results || []).map(item => ({
          id: item.id || item.nameZh || item.nameEn, name: item.nameZh || item.nameEn,
          meta: [item.classification || item.scoreTier ? `${item.classification || ''}${item.scoreTier ? ` · 层次 ${item.scoreTier}` : ''}` : ''].filter(Boolean).join(' · '),
          scoreTier: item.scoreTier ?? null, classification: item.classification || null
        }));
        const matches = rawMatches.filter((item, index, items) => items.findIndex(candidate => candidate.name === item.name) === index);
        this.setData({ schoolMatches: matches, schoolSearchState: matches.length ? '' : 'empty' });
      } catch (error) {
        if (token !== this.schoolSearchToken) return;
        this.setData({ schoolMatches: [], schoolSearchState: '', error: `学校检索失败：${error.message}` });
      }
    }, 260);
  },

  selectUniversity(event) {
    const match = this.data.schoolMatches[Number(event.currentTarget.dataset.index)];
    if (!match) return;
    clearTimeout(this.schoolSearchTimer);
    this.setData({ 'form.university': match.name, schoolMatches: [], schoolMeta: match, schoolMetaText: [match.name, match.meta].filter(Boolean).join(' · '), schoolBound: true, schoolSearchState: '', error: '' });
  },

  onMajorInput(event) {
    const query = event.detail.value;
    clearTimeout(this.majorSearchTimer);
    this.majorSearchToken = (this.majorSearchToken || 0) + 1;
    const token = this.majorSearchToken;
    this.setData({ 'form.major': query, majorMatches: [], majorMeta: null, majorMetaText: '', majorBound: false, majorSearchState: query.trim() ? 'searching' : '', error: '' });
    if (!query.trim()) return;
    this.majorSearchTimer = setTimeout(async () => {
      try {
        const payload = await request(`/api/majors/search?q=${encodeURIComponent(query.trim())}`);
        if (token !== this.majorSearchToken) return;
        const matches = (payload.results || []).map(item => ({ ...item, id: item.code, meta: [item.code, item.categoryName, item.className, majorFieldLabels[item.field]].filter(Boolean).join(' · ') }));
        this.setData({ majorMatches: matches, majorSearchState: matches.length ? '' : 'empty' });
      } catch (error) {
        if (token !== this.majorSearchToken) return;
        this.setData({ majorMatches: [], majorSearchState: '', error: `专业检索失败：${error.message}` });
      }
    }, 260);
  },

  selectMajor(event) {
    const match = this.data.majorMatches[Number(event.currentTarget.dataset.index)];
    if (!match) return;
    clearTimeout(this.majorSearchTimer);
    this.setData({ 'form.major': match.name, majorMatches: [], majorMeta: match, majorMetaText: [match.name, match.code, match.categoryName, match.className, majorFieldLabels[match.field]].filter(Boolean).join(' · '), majorBound: true, majorSearchState: '', error: '' });
  },

  onTextInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value, error: '' });
  },

  onGpaScaleChange(event) {
    const index = Number(event.detail.value);
    this.setData({ 'form.gpaScale': gpaScales[index], gpaScaleIndex: index, error: '' });
  },

  onLanguageChange(event) {
    const index = Number(event.detail.value);
    this.setData({ 'form.languageTest': languageTests[index], languageIndex: index, error: '' });
  },

  onConsentChange(event) {
    this.setData({ consent: isChecked(event), error: '' });
  },

  onRegionChange(event) {
    const selectedRegions = event.detail.value || [];
    const selectedSchools = this.data.selectedSchools.filter(value => {
      const school = schoolOptions.find(item => item.value === value);
      return school && selectedRegions.includes(school.region);
    });
    this.setData({ selectedRegions, regionOptions: regionOptions.map(item => ({ ...item, checked: selectedRegions.includes(item.value) })), selectedSchools, allSchoolsSelected: selectedRegions.length > 0 && selectedSchools.length === 0, schoolOptions: this.buildSchoolOptions(selectedRegions, selectedSchools), error: '' });
  },

  onSchoolChange(event) {
    const selectedSchools = event.detail.value || [];
    this.setData({ selectedSchools, allSchoolsSelected: selectedSchools.length === 0 && this.data.selectedRegions.length > 0, schoolOptions: this.buildSchoolOptions(this.data.selectedRegions, selectedSchools), error: '' });
  },

  onAllSchoolChange(event) {
    if (isChecked(event)) {
      this.setData({ selectedSchools: [], allSchoolsSelected: true, schoolOptions: this.buildSchoolOptions(this.data.selectedRegions, []), error: '' });
      return;
    }
    if (!this.data.selectedSchools.length) this.setData({ allSchoolsSelected: this.data.selectedRegions.length > 0 });
  },

  onFieldChange(event) {
    const selectedFields = event.detail.value || [];
    this.setData({ selectedFields, allFieldsSelected: selectedFields.length === 0, fieldOptions: fieldOptions.map(item => ({ ...item, checked: selectedFields.includes(item.value) })), error: '' });
  },

  onAllFieldChange(event) {
    if (isChecked(event)) {
      this.setData({ selectedFields: [], allFieldsSelected: true, fieldOptions: fieldOptions.map(item => ({ ...item, checked: false })), error: '' });
      return;
    }
    if (!this.data.selectedFields.length) this.setData({ allFieldsSelected: true });
  },

  buildSchoolOptions(regions, selectedSchools) {
    return schoolOptions.map(item => ({ ...item, visible: regions.includes(item.region), checked: selectedSchools.includes(item.value) }));
  },

  addInternship() { this.setData({ internships: [...this.data.internships, emptyInternship()], error: '' }); },
  addResearch() { this.setData({ researches: [...this.data.researches, emptyResearch()], error: '' }); },
  addAward() { this.setData({ awards: [...this.data.awards, emptyAward()], error: '' }); },

  onExperiencePickerChange(event) {
    const { list, key, index } = event.currentTarget.dataset;
    const pickIndex = Number(event.detail.value);
    const options = list === 'internships' || list === 'researches'
      ? { direction: directionSelectOptions }
      : { level: awardLevelOptions, category: awardCategoryOptions };
    const option = options[key]?.[pickIndex];
    if (!option) return;
    this.setData({ [`${list}[${Number(index)}].${key}`]: option.value, [`${list}[${Number(index)}].${key}Index`]: pickIndex, error: '' });
  },

  onInternshipTypeChange(event) {
    const index = Number(event.currentTarget.dataset.index);
    const selected = event.detail.value || [];
    const options = (this.data.internships[index]?.companyTypeOptions || companyTypeOptions)
      .map(item => ({ ...item, checked: selected.includes(item.value) }));
    this.setData({
      [`internships[${index}].companyTypes`]: selected,
      [`internships[${index}].companyTypeOptions`]: options,
      error: ''
    });
  },

  removeExperience(event) {
    const { list, index } = event.currentTarget.dataset;
    const next = [...(this.data[list] || [])];
    next.splice(Number(index), 1);
    this.setData({ [list]: next, error: '' });
  },

  buildProfile() {
    const form = this.data.form;
    const major = this.data.majorMeta;
    return {
      university: form.university.trim(), major: major?.field || '', majorCode: major?.code || '', majorName: form.major.trim(),
      schoolTier: this.data.schoolMeta?.scoreTier ?? null, schoolClassification: this.data.schoolMeta?.classification || null,
      gpaScale: form.gpaScale === '百分制' ? '100' : form.gpaScale === '4.0 GPA' ? '4' : form.gpaScale === '5.0 GPA' ? '5' : '',
      gpaValue: form.gpaValue.trim() ? Number(form.gpaValue) : null, languageTest: form.languageTest,
      language: form.language.trim() ? Number(form.language) : null,
      internships: this.data.internships
        .filter(item => item.direction || (item.companyTypes || []).length)
        .map(item => ({ direction: item.direction, companyTypes: item.companyTypes || [] })),
      researches: this.data.researches.filter(item => item.direction).map(item => ({ direction: item.direction })),
      awards: this.data.awards.filter(item => item.level || item.category).map(item => ({ level: item.level, category: item.category })),
      courseNames: [], courseTags: [], additionalCourses: ''
    };
  },

  buildProfileText(profile) {
    const internshipText = this.data.internships
      .filter(item => item.direction || (item.companyTypes || []).length)
      .map(item => {
        const direction = optionLabel(directionSelectOptions, item.direction);
        const companyTypes = (item.companyTypes || []).map(value => optionLabel(companyTypeOptions, value)).filter(Boolean);
        return `实习${direction ? `方向：${direction}` : ''}${companyTypes.length ? `${direction ? '；' : ''}单位类型：${companyTypes.join('、')}` : ''}`;
      });
    const researchText = this.data.researches.filter(item => item.direction).map(item => `研究方向：${optionLabel(directionSelectOptions, item.direction)}`);
    const awardText = this.data.awards.filter(item => item.level || item.category).map(item => `竞赛方向：${[optionLabel(awardLevelOptions, item.level), optionLabel(awardCategoryOptions, item.category)].filter(Boolean).join('，')}`);
    return [`本科院校：${profile.university}`, `本科专业：${profile.majorName}`, `成绩：${profile.gpaValue}/${profile.gpaScale}`, profile.languageTest && profile.language ? `语言：${profile.languageTest} ${profile.language}` : '', ...internshipText, ...researchText, ...awardText].filter(Boolean).join('\n');
  },

  validate(profile) {
    if (!profile.university || !this.data.schoolBound) return '请填写本科院校，并从候选项中点选正式校名完成绑定。';
    if (!profile.major || !this.data.majorBound) return '请填写本科专业，并从专业候选项中点选正式专业。';
    if (!profile.gpaScale || !Number.isFinite(profile.gpaValue)) return '请填写成绩制式和成绩。';
    const gpaMaximum = { '100': 100, '4': 4, '5': 5 }[profile.gpaScale];
    if (profile.gpaValue <= 0 || profile.gpaValue > gpaMaximum) return `成绩必须在 0–${gpaMaximum} 之间。`;
    if (!this.data.selectedRegions.length) return '至少选择一个申请地区。';
    if (!this.data.consent) return '请先勾选信息保存与反馈授权。';
    return '';
  },

  async submit() {
    const profile = this.buildProfile();
    const validationError = this.validate(profile);
    if (validationError) { this.setData({ error: validationError }); return; }
    this.setData({ submitting: true, error: '' });
    wx.showLoading({ title: '正在分析', mask: true });
    try {
      const profileText = this.buildProfileText(profile);
      const result = await request('/api/analyze', { method: 'POST', data: { profile, profileText, regions: this.data.selectedRegions, targetSchools: this.data.selectedSchools, fields: this.data.selectedFields, consent: true } });
      wx.setStorageSync('admission-analysis-result', { ...result, input: { profileText } });
      wx.navigateTo({ url: '/pages/results/results' });
    } catch (error) {
      this.setData({ error: error.message || '分析请求失败，请检查后端地址和网络。' });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  }
});
