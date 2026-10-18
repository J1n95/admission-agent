import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let settingsWindow = null;
let serverModule = null;
let startupError = "";
let localOrigin = "";
let experimentProcess = null;
const desktopToken = randomBytes(32).toString("hex");

const settingsPath = () => join(app.getPath("userData"), "settings.json");
const runtimeFiles = () => app.isPackaged
  ? process.resourcesPath
  : join(app.getAppPath(), "build", "desktop-seed");

function readStoredSettingsFile() {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return null;
  }
}

function decryptApiKey(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(value, "base64")); }
  catch { return ""; }
}

function readStoredProfile(value = {}) {
  return {
    apiUrl: String(value.apiUrl || ""),
    model: String(value.model || ""),
    apiKey: decryptApiKey(value.encryptedApiKey)
  };
}

function readSettings() {
  const saved = readStoredSettingsFile();
  if (!saved) return null;
  const profile = saved.primary || saved;
  if (!profile.apiUrl || !profile.model || !profile.encryptedApiKey) return null;
  const settings = readStoredProfile(profile);
  return settings.apiKey ? settings : null;
}

function readExperimentSettings() {
  const saved = readStoredSettingsFile() || {};
  const profiles = saved.experiment || {};
  return {
    qwen: readStoredProfile(profiles.qwen),
    deepseek: readStoredProfile(profiles.deepseek)
  };
}

function validateSettings(input, existingKey = "") {
  const apiUrl = String(input?.apiUrl || "").trim();
  const model = String(input?.model || "").trim();
  const apiKey = String(input?.apiKey || "").trim() || existingKey;
  let parsed;
  try { parsed = new URL(apiUrl); } catch { throw new Error("请填写完整的 API 接口地址。"); }
  if (parsed.protocol !== "https:") throw new Error("模型 API 必须使用 HTTPS 地址。");
  if (!/\/chat\/completions\/?$/i.test(parsed.pathname)) {
    throw new Error("接口地址请填写完整的 Chat Completions 路径，例如 https://api.example.com/v1/chat/completions。");
  }
  if (!model) throw new Error("请填写模型名称。");
  if (!apiKey) throw new Error("请填写 API Key。");
  return { apiUrl, model, apiKey };
}

function validateExperimentSettings(input, existing = readExperimentSettings()) {
  const result = {};
  for (const [key, label] of [["qwen", "千问"], ["deepseek", "DeepSeek"]]) {
    const value = input?.[key] || {};
    const previous = existing[key] || {};
    if (!String(value.apiKey || "").trim() && !previous.apiKey) continue;
    const hasInput = [value.apiUrl, value.model, value.apiKey].some(item => String(item || "").trim());
    if (!hasInput && previous.apiUrl && previous.model && previous.apiKey) {
      result[key] = previous;
      continue;
    }
    if (!hasInput) throw new Error(`请完整填写${label}的实验配置，或清空该组配置。`);
    result[key] = validateSettings(value, previous.apiKey || "");
    const allowedModels = key === "qwen" ? ["qwen-flash-2025-07-28", "qwen3.7-plus"] : ["deepseek-flash"];
    if (!allowedModels.includes(result[key].model)) {
      throw new Error(`${label}实验模型不在当前支持的型号列表中：${allowedModels.join("、")}。`);
    }
  }
  return result;
}

function writeSettings(settings, experiment) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，暂时无法安全保存 API Key。");
  const path = settingsPath();
  const temporaryPath = `${path}.tmp`;
  mkdirSync(app.getPath("userData"), { recursive: true });
  const output = {
    apiUrl: settings.apiUrl,
    model: settings.model,
    encryptedApiKey: safeStorage.encryptString(settings.apiKey).toString("base64"),
    experiment: {}
  };
  for (const [key, value] of Object.entries(experiment || {})) {
    output.experiment[key] = {
      apiUrl: value.apiUrl,
      model: value.model,
      encryptedApiKey: safeStorage.encryptString(value.apiKey).toString("base64")
    };
  }
  writeFileSync(temporaryPath, JSON.stringify(output), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function settingsView() {
  const saved = readSettings();
  const experiment = readExperimentSettings();
  const publicExperiment = {
    qwen: {
      apiUrl: experiment.qwen.apiUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen3.7-plus",
      apiKeyConfigured: Boolean(experiment.qwen.apiKey)
    },
    deepseek: {
      apiUrl: experiment.deepseek.apiUrl || "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      apiKeyConfigured: Boolean(experiment.deepseek.apiKey)
    }
  };
  return {
    apiUrl: saved?.apiUrl || "",
    model: saved?.model || "",
    apiKeyConfigured: Boolean(saved?.apiKey),
    experiment: publicExperiment,
    running: Boolean(mainWindow),
    startupError
  };
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 860,
    height: 940,
    minWidth: 680,
    minHeight: 760,
    title: "模型 API 设置",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(app.getAppPath(), "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  settingsWindow.loadFile(join(app.getAppPath(), "desktop", "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
  return settingsWindow;
}

async function testModelSettings(settings) {
  let response;
  try {
    response = await fetch(settings.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK." }]
      }),
      signal: AbortSignal.timeout(25000)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "连接模型接口超时，请检查网络和接口地址。" : "连接失败，请检查网络、接口地址和 API Key。");
  }
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error(`接口返回内容不是 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) {
    const message = String(result?.error?.message || result?.message || `HTTP ${response.status}`).slice(0, 240);
    throw new Error(`模型接口拒绝请求：${message}`);
  }
  if (!result?.choices?.length) throw new Error("接口已连接，但返回格式不符合 Chat Completions。");
  return { ok: true };
}

async function testSettings(input) {
  const current = readSettings();
  return testModelSettings(validateSettings(input, current?.apiKey || ""));
}

async function testExperimentSettings(input) {
  const settings = validateExperimentSettings(input);
  if (!settings.qwen || !settings.deepseek) throw new Error("请先填写千问和 DeepSeek 两套 API Key。");
  await Promise.all([testModelSettings(settings.qwen), testModelSettings(settings.deepseek)]);
  return { ok: true };
}

async function startApplication() {
  const settings = readSettings();
  if (!settings) {
    createSettingsWindow();
    return;
  }
  const dataDirectory = join(app.getPath("userData"), "data");
  const resources = runtimeFiles();
  const seedPath = join(resources, "data", "cases-seed.sqlite");
  const referencePath = join(resources, "data", "institutions.sqlite");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = join(dataDirectory, "cases.sqlite");
  if (!existsSync(databasePath)) {
    if (!existsSync(seedPath)) throw new Error("找不到内置案例资料，请重新安装软件。");
    copyFileSync(seedPath, databasePath);
  }
  if (!existsSync(referencePath)) throw new Error("找不到内置院校资料，请重新安装软件。");

  process.env.ADMISSION_APP_ROOT = app.getAppPath();
  process.env.ADMISSION_DATA_DIR = dataDirectory;
  process.env.ADMISSION_REFERENCE_DB_PATH = referencePath;
  process.env.ADMISSION_AGENT_DATA_DIR = join(resources, "data", "agent");
  if (app.isPackaged) process.env.ADMISSION_COLLECTOR_CONFIG_DIR = join(resources, "data", "collector");
  process.env.ADMISSION_AGENT_MODE = "legacy-two-stage";
  process.env.ADMISSION_DESKTOP_TOKEN = desktopToken;
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.AI_API_URL = settings.apiUrl;
  process.env.AI_API_KEY = settings.apiKey;
  process.env.AI_MODEL = settings.model;
  process.chdir(app.getPath("userData"));

  serverModule = await import(pathToFileURL(join(app.getAppPath(), "server.mjs")).href);
  const httpServer = serverModule.httpServer;
  if (!httpServer.listening) await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("本地服务启动失败。");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    title: "录取参照",
    backgroundColor: "#f4f2ed",
    webPreferences: {
      preload: join(app.getAppPath(), "desktop", "app-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  localOrigin = `http://127.0.0.1:${address.port}`;
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${localOrigin}/*`] }, (details, callback) => {
    details.requestHeaders["X-Admission-Desktop-Token"] = desktopToken;
    callback({ requestHeaders: details.requestHeaders });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${localOrigin}/`)) return;
    event.preventDefault();
    if (url.startsWith("https://")) shell.openExternal(url);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(`${localOrigin}/`);
  startupError = "";
}

async function clearApplicantRecords() {
  const confirmOptions = {
    type: "warning",
    title: "删除本机申请记录",
    message: "删除本机保存的申请资料、分析结果和反馈？",
    detail: "此操作不可撤销，不会删除内置公开案例，也无法撤回已发送给你配置的模型服务商的数据。",
    buttons: ["取消", "删除本机记录"],
    defaultId: 0,
    cancelId: 0
  };
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, confirmOptions)
    : await dialog.showMessageBox(confirmOptions);
  if (choice.response !== 1) return;
  if (!serverModule) throw new Error("本机服务尚未启动，无法核对删除结果。");
  serverModule?.clearLocalAnalysisData();
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.executeJavaScript("sessionStorage.clear()");
    mainWindow.reload();
  }
  const resultOptions = { type: "info", message: "本机申请记录已删除。" };
  if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, resultOptions);
  else dialog.showMessageBox(resultOptions);
}

function sendExperimentProgress(payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("experiment:progress", payload);
  }
}

function startModelExperiment() {
  if (experimentProcess) return { ok: true, started: false, message: "模型对比实验已经在运行。" };
  const experiment = readExperimentSettings();
  if (!experiment.qwen.apiKey) {
    throw new Error("请先保存千问 API 配置。");
  }
  if (experiment.qwen.model !== "qwen3.7-plus") {
    throw new Error("本轮候选实验使用 qwen3.7-plus，请先保存该型号配置。");
  }
  const scriptPath = join(app.getAppPath(), "eval", "model-ab.mjs");
  if (!existsSync(scriptPath)) throw new Error("当前安装包没有包含模型对比脚本，请重新构建 EXE。");
  const packagedDataDir = app.isPackaged
    ? join(process.resourcesPath, "data", "agent")
    : join(app.getAppPath(), "miniprogram", "cloud-data");
  const catalogPath = app.isPackaged
    ? join(packagedDataDir, "catalog.json")
    : join(app.getAppPath(), "miniprogram", "cloudfunctions", "admissionApi", "catalog.json");
  const outputDir = join(app.getPath("userData"), "model-ab");
  const env = {
    ...process.env,
    DASHSCOPE_API_KEY: experiment.qwen.apiKey,
    QWEN_API_URL: experiment.qwen.apiUrl,
    QWEN_MODEL: experiment.qwen.model,
    ADMISSION_EVAL_DATA_DIR: packagedDataDir,
    ADMISSION_EVAL_CATALOG_PATH: catalogPath,
    ADMISSION_EVAL_OUTPUT_DIR: outputDir
  };
  const command = app.isPackaged ? process.execPath : (process.env.NODE_EXEC_PATH || "node");
  if (app.isPackaged) env.ELECTRON_RUN_AS_NODE = "1";
  mkdirSync(outputDir, { recursive: true });
  experimentProcess = spawn(command, [scriptPath, "--run", "--qwen-challenger", "--max-cny=5"], {
    cwd: app.getPath("userData"),
    env,
    windowsHide: true
  });
  sendExperimentProgress({ type: "started", message: "千问 qwen3.7-plus 候选实验已启动：8 个场景，费用预检上限 5 元。" });
  let outputTail = "";
  const consume = chunk => {
    outputTail = outputTail + String(chunk);
    outputTail = outputTail.slice(-8000);
    for (const line of String(chunk).split(/\r?\n/)) {
      if (/^(selection|assessment|ranking)\s*\//.test(line)) {
        sendExperimentProgress({ type: "progress", message: line.slice(0, 240) });
      }
    }
  };
  experimentProcess.stdout.setEncoding("utf8");
  experimentProcess.stderr.setEncoding("utf8");
  experimentProcess.stdout.on("data", consume);
  experimentProcess.stderr.on("data", chunk => {
    outputTail = (outputTail + String(chunk)).slice(-8000);
    sendExperimentProgress({ type: "log", message: String(chunk).trim().slice(-240) });
  });
  experimentProcess.on("error", error => {
    sendExperimentProgress({ type: "error", message: error.message || "模型对比实验启动失败。" });
  });
  experimentProcess.on("close", code => {
    const failed = code !== 0;
    experimentProcess = null;
    sendExperimentProgress({
      type: failed ? "error" : "done",
      code,
      outputDir,
      message: failed
        ? "模型对比实验未完成（退出码 " + code + "）。" + outputTail.trim().slice(-180)
        : "模型对比实验完成，结果保存在：" + outputDir
    });
  });
  return { ok: true, started: true };
}

ipcMain.handle("settings:get", () => settingsView());
ipcMain.on("settings:open", event => {
  if (event.sender === mainWindow?.webContents) createSettingsWindow();
});
ipcMain.handle("settings:test", async (_event, input) => {
  try { return await testSettings(input); }
  catch (error) { return { ok: false, message: error.message || "模型接口测试失败。" }; }
});
ipcMain.handle("settings:test-experiment", async (_event, input) => {
  try { return await testExperimentSettings(input); }
  catch (error) { return { ok: false, message: error.message || "双模型接口测试失败。" }; }
});
ipcMain.handle("experiment:run", () => {
  try { return startModelExperiment(); }
  catch (error) { return { ok: false, message: error.message || "模型对比实验启动失败。" }; }
});
ipcMain.handle("settings:save-experiment", async (_event, input) => {
  try {
    const current = readSettings();
    if (!current) throw new Error("请先保存软件当前使用的模型配置。");
    const experiment = validateExperimentSettings(input);
    if (Object.keys(experiment).length !== 2) throw new Error("请填写千问和 DeepSeek 两套 API Key。");
    writeSettings(current, experiment);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message || "实验配置保存失败。" };
  }
});
ipcMain.handle("settings:save", async (_event, input) => {
  try {
    const current = readSettings();
    const settings = validateSettings(input, current?.apiKey || "");
    const experiment = validateExperimentSettings(input.experiment);
    writeSettings(settings, experiment);
    if (mainWindow) {
      app.relaunch();
      app.exit(0);
      return { ok: true, restarting: true };
    }
    startupError = "";
    await startApplication();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return { ok: true, restarting: false };
  } catch (error) {
    startupError = error.message || "启动失败。";
    return { ok: false, message: startupError };
  }
});

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "录取参照",
      submenu: [
        { label: "模型 API 设置…", accelerator: "CommandOrControl+,", click: () => createSettingsWindow() },
        { label: "案例采集与审核…", click: () => {
          if (mainWindow && !mainWindow.isDestroyed() && localOrigin) mainWindow.loadURL(`${localOrigin}/review.html`);
        } },
        { label: "删除本机申请记录…", click: () => clearApplicantRecords().catch(error =>
          dialog.showErrorBox("删除失败", error.message || "无法删除本机记录。")) },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    }
  ]));
}

app.on("second-instance", () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  else createSettingsWindow();
});
app.whenReady().then(async () => {
  installMenu();
  try { await startApplication(); }
  catch (error) {
    startupError = error.message || "应用启动失败。";
    dialog.showErrorBox("录取参照启动失败", startupError);
    createSettingsWindow();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  experimentProcess?.kill();
  serverModule?.stopLocalCollector?.();
});
