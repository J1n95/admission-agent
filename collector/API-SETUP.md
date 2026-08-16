# 采集模型 API 测试

采集器只支持 OpenAI Chat Completions 兼容接口。`COLLECTOR_AI_API_URL` 必须填写完整的 `/chat/completions` 地址。

## DeepSeek V4 Flash

1. 把根目录 `.env.example` 复制为 `.env`。
2. 只在本机 `.env` 中填写 API Key；不要把 Key 发到聊天、截图或提交到 Git。
3. 先执行不会写数据库的端到端测试：

```powershell
node --env-file=.env collector/agent.mjs collect "https://www.compassedu.hk/offers_1727" --dry-run
```

`--dry-run` 不写 SQLite，但仍会真实调用模型并产生费用。

确认输出中的申请人边界、GPA 原文、语言类型和经历原文后，再写入数据库：

```powershell
node --env-file=.env collector/agent.mjs collect "https://www.compassedu.hk/offers_1727"
node collector/agent.mjs status
node collector/agent.mjs list --limit=20
```

当前使用的系统提示词位于 `collector/prompts/extraction-system.txt`。

## 临时环境变量方式

不想保存 `.env` 时，可在同一个 PowerShell 窗口中运行：

```powershell
$env:COLLECTOR_AI_API_URL = "https://api.deepseek.com/chat/completions"
$env:COLLECTOR_AI_MODEL = "deepseek-v4-flash"
$env:COLLECTOR_AI_JSON_MODE = "true"
$env:COLLECTOR_AI_THINKING = "disabled"
$secureKey = Read-Host "DeepSeek API Key" -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try { $env:COLLECTOR_AI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }

node collector/agent.mjs collect "https://www.compassedu.hk/offers_1727" --dry-run
Remove-Item Env:COLLECTOR_AI_API_KEY
```
