# Codex DeepSeek Gateway

[English](README.md) | 简体中文

一个让 Codex 使用 DeepSeek 模型的轻量级本地网关，实际使用体验几乎与原生 GPT 模型一致。Codex 继续使用 OpenAI `Responses API` 通信；网关把每个请求转换为 DeepSeek 兼容的 `Chat Completions`，再把结果转换回来，因此工具、reasoning、流式输出和会话恢复都能照常工作。

```text
Codex /v1/responses
  -> 请求规范化与映射
  -> DeepSeek /chat/completions
  -> JSON / SSE 规范化与映射
  -> Codex Responses items 与事件
```

软件包：[@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

## 要求

- [Node.js](https://nodejs.org/en/download) 22 或更新版本
- 一个 [DeepSeek API key](https://platform.deepseek.com/api_keys)
- [Codex CLI](https://developers.openai.com/codex) 0.144.0 或更新版本

## 安装与启动

安装软件包，并把运行时复制到 `~/.codex/deepseek-gateway`：

```sh
npm install -g @galaxy-yearn/codex-deepseek-gateway
codex-deepseek-gateway --version          # 确认安装的版本（简写：-v）
codex-deepseek-gateway install            # 首次安装会自动打开配置文件
codex-deepseek-gateway install --no-edit  # 安装但不打开配置文件
```

把你的 DeepSeek API key 填入 `~/.codex/deepseek-gateway/config/gateway.local.json`：

```json
{
  "upstreamApiKey": "sk-...",
  "codexPromptLanguage": "zh"
}
```

`install` 不会覆盖已有的 `gateway.local.json`。启动网关并检查状态：

```sh
codex-deepseek-gateway start
codex-deepseek-gateway status
```

`status` 应显示 `Gateway status: HEALTHY`。

## 配置 Codex Provider

Codex 通过 `~/.codex/config.toml` 中的 provider 条目连接网关。launcher 命令（下一节的 `codex-deepseek-gateway new` / `sessions`）不会代为创建，请自行把以下块写入该文件（文件不存在则新建），并重启正在运行的 Codex：

```toml
[model_providers.deepseek-gateway]
name = "DeepSeek"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
```

顶层模型设置可以不写进 `config.toml`：launcher 每次启动都会传入 `model_provider`、你选定的 `model` 和 `model_reasoning_effort`，以及 `model_supports_reasoning_summaries = true` 和 `model_reasoning_summary = "auto"`。只有当你希望普通 `codex` 也能使用网关时才需要补上；此时 launcher 会把你的 `model` 和 `model_reasoning_effort` 作为默认值：

```toml
model_provider = "deepseek-gateway"
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
model_supports_reasoning_summaries = true
model_reasoning_summary = "auto"
```

即便如此，普通 `codex` 也不会加载下一节介绍的随包 model catalog；优先使用 launcher 命令。

## 在 Codex 中使用

通过 launcher 启动 Codex：

```sh
codex-deepseek-gateway new       # 开始新对话
codex-deepseek-gateway sessions  # 从当前项目选择并恢复会话
```

这两个命令会用上文的 provider 覆盖配置启动 Codex，并加载随包 model catalog：随网关一起分发的 DeepSeek 模型、system prompts（按 `codexPromptLanguage` 提供英文或中文）、reasoning 档位和 personalities。

不带参数时，`new` 先选模型，再选 Codex reasoning effort。`sessions` 先显示会话选择器（Up/Down 浏览，按 `n` 改为开始新对话），再选模型和 effort。

常用的非交互形式：

```sh
codex-deepseek-gateway new --model deepseek-v4-flash --reasoning-effort low
codex-deepseek-gateway sessions --print             # 列出恢复命令
codex-deepseek-gateway sessions --all               # 包含所有项目的会话
codex-deepseek-gateway sessions --exec <id-or-row>  # 按行号或 session id 直接恢复
```

在 launcher 启动的 Codex TUI 中，`/model` 可在随包 DeepSeek 模型和 reasoning efforts 之间切换，`/personality` 可在 catalog 提供的 personality 之间切换。

### 模型与 Reasoning

网关提供两个模型别名：`deepseek-v4-flash` 和 `deepseek-v4-pro`。Codex reasoning effort 映射到 DeepSeek thinking mode：

| Codex effort | DeepSeek 请求 |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`，`reasoning_effort = high` |
| `high` | `thinking.type = enabled`，`reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`，`reasoning_effort = max` |
| `max` | `thinking.type = enabled`，`reasoning_effort = max` |

DeepSeek 的思维链会在 Codex TUI 中完整显示，原始 `reasoning_content` 同时为模型历史保留。

随包 catalog 声明 1M token 的 context window，并在约 900K token 时触发自动压缩；请求未设置输出上限时，剩余约 100K 作为 DeepSeek 默认输出预算（可用 `upstreamMaxTokens` 覆盖）。catalog 还向 Codex 注册了模型别名和 reasoning 档位，因此需要校验模型名的功能（如原生 sub-agents）也接受这些 DeepSeek 模型。

## 项目优势

核心目标是让 DeepSeek 在 Codex 中尽量贴近原生 GPT 模型的行为：同样的工作流和会话生命周期、DeepSeek 可使用每一个 Codex 工具（含并行调用与会话中途通过 `tool_search` 公开的工具）、工具运行期间有实时进度说明。工具执行、历史与恢复仍完全归 Codex 管理。

在此之上，网关额外提供：

- 替换模型列表：随包 catalog 把 DeepSeek 模型与 reasoning 档位注册进 Codex，`/model` 可直接切换，需要校验模型名的功能（如原生 sub-agents）也照常可用。
- 更强的 compact 机制：/compact 由网关亲自执行，生成的检查点在进入会话历史前逐一校验，异常模型输出会被拒绝；thinking 档位与输出预算可调。
- 极高的缓存命中率：请求构造针对 DeepSeek 上下文缓存的特点做了优化，多轮会话中命中率极高，费用与响应延迟显著降低。
- Web 搜索：可选接入 Tavily 和 Firecrawl，让 Codex 的 Web 搜索请求真实可用。
- 调优的系统提示词：随包提供为 DeepSeek 适配的双语 system prompts 与 personalities。

## 配置参考

所有设置位于 `~/.codex/deepseek-gateway/config/gateway.local.json`。复制下面的代码块并按需修改；所示值即默认值（`sk-REPLACE_ME` 是占位符，网关会视作未设置）。每个键也可用 `UPPER_SNAKE_CASE` 形式的环境变量设置（环境变量优先）。修改后重启网关（先 `stop` 再 `start`）。

```json
{
  "upstreamApiKey": "sk-REPLACE_ME",
  "upstreamBaseUrl": "https://api.deepseek.com",
  "upstreamMaxTokens": 0,
  "host": "127.0.0.1",
  "port": 3000,
  "codexPromptLanguage": "en",
  "compactReasoningEffort": "max",
  "compactMaxTokens": 20000,
  "reasoningCacheEnabled": true,
  "debugPayload": false,
  "tavilyApiKey": "",
  "tavilyWebSearchEnabled": false,
  "tavilyMaxSearchRounds": 20,
  "firecrawlApiKey": "",
  "firecrawlWebFetchEnabled": false
}
```

- `upstreamApiKey` — 你的 [DeepSeek API key](https://platform.deepseek.com/api_keys)（也可用 `DEEPSEEK_API_KEY`）。
- `upstreamBaseUrl` — DeepSeek API 端点；参见 [DeepSeek API 文档](https://api-docs.deepseek.com/)。
- `upstreamMaxTokens` — DeepSeek 输出 token 上限；`0` 表示使用 catalog 的默认约 100K 预算。
- `host`、`port` — 网关监听地址。
- `codexPromptLanguage` — prompt catalog 语言，`en` 或 `zh`；无效值回退到 `en`。
- `compactReasoningEffort` — 压缩使用的 thinking effort，`high` 或 `max`。
- `compactMaxTokens` — 压缩输出预算，硬上限 100000。
- `reasoningCacheEnabled` — 设为 `false` 可关闭下文的 reasoning cache。
- `debugPayload` — 把每次请求的映射摘要写入 `gateway.debug.log`（5 MB 轮转）。
- `tavilyApiKey`、`tavilyWebSearchEnabled` — [Tavily](https://docs.tavily.com/documentation/quickstart) Web 搜索后端（见「Web 搜索」）。
- `tavilyMaxSearchRounds` — 单轮对话内的 Web 搜索轮数，硬上限 `40`。
- `firecrawlApiKey`、`firecrawlWebFetchEnabled` — [Firecrawl](https://docs.firecrawl.dev/introduction) 页面读取后端（见「Web 搜索」）。

安装目录下有两个由网关自行管理的支持文件：

- `config/model-aliases.json` — 模型别名；每次 install 和 start 时刷新。
- `state/reasoning-cache.jsonl` — 有界缓存（默认 1000 条消息 / 16 MB），用于在网关重启后还原工具轮次的 DeepSeek 原始 reasoning；`install` 会保留，也可随时安全删除。

## Web 搜索（可选）

Web 搜索默认关闭。先获取 [Tavily API key](https://app.tavily.com/home)，再启用搜索：

```json
{
  "tavilyApiKey": "tvly-...",
  "tavilyWebSearchEnabled": true
}
```

如果还需要打开页面读取，先获取 [Firecrawl API key](https://www.firecrawl.dev/app/api-keys)，再启用该功能：

```json
{
  "firecrawlApiKey": "fc-...",
  "firecrawlWebFetchEnabled": true
}
```

之后 Codex 的 `web_search` / `web_search_preview` 请求会经由 Tavily 执行；配置 Firecrawl 后，DeepSeek 还能打开页面并在页面内搜索，每次搜索会自动读取排名第一的结果。流式输出在每个搜索轮次保持实时。`tavilyMaxSearchRounds` 限制单轮对话内的搜索轮数；达到上限时，网关会在一个最终轮次中收起 Web 工具，让模型基于已有结果作答。

## 版本更新

更新前先退出所有正在运行的 Codex 会话。更新网关时仍保持打开的会话可能在之后出错：其后续 compact 请求可能连续返回 `upstream_error`，需要重开会话才能恢复。

```sh
codex-deepseek-gateway update
```

`update` 要求网关已安装并配置 API key。它会停止网关，安装并运行 npm 上的 latest 版本，保留你的 `gateway.local.json`，重新安装本地运行时，然后运行 `status` 和 `doctor`，检查版本、进程身份、健康状态和配置。命令完成后，再用 `codex-deepseek-gateway new` 或 `codex-deepseek-gateway sessions` 重新启动 Codex 会话。

## 卸载

先停止网关，再删除本地运行时，最后卸载全局软件包：

```sh
codex-deepseek-gateway stop
codex-deepseek-gateway uninstall
npm uninstall -g @galaxy-yearn/codex-deepseek-gateway
```

`uninstall` 会删除本地运行时及其中的本地配置和状态。

## 命令速查

```sh
codex-deepseek-gateway install    # 把运行时复制到 ~/.codex/deepseek-gateway
codex-deepseek-gateway update     # 更新软件包并检查本地运行时
codex-deepseek-gateway start      # 启动本地网关
codex-deepseek-gateway stop      # 停止本地网关
codex-deepseek-gateway status     # 显示安装、进程和端点状态
codex-deepseek-gateway doctor     # 检查配置和请求映射
codex-deepseek-gateway new        # 通过 launcher 启动 Codex 对话
codex-deepseek-gateway sessions   # 选择并恢复 Codex 会话
codex-deepseek-gateway uninstall  # 删除本地运行时
```

`status` 是快速的本机检查：核对 CLI、已安装运行时和实际运行进程的版本，认证 PID 所属实例，显示运行时长，并检查进程实际使用的本地 API 端点。`doctor` 在此基础上检查网关配置、监听安全性、Codex CLI/provider、中英文 catalog 与模型 alias、本地模型端点、通过 `GET /models` 进行的 DeepSeek 认证连通性、reasoning cache，以及可选 Web 后端配置。它不会发送 completion，也不会实际调用 Tavily/Firecrawl。两个命令都可添加 `--json` 输出稳定的结构化报告。

运行 `codex-deepseek-gateway --help` 查看全部选项。

## 故障排查

- `codex-deepseek-gateway status` — `HEALTHY` 表示记录中的进程正在运行、身份认证通过、版本一致，并且实际端点可达。
- `codex-deepseek-gateway doctor` — 对完整的 Codex → 网关 → DeepSeek 配置链路给出 `OK`、`WARNING` 或 `FAIL`，并为每个警告或失败提供直接修复建议。
- 调试日志：在 `gateway.local.json` 中设置 `"debugPayload": true`，把每次请求的映射摘要写入 `~/.codex/deepseek-gateway/gateway.debug.log`（5 MB 轮转）。
- `stop` 不会终止无法验证身份的进程。使用 `stop --force` 前，先核对安装目录中的 `gateway.pid`。
- 更新后 compact 连续出现 `upstream_error`，通常是更新时会话仍处于打开状态；退出并重开该会话即可（见「版本更新」一节）。

## 局限

- Chat Completions 不是完整的 Responses API 替代品。没有本地 executor 的 Codex hosted tools 只会以普通 function tool 的形式声明给 DeepSeek，而不会被执行；Web 搜索是网关唯一亲自执行的 hosted tool。
- Tavily/Firecrawl 的 Web 模拟以文本为中心：不提供浏览器控制、截图、原始 HTML、cookies、crawl jobs 或私有网络访问。
- OpenAI `file_id` 值会原样透传；网关无法获取 OpenAI 托管的私有文件。
- 普通 `codex` 命令不会加载随包 model catalog；请使用 `new` / `sessions`。
- 恢复会话后，Codex 可能重复显示特定长 Markdown 轮次的尾部。历史本身没有重复；这是上游 Codex TUI 的显示问题。

## 许可证

MIT。见 [LICENSE](LICENSE)。
