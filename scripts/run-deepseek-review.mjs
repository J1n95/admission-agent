import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, safeStorage } from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = join(app.getPath("appData"), "admission-reference-prototype");
app.setPath("userData", userDataDir);

function decryptApiKey(encryptedApiKey) {
  if (!encryptedApiKey || !safeStorage.isEncryptionAvailable()) {
    throw new Error("未找到可用的本机加密 API Key，请先在软件的模型 API 设置中保存 DeepSeek 实验配置。");
  }
  return safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
}

async function run() {
  const collectorSmoke = process.argv.includes("--collector-smoke");
  const crossDiscipline = process.argv.includes("--cross-discipline");
  const expandedDiscipline = process.argv.includes("--cross-discipline-expanded");
  const gpaFiveReview = process.argv.includes("--gpa-five-review");
  const gpaCompare = process.argv.includes("--gpa-compare");
  const schoolTierSmoke = process.argv.includes("--school-tier-smoke");
  const nonEliteSweep = process.argv.includes("--non-elite-sweep");
  const fullFlowSmoke = process.argv.includes("--full-flow-smoke");
  const settingsPath = join(app.getPath("userData"), "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const configuration = settings.experiment?.deepseek;
  const apiKey = decryptApiKey(configuration?.encryptedApiKey);
  const outputDir = join(app.getPath("userData"), "model-ab");
  const childArgs = collectorSmoke
    ? [join(root, "collector", "agent.mjs"), "collect", "https://www.mastermate.cn/admission/9576",
      "--programme-id=cuhk-master-of-laws-in-energy-and-environmental-law", "--dry-run", "--force-refresh"]
    : fullFlowSmoke
      ? [join(root, "eval", "full-flow-smoke.mjs"),
        ...(process.argv.includes("--issue1") ? ["--issue1"] : []),
        ...(process.argv.includes("--issue2") ? ["--issue2"] : []),
        ...(process.argv.includes("--timeout-repro") ? ["--timeout-repro"] : [])]
    : [join(root, "eval", "model-ab.mjs"), "--run",
      nonEliteSweep ? "--non-elite-sweep" : schoolTierSmoke ? "--school-tier-smoke" : gpaCompare ? "--gpa-compare" : gpaFiveReview ? "--gpa-five-review" : expandedDiscipline ? "--cross-discipline-expanded" : crossDiscipline ? "--cross-discipline" : "--deepseek-review",
      nonEliteSweep ? "--max-cny=5" : gpaCompare || crossDiscipline || expandedDiscipline ? "--max-cny=2" : "--max-cny=1"];
  const child = spawn(process.execPath, childArgs, {
    cwd: root,
    windowsHide: true,
    stdio: collectorSmoke ? ["ignore", "pipe", "inherit"] : "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_API_URL: configuration.apiUrl,
      DEEPSEEK_MODEL: configuration.model,
      ADMISSION_EVAL_OUTPUT_DIR: outputDir,
      FULL_FLOW_MAX_CNY: "5",
      ...(fullFlowSmoke ? {
        AI_API_URL: configuration.apiUrl,
        AI_API_KEY: apiKey,
        AI_MODEL: configuration.model
      } : {}),
      ...(collectorSmoke ? {
        ADMISSION_DATA_DIR: join(root, "work", "collector-smoke-gpa-2026-10-18"),
        COLLECTOR_AI_API_URL: configuration.apiUrl,
        COLLECTOR_AI_API_KEY: apiKey,
        COLLECTOR_AI_MODEL: configuration.model,
        COLLECTOR_AI_ENABLE_THINKING: "false",
        COLLECTOR_OCR_MODE: "disabled"
      } : {})
    }
  });
  let collectorOutput = "";
  if (collectorSmoke) child.stdout.on("data", chunk => { collectorOutput += chunk; });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", code => resolveExit(code ?? 1));
  });
  if (collectorSmoke && exitCode === 0) {
    const result = JSON.parse(collectorOutput);
    console.log(JSON.stringify({ url: result.url, extracted: result.extracted, queued: result.queued,
      duplicates: result.duplicates, skipped: result.skipped, modelCalled: result.modelCalled,
      extractionMethod: result.extractionMethod, prefilterDecision: result.prefilter?.decision,
      usage: result.usage, candidates: (result.extractedCandidates || []).map(item => ({
        programmeId: item.targetProgrammeId, offerYear: item.offerYear,
        gpaRaw: item.gpaRaw, gpaScale: item.gpaScale,
        reviewStatus: item.reviewStatus, issues: item.issues
      })) }, null, 2));
  }
  return exitCode;
}

app.once("ready", () => {
  run()
    .then(exitCode => app.exit(exitCode))
    .catch(error => {
      console.error(String(error.message || error));
      app.exit(1);
    });
});
