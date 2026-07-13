# Codex DeepSeek Gateway

[English](README.md) | 简体中文

一个用于在 Codex 中使用 DeepSeek 模型的轻量级本地网关。实际使用体验几乎与原生 GPT 模型一致。

Codex 继续使用 OpenAI `Responses API` 的通信格式。网关会把请求转换为 DeepSeek 兼容的 `Chat Completions`，调用 DeepSeek，然后再把结果转换回 Responses JSON 或 `response.*` SSE 事件。

软件包：[@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

DeepSeek 是一家很好的公司。

## 要求

- Node.js 22 或更新版本
- 一个 DeepSeek API key
- Codex CLI 0.144.0 或更新版本

## 安装

```sh
npm install -g @galaxy-yearn/codex-deepseek-gateway
codex-deepseek-gateway --version
codex-deepseek-gateway install
```

运行时文件会被复制到 `~/.codex/deepseek-gateway`。把你的 DeepSeek API key 填入：

```text
~/.codex/deepseek-gateway/config/gateway.local.json
```

```json
{
  "upstreamApiKey": "sk-...",
  "codexPromptLanguage": "en"
}
```

`install` 会保留已有的 `gateway.local.json`。如果这是第一次安装，添加 API key 后启动网关：

```sh
codex-deepseek-gateway start
codex-deepseek-gateway status
```

`status` 应该显示 `"reachable": true`。

如需删除本地运行时和全局软件包：

```sh
codex-deepseek-gateway uninstall
npm uninstall -g @galaxy-yearn/codex-deepseek-gateway
```

## 配置

### Codex Provider

把这个 provider 添加到 `~/.codex/config.toml`：

```toml
model_provider = "deepseek-gateway"
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
model_supports_reasoning_summaries = true
model_reasoning_summary = "auto"

[model_providers.deepseek-gateway]
name = "DeepSeek"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
```

编辑 `config.toml` 后重启 Codex。

### System Prompt Language

`gateway.local.json` 中的 `codexPromptLanguage` 用于选择随包提供的 prompt catalog。支持的值是 `en` 和 `zh`；无效值会回退到 `en`：

```text
en -> ~/.codex/deepseek-gateway/config/codex-model-catalog.json
zh -> ~/.codex/deepseek-gateway/config/codex-model-catalog.zh.json
```

### Model Aliases

模型别名读取自：

```text
~/.codex/deepseek-gateway/config/model-aliases.json
```

`model-aliases.json` 由本软件包管理，并会在安装时刷新。随包提供的 Codex catalog 目前允许默认别名 `deepseek-v4-flash` 和 `deepseek-v4-pro`，用于 Codex 原生 sub-agent 校验。

### Reasoning Cache

网关会把有界的 DeepSeek reasoning cache 保存在：

```text
~/.codex/deepseek-gateway/state/reasoning-cache.jsonl
```

每条 JSONL 记录把工具 `call_id` 映射到含原始 `reasoning_content` 的 assistant 消息，使 DeepSeek thinking-mode 工具轮次在 gateway 重启后仍可正确回传。Codex 的会话历史由自身 rollout 管理并通过 `input` 发送；gateway 不持久化 `previous_response_id`、`conversation` 或完整消息历史。缓存平时只做追加写入，达到边界时压缩；`install` 会保留该文件，也可随时安全删除。可通过 `reasoningCachePath`、`reasoningCacheMaxMessages`（默认 1000）、`reasoningCacheMaxBytes`（默认 16 MB）或 `reasoningCacheEnabled: false` 调整；对应的 `REASONING_CACHE_*` 环境变量也可使用。已有 `sessions.json` 会迁移一次后删除。

## 使用

通过网关覆盖配置启动一个新的 Codex 对话：

```sh
codex-deepseek-gateway new
```

从当前项目恢复一个 Codex 会话：

```sh
codex-deepseek-gateway sessions
```

建议仅使用这些 `new` / `sessions` 命令获得项目设计的 DeepSeek Codex 体验。普通 `codex` / `codex resume` 不会加载随包 model catalog；launcher 会添加网关 provider、model catalog、model 和 reasoning 覆盖配置。

在交互式会话选择器中，使用 Up/Down 在可滚动的会话窗口中移动。按 `n` 会开始一个新对话，而不是恢复已有会话。

有用的非交互形式：

```sh
codex-deepseek-gateway new --model deepseek-v4-flash --reasoning-effort low  # 使用指定模型和 effort 启动
codex-deepseek-gateway sessions --print                                      # 列出恢复命令
codex-deepseek-gateway sessions --all                                        # 包含所有项目的会话
codex-deepseek-gateway sessions --exec <id-or-row>                           # 直接按行号或 session id 恢复
```

`new` 先选择模型，再选择 Codex reasoning effort。`sessions` 先选择会话，再选择模型和 reasoning effort。两者都会用以下参数启动 Codex：

```sh
codex -c model_provider=deepseek-gateway -c model=<model> -c model_reasoning_effort=<effort> -c model_supports_reasoning_summaries=true -c model_reasoning_summary=auto
```

launcher 还会传入指向随包 catalog 的 `model_catalog_json`，因此 Codex 原生 multi-agent 校验会接受 DeepSeek 模型别名和 `low|medium|high|xhigh|max` reasoning efforts。这个设置会替换该 Codex 进程的默认 model catalog，而不是与默认 catalog 合并。随包 catalog 声明 1M context window 和 900K 自动压缩阈值；调用方未设置 `max_output_tokens` 时，网关会把剩余的 100K 作为 DeepSeek 默认输出预算。请求中的显式值或 `UPSTREAM_MAX_TOKENS` 优先。

在通过 launcher 启动的 Codex TUI 中，`/model` 可以在随包提供的 DeepSeek 模型和 reasoning efforts 之间切换，`/personality` 可配合 catalog 中的 `personality_default`、`personality_friendly` 和 `personality_pragmatic` 条目使用。

## 命令

```sh
codex-deepseek-gateway install    # 把运行时复制到 ~/.codex/deepseek-gateway
codex-deepseek-gateway start      # 启动本地网关
codex-deepseek-gateway stop       # 停止本地网关
codex-deepseek-gateway status     # 显示进程和端点状态
codex-deepseek-gateway doctor     # 检查配置和请求映射
codex-deepseek-gateway new        # 通过 launcher 启动 Codex 对话
codex-deepseek-gateway sessions   # 通过 launcher 选择并恢复 Codex 会话
codex-deepseek-gateway uninstall  # 删除本地运行时
```

`doctor` 会检查当前 Codex 配置、DeepSeek 请求形状、reasoning mode，以及可选 web-search 后端是否就绪。更深入的调试可在 `gateway.local.json` 中设置 `debugPayload: true`，把每次请求的映射摘要写入 `gateway.debug.log`（5 MB 轮转）。

## 能力

### Reasoning

Codex effort 会映射到 DeepSeek V4 thinking mode：

| Codex effort | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |
| `max` | `thinking.type = enabled`, `reasoning_effort = max` |

当 DeepSeek 返回 `reasoning_content` 时，原始文本会被保留给 DeepSeek 历史；Codex 则会收到一个用于显示的 summary：经过 Markdown 清理，并带有前置加粗 `**Reasoning**` 标题。该标题会在模型思考时驱动 Codex 状态行。

### 进度更新

存在 function tools 时，网关会向 DeepSeek 暴露一个轻量的 `commentary` 工具。调用结果会作为 `phase: "commentary"` 的消息返回 Codex，用于显示工作进度，不会作为可执行函数调用转发。

### Tool Discovery

Codex 会把部分原生工具留在初始工具列表之外，并让模型通过 `tool_search` 发现它们。网关对此提供端到端桥接：`tool_search` 会作为可调用函数暴露给 DeepSeek，Codex 在本地执行搜索，`tool_search_output` 历史中返回的工具定义会被合并进 DeepSeek 工具列表，因此发现后的工具可在后续轮次中直接调用。

### Web Search

Web search 是可选能力，默认关闭。配置 Tavily 以启用搜索：

```json
{
  "tavilyApiKey": "tvly-...",
  "tavilyWebSearchEnabled": true
}
```

如果还需要打开页面读取，请配置 Firecrawl：

```json
{
  "firecrawlApiKey": "fc-...",
  "firecrawlWebFetchEnabled": true
}
```

Codex 可以继续请求 `web_search` / `web_search_preview`。DeepSeek 会看到贴近能力语义的 `web_search`；配置 Firecrawl 后，还会看到 `web_open_page` 和 `web_find_in_page`。实际执行分别路由到 Tavily 和 Firecrawl；页面读取可用时，每次搜索默认自动读取排名第一的结果。完全相同的搜索和页面读取只在当前 Responses turn 内复用。

流式输出会在每一轮保持实时，包括 reasoning、`web_search_call` 进度和最终答案；没有搜索的轮次会走非 web 路径。多轮 Responses usage 使用最终上游轮次，供 Codex 统计当前上下文；启用调试日志时才会记录隐藏轮次的累计 usage。`TAVILY_MAX_SEARCH_ROUNDS`（默认 `20`，硬上限 `40`）是防止失控和控制成本的保护阈值；达到上限时，网关会在一个最终答案轮次中禁用 web 工具。

最终答案应直接包含有用的来源标题和 URL。

## 限制

Chat Completions 不是完整的 Responses API 替代品。

- 没有本地 Codex executor 的 hosted tools 会被表示为 function shims。Web search 是网关唯一直接模拟的 hosted tool。
- Tavily/Firecrawl 的 web 模拟以文本为中心；它不提供浏览器控制、截图、原始 HTML、cookies、crawl jobs 或私有网络访问。
- OpenAI `file_id` 值会被原样传递；网关无法获取 OpenAI 托管的私有文件。
- 普通 `codex` 命令不会自动加载随包提供的 model catalog。受支持的 DeepSeek 工作流建议仅使用 `codex-deepseek-gateway new` / `sessions`，包括 TUI `/model` 和 sub-agent 校验。
- Codex 恢复 session 后，特定长 Markdown 轮次的显示尾部可能重复；rollout 与模型历史并未重复，这是上游 Codex TUI 的回放问题。

## 许可证

MIT。见 [LICENSE](LICENSE)。
