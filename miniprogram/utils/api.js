function request(path, options = {}) {
  const app = getApp();
  const config = app.globalData.config || {};
  const actions = {
    '/api/institutions/search': 'institutions.search',
    '/api/majors/search': 'majors.search',
    '/api/analyze': 'analysis.create',
    '/api/feedback': 'feedback.create'
  };
  const [pathname, queryString = ''] = String(path).split('?');
  const action = actions[pathname];
  if (!action) return Promise.reject(new Error(`未配置云端接口：${pathname}`));

  const query = {};
  queryString.split('&').filter(Boolean).forEach(pair => {
    const [key, value = ''] = pair.split('=');
    query[decodeURIComponent(key)] = decodeURIComponent(value);
  });

  return wx.cloud.callFunction({
    name: config.cloudFunctionName || 'admissionApi',
    data: { action, payload: options.data || query }
  }).then(response => {
    const result = response.result || {};
    if (result.ok) return result.data;
    throw new Error(result.message || '云函数请求失败');
  }).catch(error => {
    const message = error.errMsg || error.message || '云函数请求失败';
    if (/FUNCTION_NOT_FOUND|找不到|not found/i.test(message)) {
      throw new Error('云函数 admissionApi 尚未部署，请在 cloudfunctions 目录中上传并部署。');
    }
    throw new Error(message);
  });
}

module.exports = { request };
