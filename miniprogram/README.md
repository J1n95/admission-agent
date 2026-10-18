# 微信小程序用户端（云开发最小闭环）

小程序使用云环境 `cloud1-d2ga9t083d80375b6`，不再连接本机 `127.0.0.1`，也不需要配置 request 合法域名。

当前闭环：学校/专业检索 → 背景提交 → 旧版两层 Agent 项目筛选 → 全部审核案例分布分析 → 固定证据选择 → 逐项目 AI 判断 → 旧版证据契约校验 → 云数据库保存分析 → 问卷反馈。

## 首次部署

1. 用微信开发者工具重新打开 `miniprogram` 目录，让工具识别 `cloudfunctionRoot`。
2. 点击工具栏的云朵图标，确认当前环境为 `cloud1-d2ga9t083d80375b6`。
3. 在云开发控制台的数据库中创建五个集合：`analyses`、`feedback`、`cases`、`programmes`、`programme_evidence`。客户端不直接读写集合，权限全部设为“仅管理员可读写”。
4. 在对应集合中导入以下 UTF-8 JSON 文件。首次可选 Insert；以后重新生成数据时选择 Upsert：
   - `cases` ← `cloud-data/cases.json`
   - `programmes` ← `cloud-data/programmes.json`
   - `programme_evidence` ← `cloud-data/programme_evidence.json`
5. 为 `cases.programmeId`、`programmes.programmeId`、`programme_evidence.programmeId` 和 `analyses.createdAtMs` 建立升序索引；为 `analyses` 建立 `openid + createdAtMs` 联合索引。
6. 在资源管理器的 `cloudfunctions/admissionApi` 上右键，选择“上传并部署：云端安装依赖”。
7. 重新编译小程序，输入“中国矿业大学”和“自动化”验证候选项能弹出，再提交一份测试档案和问卷。

云函数已经迁入网页版 Agent 的案例分析、项目筛选提示词、项目评估提示词和证据契约。没有配置模型或模型结果没有通过证据契约时，只显示“待分析”，不会用本地公式编造概率。请在云函数配置中添加环境变量，绝不能写入小程序代码：

- `AI_API_URL`：兼容 OpenAI Chat Completions 的 HTTPS 地址；
- `AI_API_KEY`：模型平台密钥；
- `AI_MODEL`：模型名称；
- `ASSESSMENT_AI_TIMEOUT_MS=120000`；
- `PER_USER_DAILY_LIMIT=2`；
- `GLOBAL_DAILY_LIMIT=30`。

未配置付费模型时，默认测试额度为每人每天 20 次、全站每天 200 次；以上较低限制仅在启用付费模型后通过环境变量设置。

云函数自身超时已设为 300 秒。修改环境变量后，在 `cloudfunctions/admissionApi` 上右键重新执行“上传并部署：云端安装依赖”，再重新编译小程序。

## Agent 迁移边界

- 运行时使用全部审核成功案例计算旧版 `caseDistribution`，再只把旧 Agent 固定选出的代表案例正文和官方资料交给模型；不是只分析页面展示的 5 条案例。
- `collector` 采集 Agent 仍在本地离线运行，负责更新、审核和脱敏数据，不会在每次用户请求中爬网页。
- 微信云数据库替代本地 SQLite，微信云函数替代本地 HTTP 服务；其余分析行为由迁入的旧 Agent 模块与提示词控制。
- 当前没有导入可选向量嵌入，因此证据正文按旧 Agent 的无向量回退规则选择；全案例分布统计与证据契约不受影响。

## 数据与费用边界

- `catalog.json` 和 `cloud-data` 由 `node scripts/build-miniprogram-cloud-data.mjs` 从本地资料生成。
- 云数据库只接收审核通过案例的脱敏结构化字段、项目卡片和项目资料；不接收拒绝/待审案例、来源地址、原始网页、`raw_json`、本地 SQLite、管理员数据或密钥。
- `cloud-data` 已加入 `.gitignore`，只能手动导入云数据库，不会进入 GitHub。
- 每位用户和全站都有每日硬性次数限制；模型平台还应单独设置余额或消费上限。
- 停止测试时，先停用云函数并撤销模型密钥，再下架小程序。
