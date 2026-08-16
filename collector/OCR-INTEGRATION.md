# Qwen3.8-Max 图片案例采集记录

## 当前问题

部分留学案例页的核心信息放在 PNG/JPG 图片里。Node.js 原先只抓 HTML 并用 `stripHtml()` 提取可见文字，因此图片里的学校、项目、GPA、语言成绩不会进入抽取模型，可能出现 `extracted: 0`。

## 解决方案

```text
Node.js 抓取 HTML
  → 检测 img/src、data-src 等图片地址
  → 图片较多且正文较短时调用 Qwen3.8-Max
  → 将 OCR 原文与网页文字合并
  → 交给现有结构化案例抽取模型
  → 保存 sourceEvidence.ocr 及原始图片 URL
```

Qwen3.8-Max 只负责读取图片并返回图片文字；最终的案例 JSON 仍由 DeepSeek 从网页正文与图片文字中统一抽取。

## 配置

在项目根目录 `.env` 中补充百炼配置，不要把真实 Key 提交到 Git：

```env
COLLECTOR_OCR_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
COLLECTOR_OCR_API_KEY=你的百炼API_KEY
COLLECTOR_OCR_MODEL=qwen3.8-max
COLLECTOR_OCR_ENABLE_THINKING=true
COLLECTOR_OCR_TIMEOUT_MS=240000
COLLECTOR_OCR_MODE=fallback
COLLECTOR_OCR_TEXT_THRESHOLD=5000
```

也可以不单独填写 `COLLECTOR_OCR_API_KEY`，改用环境变量 `DASHSCOPE_API_KEY`。代码同时接受完整 `/chat/completions` 地址和兼容接口根地址。

## 测试

```powershell
node --env-file=.env collector/agent.mjs collect "https://www.51liuxue.com/c/2.shtml" --dry-run
```

输出中的 `ocr.used`、`ocr.imageCount`、`ocr.textLength` 用于判断 OCR 是否生效。`--dry-run` 仍会调用模型并产生费用，只是不写数据库。若要强制测试，临时设置 `COLLECTOR_OCR_MODE=always`，测试后改回 `fallback`。

OCR 调用失败时默认保留原文字抽取流程；设置 `COLLECTOR_OCR_REQUIRED=true` 后，OCR失败会直接使该页面报错。

## 安全与数据边界

- 只发送网页中发现的图片 URL 和固定 OCR 指令。
- OCR结果作为证据文本参与字段核验，并记录图片 URL，不把 API Key 写入数据库。
- 普通文字页面不会调用 OCR；默认仅对正文少于 5000 字符的图片页面触发。
