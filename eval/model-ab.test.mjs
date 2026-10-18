import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { impossibleRankClaims } from "./model-ab.mjs";

test("obvious impossible ranking claims are flagged separately from structural validity", () => {
  assert.deepEqual(impossibleRankClaims({ basis: ["排名第19（共18人）", "rank 12/11", "在18例案例中排名第19，为最低位", "排名第2（共4人）"] }),
    ["第19（共18人）", "rank 12/11", "在18例案例中排名第19"]);
});

test("dry run freezes three evaluation layers and a bounded budget without credentials", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" };
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "dry-run");
  assert.deepEqual(report.stages, { selection: 8, assessment: 16, ranking: 6 });
  assert.equal(report.scenarios.length, 15);
  assert.equal(report.calls.length, 30);
  assert.ok(report.combinedConservativeEstimateCny < 10);
  assert.equal(report.scenarios.find(item => item.scenario === "assessment-cityu-eie").approvedCaseCount > 0, true);
  assert.equal(report.scenarios.find(item => item.scenario === "assessment-hku-infrastructure-engineering-management").approvedCaseCount, 0);
  assert.equal(report.costSemantics.quality.includes("不是真实录取率"), true);
  const blocked = spawnSync(process.execPath, ["eval/model-ab.mjs", "--run", "--max-cny=10"], { cwd, env, encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /未发起模型请求/);
});

test("DeepSeek prompt review covers zero, sparse, and larger case sets within the budget", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" };
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--deepseek-review"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "deepseek-review");
  assert.deepEqual(report.stages, { selection: 1, assessment: 4, ranking: 1 });
  assert.equal(report.scenarios.length, 6);
  assert.equal(report.calls.length, 6);
  assert.deepEqual(report.scenarios.filter(item => item.stage === "assessment").map(item => item.approvedCaseCount), [2, 0, 4, 17]);
  assert.equal(report.calls.every(item => item.provider === "DeepSeek" && item.model === "deepseek-flash"), true);
  assert.ok(report.combinedConservativeEstimateCny < 1);
});

test("cross-discipline dry run covers four synthetic backgrounds and all three stages", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" };
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--cross-discipline"], {
    cwd, env, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "cross-discipline");
  assert.deepEqual(report.stages, { selection: 4, assessment: 8, ranking: 4 });
  assert.equal(report.calls.length, 16);
  assert.equal(report.calls.every(item => item.provider === "DeepSeek" && item.model === "deepseek-flash"), true);
  assert.ok(report.combinedConservativeEstimateCny < 2);
  assert.equal(new Set(report.scenarios.map(item => item.scenario.split("-").slice(0, 2).join("-"))).size, 4);
});

test("expanded cross-discipline dry run adds education and psychology without repeating baseline calls", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--cross-discipline-expanded"], {
    cwd, env: { ...process.env, DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.stages, { selection: 2, assessment: 4, ranking: 2 });
  assert.equal(report.calls.length, 8);
  assert.ok(report.calls.every(item => /cross-(education|psychology)-/.test(item.scenario)));
  assert.ok(report.combinedConservativeEstimateCny < 2);
});

test("GPA comparison freezes paired stages and case counts within budget", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--gpa-compare"], {
    cwd, env: { ...process.env, DASHSCOPE_API_KEY: "", DEEPSEEK_API_KEY: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "gpa-compare");
  assert.deepEqual(report.stages, { selection: 2, assessment: 4, ranking: 2 });
  assert.equal(report.calls.length, 8);
  assert.ok(report.calls.every(item => item.provider === "DeepSeek" && item.model === "deepseek-flash"));
  assert.ok(report.combinedConservativeEstimateCny < 2);
  for (const stage of ["selection", "assessment", "ranking"]) {
    assert.equal(report.calls.filter(item => item.stage === stage).length, { selection: 2, assessment: 4, ranking: 2 }[stage]);
  }
  assert.deepEqual(
    report.scenarios.filter(item => item.stage === "assessment").map(item => item.approvedCaseCount),
    [11, 5, 11, 5]
  );
});

test("school-tier smoke holds one programme and four assessment calls under one yuan", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--school-tier-smoke"], {
    cwd, env: { ...process.env, DEEPSEEK_API_KEY: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "school-tier-smoke");
  assert.deepEqual(report.stages, { selection: 0, assessment: 4, ranking: 0 });
  assert.equal(report.calls.length, 4);
  assert.ok(report.scenarios.every(item => item.programmeId === "hkust-ee" && item.approvedCaseCount === 29));
  assert.ok(report.calls.every(item => item.provider === "DeepSeek" && item.model === "deepseek-flash"));
  assert.ok(report.combinedConservativeEstimateCny < 1);
});

test("non-elite sweep holds ten paired directions and all three agent stages under five yuan", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["eval/model-ab.mjs", "--non-elite-sweep"], {
    cwd, env: { ...process.env, DEEPSEEK_API_KEY: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "non-elite-sweep");
  assert.deepEqual(report.stages, { selection: 20, assessment: 20, ranking: 8 });
  assert.equal(new Set(report.scenarios.filter(item => item.stage === "selection")
    .map(item => item.scenario.slice("cross-nonelite-".length, -"-selection".length))).size, 20);
  assert.ok(report.calls.every(item => item.provider === "DeepSeek" && item.model === "deepseek-flash"));
  assert.ok(report.combinedConservativeEstimateCny < 5);
});
