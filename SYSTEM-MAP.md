# 系统地图：案例采集 Agent + SQLite + RAG

这份文件回答“每一阶段在哪里做”，并区分已完成和仍需人工介入的部分。

## 总流程

```text
公开网页
  -> collector/agent.mjs（抓取、调用抽取模型、校验、去重）
  -> collector/data/cases.sqlite（pending / needs-review）
  -> 自动分流（高置信度自动通过，疑难记录保留）
  -> knowledge-base.mjs（只读取 approved 案例，构建检索证据）
  -> server.mjs /api/analyze（调用分析模型，输出概率参考与范围）
  -> app.mjs（网页展示）
```

## 1. 外部 API 单页抽取

- 抓网页与清理 HTML：`collector/agent.mjs`
- 抽取提示词：`collector/prompts/extraction-system.txt`
- API 配置：项目根目录 `.env`，变量是
  `COLLECTOR_AI_API_URL`、`COLLECTOR_AI_API_KEY`、`COLLECTOR_AI_MODEL`
- 单页入口：
  `node --env-file=.env collector/agent.mjs collect "页面URL" --dry-run`
- `--dry-run` 会调用模型但不写 SQLite；去掉它才会入库。

这里的模型职责是“从网页原文中筛选并结构化字段”，不是判断录取概率。

## 2. Agent 循环

- 目标、状态、停止条件：`collector/agent.mjs` 的 `runCollectionAgent()`、
  `planNextAgentAction()`
- 运行记录：SQLite 的 `agent_runs`、`agent_steps` 表
- 目标命令：
  `node collector/agent.mjs run cuhk-ee --target-approved=10 --max-pages=5`

它会检查已有覆盖量、待审核数量、来源候选、页面/API/错误预算，然后决定继续抓取或停止。
当前已经有来源候选和回退来源，但还不是开放式网络搜索 Agent；来源仍来自 `master-data.mjs` 与 `sources.json`。

## 3. SQLite 与人工审核

- 数据库：`collector/data/cases.sqlite`
- 表：`cases`、`case_sources`、`institutions`、`programmes`、`agent_runs`、`agent_steps`
- 存取与迁移：`collector/store.mjs`
- 审核队列：`outputs/review-queue.md`
- 生成审核队列：`npm.cmd run collector:review-report`
- 源文核验辅助：`npm.cmd run collector:verify-review -- --programme=cuhk-ee --limit=20`
- 浏览器审核页：`http://localhost:4173/review.html`
- 自动分流接口：页面上的“自动分流高置信度案例”；只会通过高置信度记录，不删除原始数据。
- 单条审核：
  `node collector/agent.mjs approve "fingerprint"`
  或
  `node collector/agent.mjs reject "fingerprint"`

默认只有 `approved` 案例进入 RAG。自动分流可以减少人工逐条操作；`needs-review` 仍作为隔离区保留，避免模型误读、串人或推断出的 GPA 直接进入分析。

不同中介的案例通常不是同一个申请人，因此跨来源默认按独立样本处理。只有身份字段高度一致时才尝试合并；更多情况下，来源用于比较项目资料覆盖和来源偏差，而不是强行匹配申请人。

## 4. RAG 检索

- 检索与文档构建：`knowledge-base.mjs`
- 数据来源：只读取 SQLite 中 `review_status = 'approved'` 的案例，以及项目官方资料。
- 当前技术：结构化筛选、标签匹配和证据排序；暂未使用 Embedding/向量库。
- 状态接口：`GET /api/knowledge/status`

当前样本规模下，结构化检索更容易审计。案例数量明显扩大并完成检索评测后，再考虑 Embedding。

## 5. AI 综合分析

- HTTP 路由：`server.mjs` 的 `/api/analyze`
- 分析提示词：`prompts/assessment-system.txt`
- 模型输入：用户 profile、项目官方资料、RAG 返回的证据和案例分布
- 用户结果：概率参考点与区间、证据引用和个性化说明

这不是“真实录取率计算器”。样本不足或项目 approved 案例少于 3 条时，接口只返回 `evidence-only`，不生成概率。

## 6. 当前验收状态（2026-08-10）

- 测试：7 组测试全部通过。
- 项目主表：14 个项目，112 份官方资料，18 个官方来源。
- SQLite 案例：102 条；59 pending、4 needs-review、10 rejected；CUHK EE 14 条、CUHK IE 15 条已完成来源核验并 approved。
- CUHK EE 与 CUHK IE 已通过 SQLite → RAG → AI 冒烟测试；其余项目仍因没有达到审核门槛而返回 evidence-only。

## 7. 可选人工抽样

打开 `http://localhost:4173/review.html`，对自动通过结果做少量抽样；只有冲突或低置信度记录才需要人工处理：

1. 原网页中确实存在该申请人边界；
2. 项目、年份、本科院校、GPA 原文和语言成绩逐字对应；
3. 实习、科研、竞赛和奖项没有串到其他申请人。

批量自动通过不会删除任何原始记录；如果抽样发现错误，可以在网页中排除，或把记录重新保留待处理。
