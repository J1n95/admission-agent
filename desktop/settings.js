const form = document.querySelector("#settings");
const apiUrl = document.querySelector("#apiUrl");
const model = document.querySelector("#model");
const apiKey = document.querySelector("#apiKey");
const keyState = document.querySelector("#keyState");
const notice = document.querySelector("#notice");
const testButton = document.querySelector("#test");
const saveButton = document.querySelector("#save");
const testExperimentButton = document.querySelector("#testExperiment");
const runExperimentButton = document.querySelector("#runExperiment");
const experimentNotice = document.querySelector("#experimentNotice");
const experimentProgress = document.querySelector("#experimentProgress");
const qwen = {
  apiUrl: document.querySelector("#qwenApiUrl"),
  model: document.querySelector("#qwenModel"),
  apiKey: document.querySelector("#qwenApiKey"),
  state: document.querySelector("#qwenState")
};
const deepseek = {
  apiUrl: document.querySelector("#deepseekApiUrl"),
  model: document.querySelector("#deepseekModel"),
  apiKey: document.querySelector("#deepseekApiKey"),
  state: document.querySelector("#deepseekState")
};

function profileValues(profile) {
  return { apiUrl: profile.apiUrl.value.trim(), model: profile.model.value.trim(), apiKey: profile.apiKey.value.trim() };
}

function values() {
  return {
    apiUrl: apiUrl.value.trim(),
    model: model.value.trim(),
    apiKey: apiKey.value.trim(),
    experiment: { qwen: profileValues(qwen), deepseek: profileValues(deepseek) }
  };
}

function showNotice(target, message, kind) {
  target.textContent = message;
  target.className = `notice show ${kind}`;
}

function setBusy(busy) {
  testButton.disabled = busy;
  saveButton.disabled = busy;
  testExperimentButton.disabled = busy;
  runExperimentButton.disabled = busy;
}

function fillProfile(profile, config = {}) {
  profile.apiUrl.value = config.apiUrl || "";
  profile.model.value = config.model || "";
  profile.state.textContent = config.apiKeyConfigured ? "本机已保存 API Key；留空会继续使用当前 Key。" : "尚未保存 API Key。";
}

window.admissionDesktop.getConfiguration().then(config => {
  apiUrl.value = config.apiUrl;
  model.value = config.model;
  keyState.textContent = config.apiKeyConfigured ? "本机已保存 API Key；留空会继续使用当前 Key。" : "";
  fillProfile(qwen, config.experiment?.qwen);
  fillProfile(deepseek, config.experiment?.deepseek);
  saveButton.textContent = config.running ? "保存并重启软件" : "保存并启动";
  if (config.startupError) showNotice(notice, config.startupError, "error");
});

testButton.addEventListener("click", async () => {
  setBusy(true);
  showNotice(notice, "正在测试当前模型接口……", "success");
  const result = await window.admissionDesktop.testConfiguration(values());
  setBusy(false);
  showNotice(notice, result.ok ? "连接成功，模型接口返回格式正常。" : result.message, result.ok ? "success" : "error");
});

testExperimentButton.addEventListener("click", async () => {
  setBusy(true);
  showNotice(experimentNotice, "正在测试千问和 DeepSeek……", "success");
  const result = await window.admissionDesktop.testExperimentConfiguration(values().experiment);
  setBusy(false);
  showNotice(experimentNotice, result.ok ? "两套接口都连接成功。" : result.message, result.ok ? "success" : "error");
});

runExperimentButton.addEventListener("click", async () => {
  setBusy(true);
  showNotice(experimentNotice, "正在保存两套配置……", "success");
  const saved = await window.admissionDesktop.saveExperimentConfiguration(values().experiment);
  if (!saved.ok) {
    setBusy(false);
    showNotice(experimentNotice, saved.message, "error");
    return;
  }
  showNotice(experimentNotice, "配置已加密保存，正在启动 8 个场景的千问候选实验……", "success");
  experimentProgress.textContent = "等待模型返回结果……";
  const result = await window.admissionDesktop.runExperiment();
  if (!result.ok) {
    setBusy(false);
    showNotice(experimentNotice, result.message, "error");
  }
});

window.admissionDesktop.onExperimentProgress(payload => {
  if (payload.type === "started") showNotice(experimentNotice, payload.message, "success");
  if (payload.type === "progress" || payload.type === "log") experimentProgress.textContent = payload.message;
  if (payload.type === "done") {
    setBusy(false);
    showNotice(experimentNotice, payload.message, "success");
    experimentProgress.textContent = `结果目录：${payload.outputDir}`;
  }
  if (payload.type === "error") {
    setBusy(false);
    showNotice(experimentNotice, payload.message, "error");
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  setBusy(true);
  showNotice(notice, "正在保存设置……", "success");
  const result = await window.admissionDesktop.saveConfiguration(values());
  if (!result.ok) {
    setBusy(false);
    showNotice(notice, result.message, "error");
    return;
  }
  showNotice(notice, result.restarting ? "设置已加密保存，软件正在重启。" : "设置已加密保存，正在打开软件。", "success");
});
