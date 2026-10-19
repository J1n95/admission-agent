import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const outputRoot = process.env.ADMISSION_EVAL_OUTPUT_DIR || join(root, "outputs", "model-ab");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runDir = join(outputRoot, `full-flow-${runId}`);
const dataDir = join(runDir, "data");
const maximumCny = Number(process.env.FULL_FLOW_MAX_CNY || 5);
const hasExplicitScenario = ["--issue1", "--issue2", "--timeout-repro"].some(flag => process.argv.includes(flag));
const runIssue1 = process.argv.includes("--issue1") || !hasExplicitScenario;
const runIssue2 = process.argv.includes("--issue2");
const runTimeoutRepro = process.argv.includes("--timeout-repro");

mkdirSync(dataDir, { recursive: true });
copyFileSync(join(root, "build", "desktop-seed", "cases-seed.sqlite"), join(dataDir, "cases.sqlite"));
process.env.ADMISSION_DATA_DIR = dataDir;
process.env.ADMISSION_AGENT_DATA_DIR = join(root, "build", "desktop-seed");
process.env.AI_MAX_TOKENS = "4000";

const calls = [];
const nativeFetch = globalThis.fetch;
let estimatedCostCny = 0;

function stageOf(body) {
  const prompt = String(body?.messages?.[0]?.content || "");
  if (prompt.includes("硕士项目筛选器")) return "screening";
  if (prompt.includes("跨项目") || prompt.includes("academicCenters")) return "calibration";
  return "assessment";
}

function conservativeCost(usage = {}) {
  const input = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  const cacheHit = Number(usage.prompt_cache_hit_tokens || 0);
  const cacheMiss = Number(usage.prompt_cache_miss_tokens || Math.max(0, input - cacheHit));
  return (cacheHit * 0.04 + cacheMiss * 2 + output * 8) / 1_000_000;
}

globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(String(options.body || "{}"));
  const estimatedInput = Math.ceil(String(options.body || "").length / 3);
  const maximumOutput = Number(body.max_tokens || 4000);
  const nextWorstCase = (estimatedInput * 2 + maximumOutput * 8) / 1_000_000;
  if (estimatedCostCny + nextWorstCase > maximumCny) {
    throw new Error(`全流程验收预算预检未通过：预计下一次请求可能使费用超过 ${maximumCny} 元。`);
  }
  const startedAt = performance.now();
  const response = await nativeFetch(url, options);
  const payload = await response.clone().json().catch(() => ({}));
  const usage = payload?.usage || {};
  const costCny = conservativeCost(usage);
  estimatedCostCny += costCny;
  calls.push({
    stage: stageOf(body), model: body.model, status: response.status,
    durationMs: Math.round(performance.now() - startedAt), usage, costCny
  });
  return response;
};

const financeTarget = { regions: ["香港"], targetSchools: ["香港大学"], fields: ["finance"], consent: true };
const scenarios = [
  ...(runIssue1 ? [
    {
      id: "ordinary-strong-finance",
      expected: "强经历双非不应因院校档次被机械压在弱经历985之下",
      payload: { ...financeTarget, profile: {
        university: "南京财经大学", major: "economics", majorName: "金融学",
        gpaScale: "100", gpaValue: 89, languageTest: "IELTS", language: 7.5,
        internships: [
          { direction: "finance", companyTypes: ["securities"] },
          { direction: "finance", companyTypes: ["bank"] },
          { direction: "finance", companyTypes: ["asset-management"] }
        ],
        researches: [{ direction: "finance" }], awards: [{ direction: "finance" }],
        projects: [{ direction: "finance" }]
      } }
    },
    {
      id: "elite-weak-finance",
      expected: "弱经历985可以受院校背景加成，但不能自动压过明显更强的双非资料",
      payload: { ...financeTarget, profile: {
        university: "厦门大学", major: "economics", majorName: "金融学",
        gpaScale: "100", gpaValue: 78, languageTest: "IELTS", language: 6.5,
        internships: [], researches: [], awards: [], projects: []
      } }
    }
  ] : []),
  ...(runIssue2 ? [
    {
      id: "industrial-design-direction",
      expected: "工业设计不应仅因共享design标签直接匹配时尚设计或建筑设计",
      payload: { regions: ["香港"], targetSchools: ["香港理工大学"], fields: ["design", "arts"], consent: true, profile: {
        university: "中国美术学院", major: "design", majorName: "工业设计",
        gpaScale: "100", gpaValue: 84, languageTest: "IELTS", language: 7,
        internships: [{ direction: "industrial-design", companyTypes: ["design-studio"] }],
        researches: [], awards: [], projects: [{ direction: "product-design" }]
      } }
    },
    {
      id: "journalism-direction",
      expected: "新闻传播不应仅因共享media标签直接匹配创意媒体制作",
      payload: { regions: ["香港"], targetSchools: ["香港城市大学"], fields: ["media"], consent: true, profile: {
        university: "南京财经大学", major: "media", majorName: "新闻学",
        gpaScale: "100", gpaValue: 85, languageTest: "IELTS", language: 7,
        internships: [{ direction: "journalism", companyTypes: ["media"] }],
        researches: [], awards: [], projects: []
      } }
    }
  ] : []),
  ...(runTimeoutRepro ? [{
    id: "screening-timeout-regression",
    expected: "正常的十余秒模型延迟不应被桌面端误判为项目初筛失败",
    payload: { regions: ["香港"], targetSchools: ["香港大学", "香港中文大学", "香港科技大学", "香港理工大学", "香港城市大学"],
      fields: ["business", "finance", "accounting"], consent: true, profile: {
        university: "杭州师范大学", major: "economics", majorName: "金融学",
        gpaScale: "100", gpaValue: 88, languageTest: "IELTS", language: 7,
        internships: [], researches: [], awards: [], projects: []
      } }
  }] : [])
];

assert.ok(scenarios.length, "没有选择全流程验收场景");
const { analyzeWithLegacyAgent } = await import("../desktop/legacy-analysis.mjs");
const results = [];
for (const scenario of scenarios) {
  const startedAt = performance.now();
  try {
    const report = await analyzeWithLegacyAgent(scenario.payload);
    results.push({
      id: scenario.id, expected: scenario.expected, ok: true,
      durationMs: Math.round(performance.now() - startedAt), payload: scenario.payload,
      summary: report.results.map(item => ({
        id: item.programme.id, name: item.programme.name, center: item.result.center,
        low: item.result.low, high: item.result.high, confidence: item.result.confidence,
        caseCount: item.programme.caseCount, fit: item.result.fit,
        reasoning: item.result.reasoning, uncertainties: item.result.uncertainties
      })),
      screening: report.screening, assessmentExecution: report.assessmentExecution
    });
  } catch (error) {
    results.push({ id: scenario.id, expected: scenario.expected, ok: false,
      durationMs: Math.round(performance.now() - startedAt), payload: scenario.payload,
      error: String(error?.stack || error) });
  }
}

const byId = Object.fromEntries(results.map(item => [item.id, item]));
const strong = byId["ordinary-strong-finance"];
const weak = byId["elite-weak-finance"];
const commonFinance = strong?.ok && weak?.ok
  ? strong.summary.filter(item => weak.summary.some(other => other.id === item.id)).map(item => ({
      id: item.id, ordinaryStrong: item.center,
      eliteWeak: weak.summary.find(other => other.id === item.id).center
    })) : [];
const checks = {
  allRunsCompleted: results.every(item => item.ok),
  commonFinance,
  strongOrdinaryCanOutrankWeakElite: commonFinance.length
    ? commonFinance.some(item => Number(item.ordinaryStrong) > Number(item.eliteWeak)) : null,
  industrialDesignSelected: byId["industrial-design-direction"]?.screening?.selectedProgrammeIds || null,
  journalismSelected: byId["journalism-direction"]?.screening?.selectedProgrammeIds || null
};
const output = { runId, maximumCny, estimatedCostCny, calls, checks, results };
writeFileSync(join(runDir, "results.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ runDir, maximumCny, estimatedCostCny, calls: calls.length, checks,
  scenarios: results.map(item => ({ id: item.id, ok: item.ok, durationMs: item.durationMs,
    selected: item.screening?.selectedProgrammeIds, error: item.error?.split("\n")[0] })) }, null, 2));
if (!checks.allRunsCompleted) process.exitCode = 1;
