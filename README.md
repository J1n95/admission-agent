# 录取参照 · Admission Reference

一个面向香港及新加坡硕士申请的 AI 辅助分析原型。

系统将申请人的本科院校、专业、成绩、课程、实习、科研、竞赛和申请偏好，与官方项目资料及公开录取案例结合起来，帮助申请人筛选匹配项目、理解竞争力和发现材料短板。

> 本项目只提供申请分析参考，不代表学校官方要求、录取线或录取结果。

## 产品预览

![录取参照封面](docs/images/cover.png)

### 申请人信息填写

![基础信息填写](docs/images/application-basic.png)

![申请地区、学校和方向](docs/images/application-direction.png)

### 分析结果

![项目分析结果](docs/images/result-overview.png)

![个性化匹配与申请建议](docs/images/result-details.png)

## 能做什么

- 录入本科院校、专业、成绩制度、GPA/均分和语言成绩。
- 添加课程、实习、科研、项目、竞赛和奖项经历。
- 按申请地区、目标学校范围和专业方向筛选项目。
- 根据本科专业、课程和经历进行第一层项目匹配。
- 结合项目官方资料和公开录取案例进行第二层分析。
- 输出概率参考、案例分布、项目匹配点、优势短板和 CV/PS 建议。
- 支持管理员审核案例、维护项目资料和查看用户分析反馈。
- 支持结构化案例检索，并预留可选的 Embedding 向量检索能力。

## 分析流程

```text
申请人填写背景
       ↓
地区、学校、专业和课程筛选
       ↓
第一层 Agent 选择匹配项目
       ↓
检索官方项目资料与已审核案例
       ↓
第二层 Agent 综合分析
       ↓
概率参考、匹配点和申请建议
```

## 使用的方法

- 结构化筛选：按地区、学校、专业、课程、成绩和经历进行召回。
- 两层 Agent：第一层负责选项目，第二层负责案例与项目综合分析。
- RAG 思路：优先使用已审核案例和项目官方资料作为分析依据。
- LLM 信息抽取：识别案例中的项目名称、GPA、语言成绩、院校层次和经历。
- OCR 辅助识别：处理图片型或复杂排版的公开案例页面。
- 规则校验：负责项目匹配、字段校验、去重、审核状态和安全边界。
- SQLite 数据管理：保存项目主表、院校主表、案例、分析记录和反馈结构。

## 本地运行

要求 Node.js 版本支持 `node:sqlite`，推荐 Node.js 22 或更高版本。

```powershell
git clone <your-repository-url>
Set-Location admission-agent
Copy-Item .env.example .env
node server.mjs
```

打开：

```text
http://127.0.0.1:4173
```

健康检查：

```text
http://127.0.0.1:4173/api/health
```

## API 配置

API 只允许通过服务端 `.env` 配置，不能写入前端代码、README 或 GitHub 仓库。

复制 `.env.example` 为 `.env` 后，按需配置兼容 Chat Completions 的模型接口：

```text
COLLECTOR_AI_API_URL=
COLLECTOR_AI_API_KEY=
COLLECTOR_AI_MODEL=
```

如果不配置 API，网站仍可运行和展示项目资料，但不会生成新的个性化 AI 分析。

管理员入口需要配置：

```text
ADMIN_PASSWORD=
```

## 数据说明

真实案例数据库、用户申请记录、问卷反馈、采集缓存和运行备份不会上传到 GitHub。

`collector/data/cases.sqlite` 是本地运行数据库，首次启动时在本机生成或使用本地已有数据。项目中的主表代码和公开资料结构可以公开，但真实用户数据和完整案例库应当放在受保护的存储中。

## Docker 运行

```powershell
docker compose up -d --build
```

生产环境必须：

- 使用强管理员密码。
- 通过环境变量注入 API 密钥。
- 使用持久化磁盘保存 SQLite 数据。
- 在反向代理或 CDN 层配置 HTTPS 和访问限流。
- 不公开管理员审核页面和真实案例数据库。

## 测试

```powershell
npm.cmd test
```

## 项目状态

这是一个持续迭代中的个人项目/研究原型，当前重点是验证项目筛选、案例检索、AI 分析解释和用户反馈闭环。公开录取案例具有样本偏差，项目结果不能替代学校官网和正式申请材料。

## License

暂未设置开源许可证。未经作者授权，不建议将本项目用于商业服务。
