const { request } = require('../../utils/api');

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

Page({
  data: {
    summary: null,
    results: [],
    feedback: { usefulness: '', valuable: '', clarity: '', comment: '' },
    savingFeedback: false,
    feedbackSaved: false,
    error: ''
  },

  onShow() {
    const payload = wx.getStorageSync('admission-analysis-result');
    if (!payload) {
      this.setData({ error: '没有找到最近一次分析记录，请返回重新提交。' });
      return;
    }
    const input = payload.input || {};
    const results = (payload.results || []).map(row => {
      const programme = row.programme || {};
      const result = row.result || {};
      const insight = payload.insights?.[programme.id] || {};
      const available = Boolean(result.assessmentAvailable && Number.isFinite(Number(result.center)));
      const caseCount = Number(programme.caseCount || (Array.isArray(programme.cases) ? programme.cases.length : 0));
      const assessmentStatus = available
        ? result.evidenceMode === 'ai-project-profile-only'
          ? '仅由 AI 根据项目资料与申请背景推断 · 低置信度'
          : result.evidenceMode === 'ai-limited-cases'
            ? 'AI 结合少量案例与项目资料分析 · 低置信度'
            : 'AI 结合全量案例统计与项目资料分析'
        : row.assessmentError || '仅展示项目资料与证据状态';
      return {
        id: programme.id || `${programme.university}-${programme.name}`,
        meta: [programme.region, programme.university || programme.school].filter(Boolean).join(' · '),
        schoolCode: programme.school && programme.school !== programme.university ? programme.school : '',
        title: programme.nameZh || programme.name || '未命名项目',
        subtitle: programme.name && programme.name !== programme.nameZh ? programme.name : '',
        probability: available ? `${result.center}%` : '待分析',
        range: available ? `参考范围 ${result.low}%–${result.high}%` : '暂无概率参考',
        caseCount,
        assessmentStatus,
        fit: asList(insight.fit),
        psCv: asList(insight.psCv),
        uncertainties: asList(insight.uncertainties),
        evidenceCases: (Array.isArray(row.evidenceCases) ? row.evidenceCases : []).map((item, caseIndex) => ({
          ...item,
          id: item.id || `${programme.id}-case-${caseIndex + 1}`,
          label: item.isNearest ? '最匹配案例' : `案例 ${String(caseIndex + 1).padStart(2, '0')}`
        })),
        expanded: false
      };
    });
    this.setData({
      summary: {
        profile: input.profileText ? String(input.profileText).split('\n').slice(0, 3).join(' · ') : '本次申请背景',
        message: payload.message || '分析完成。'
      },
      results,
      error: ''
    });
  },

  toggleResultDetail(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.results[index]) return;
    this.setData({ [`results[${index}].expanded`]: !this.data.results[index].expanded });
  },

  onFeedbackChange(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`feedback.${key}`]: event.detail.value, error: '' });
  },

  onCommentInput(event) {
    this.setData({ 'feedback.comment': event.detail.value, error: '' });
  },

  async submitFeedback() {
    const payload = wx.getStorageSync('admission-analysis-result');
    const feedback = this.data.feedback;
    if (!payload?.analysisId) {
      this.setData({ error: '本次分析没有有效记录编号，暂时无法提交反馈。' });
      return;
    }
    if (!feedback.usefulness || !feedback.valuable || !feedback.clarity) {
      this.setData({ error: '请完成三项反馈选择。' });
      return;
    }
    this.setData({ savingFeedback: true, error: '' });
    try {
      await request('/api/feedback', {
        method: 'POST',
        data: { analysisId: payload.analysisId, ...feedback }
      });
      this.setData({ feedbackSaved: true });
    } catch (error) {
      this.setData({ error: error.message || '反馈保存失败，请稍后重试。' });
    } finally {
      this.setData({ savingFeedback: false });
    }
  },

  backToForm() {
    wx.navigateBack({ delta: 1 });
  }
});
