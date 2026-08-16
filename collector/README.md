# 案例采集 Agent

这是独立于用户分析流程的离线采集器。它把候选案例写入本地 SQLite 待审核库，不直接修改正式项目知识库。

## 流程

`采集目标 → 检查SQLite覆盖 → 选择项目来源 → robots.txt检查 → 页面抓取 → AI结构化抽取 → 主表对齐 → 字段校验 → 指纹去重 → cases.sqlite → 证据审核 → RAG`

最低期望字段：录取项目、本科院校、GPA、语言成绩、录取年份；实习、科研和奖项按网页实际披露保存，不允许模型补写。

案例抽取提示词位于 `prompts/extraction-system.txt`。它与网站生成概率使用的 `../prompts/assessment-system.txt` 是两套不同提示词：前者只负责从网页提取事实，后者负责基于RAG证据进行申请判断。

主数据保存在 `data/cases.sqlite`；`data/raw-cases.jsonl` 是追加式候选日志。SQLite同时保存院校主表、项目主表、案例、Agent运行记录和每一步动作。模型抽取的案例一律进入 `pending` 或 `needs-review`；只有确定性高置信规则，或连续两次独立 LLM 审核得到相同的高置信度结论且每次至少引用两处原文证据，才可转为 `approved` 并进入 RAG。其余记录留在隔离区供后续复核。

## 配置

在 `sources.json` 中添加允许采集的域名、案例详情页URL特征和入口页面。模型配置优先读取：

```text
COLLECTOR_AI_API_URL
COLLECTOR_AI_API_KEY
COLLECTOR_AI_MODEL
```

如果未设置，则回退读取网站分析流程使用的 `AI_API_URL`、`AI_API_KEY`、`AI_MODEL`。

## 命令

```powershell
node collector/agent.mjs status
node collector/agent.mjs list --limit=20
node collector/agent.mjs show "案例fingerprint"
node collector/agent.mjs discover "公开案例列表页URL"
node collector/agent.mjs collect "公开案例详情页URL" --dry-run
node collector/agent.mjs collect "公开案例详情页URL"
node collector/agent.mjs crawl "待抓取URL列表.txt"
node collector/agent.mjs harvest "公开案例列表页URL" --limit=20
node collector/import-batch.mjs "人工核对或Codex抽取的批次.json"
node collector/agent.mjs run cuhk-ee --target-approved=10 --max-pages=5
node collector/agent.mjs approve "案例fingerprint"
node collector/agent.mjs reject "案例fingerprint"
node collector/agent.mjs runs
node collector/agent.mjs coverage cuhk-ee
node collector/agent.mjs classify-programmes all --limit=832
node collector/agent.mjs programme-scopes
node collector/agent.mjs verify-programmes all --limit=832 --concurrency=8 --refresh
node collector/agent.mjs programme-status
npm.cmd run collector:review-report
npm.cmd run collector:programme-info -- --cached-only --concurrency=6
```

`programme-info-agent.mjs` 只读取港八新二项目的官方页面缓存，用配置的结构化模型整理项目要求、定位、学制、课程、资源、就业和相近项目区别，并按 section 写回 `programme_documents`，网站展示会自动读取这些缓存。`--cached-only` 只处理已有官方正文的项目；需要重新验证之前失败的官方入口时使用 `--uncached-only --retry-failed`。页面没有明确内容时保持空缺，不写入“null”或模型推测。

无人值守的低覆盖扩张入口是 `expansion-agent.mjs`，不依赖 Codex：

```powershell
npm.cmd run collector:expand -- --limit=2 --target-approved=15 --max-pages=6 --max-api-calls=3
# 只抓新加坡两校的计算机、数据和人工智能方向
npm.cmd run collector:expand -- --institutions=ntu,nus --focus-tags=computer,data,ai
```

它默认只按每项目近年 approved 缺口选择项目，跨来源搜索/轮换，记录每一步到 SQLite 和 JSON 报告，并使用锁文件防止重复运行；不会在每个批次自动导入 Mastermate 全站索引。需要做全站回填时显式追加 `--import-mastermate`，导入器只接受2021年及之后的案例。默认遇到待审核案例会暂停，确认隔离队列可继续处理时才显式加 `--allow-pending`。模型超时、来源失败和页面预算耗尽都会结束当前子任务并保留可恢复日志，不会静默使用本地项目筛选替代失败的模型抽取。

网站管理员也可以不经过 Codex 直接启动它：先在 `.env` 配置 `ADMIN_PASSWORD`，启动网站服务 `node server.mjs`，打开 `/admin.html` 登录后进入 `/review.html`。案例审核页里的“独立案例采集 Agent”面板可以启动、查看日志、刷新状态和停止采集；浏览器关闭不会取消已经启动的采集任务，前提是网站服务进程仍在运行。正式部署时应使用进程管理器保持网站服务运行，并在 HTTPS 下使用管理员入口。

管理员页面和所有 `/api/review/*`、`/api/collector/*` 写入/控制接口都需要管理员会话。没有配置 `ADMIN_PASSWORD` 时，系统会拒绝登录，不会使用默认密码。管理员会话只保存在当前服务进程内，服务重启后需要重新登录；单机原型适用，正式多实例部署时应替换为持久化会话和安全的密码哈希存储。

`harvest` 会从入口页发现案例详情页并直接进入批量采集。默认每批最多20页、串行执行、每页间隔2.5秒；可通过 `--limit` 和 `CRAWL_DELAY_MS` 调整。采集器遵守来源白名单与 `robots.txt`；社交平台、登录后页面和未获许可的站点暂不接入。

`status`、`list` 和 `show` 都直接读取 SQLite。数据库是二进制文件，不要用记事本打开；可以使用命令查看，也可以用支持 SQLite 的数据库浏览器打开 `data/cases.sqlite`。

院校身份参考数据位于 `data/reference/institutions.sqlite`：ROR 提供全球院校名称、别名和官网，教育部名单提供中国高校名称、学校标识码、主管部门、所在地和办学层次。教育部名单不包含本系统自行推断的 985/211 标签；`MOE`/`ROR` 只表示身份来源，不能直接当作排名或录取判断。

`run` 是目标驱动循环：每轮重新检查项目的已审核/待审核数量，决定停止或选择下一来源。停止条件包括达到目标、等待人工审核、页面/API/错误预算耗尽以及来源耗尽。它不会为了显得“自主”而在待审核数据堆积时继续花费API。

`--institutions` 接受港八新二主表中的学校 ID，`--focus-tags` 按项目主表的 `focusTags` 做“任一方向命中”筛选；不传这两个参数时扫描港八新二全部项目。管理员审核页提供同样的国家/地区、学校和项目方向选择器。

向量检索是结构化检索之后的补充：只对 `approved` 且2021年及之后的案例建立 embedding，并在同一具体项目内部按申请人向量与案例向量的余弦相似度排序，再和年份权重合并。配置 `.env` 中的 `VECTOR_SEARCH_ENABLED=true`、`EMBEDDING_MODEL` 和兼容 OpenAI 的 embedding 接口后，运行：

```powershell
npm.cmd run collector:build-embeddings
```

这个命令是增量的，只会为新增或字段发生变化的 approved 案例调用向量模型。网站分析请求会自动生成申请人查询向量；索引不存在或向量服务失败时，自动退回原来的结构化排序。

同一页面被多个项目任务访问时，采集器会按页面正文哈希和模型名复用 SQLite 抽取缓存；复用后仍会重新执行项目归属、字段审核和去重。页面内容或模型变化会自动失效缓存。
