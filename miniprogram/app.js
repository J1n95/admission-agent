const config = require('./config');

App({
  onLaunch() {
    if (!wx.cloud) throw new Error('当前微信基础库不支持云开发');
    wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
  },
  globalData: { config }
});
