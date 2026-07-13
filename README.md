# Codex DeepSeek Gateway

English | [简体中文](README.zh-CN.md)

A lightweight local gateway for using DeepSeek models in Codex. It performs nearly identically to the native GPT model.

Codex keeps using the OpenAI `Responses API` wire format. The gateway translates requests to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then translates the result back to Responses JSON or `response.*` SSE events.

Package: [@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

DeepSeek is a great company.

## Requirements

- Node.js 22 or newer
- A DeepSeek API key
- Codex CLI 0.144.0 or newer

## Install

```sh
npm install -g @galaxy-yearn/codex-deepseek-gateway
codex-deepseek-gateway --version
codex-deepseek-gateway install
```

The runtime is copied to `~/.codex/deepseek-gateway`. Put your DeepSeek API key in:

```text
~/.codex/deepseek-gateway/config/gateway.local.json
```

```json
{
  "upstreamApiKey": "sk-...",
  "codexPromptLanguage": "en"
}
```

`install` preserves an existing `gateway.local.json`. If this is your first install, add the key and start the gateway:

```sh
codex-deepseek-gateway start
codex-deepseek-gateway status
```

`status` should show `"reachable": true`.

To remove the local runtime and the global package:

```sh
codex-deepseek-gateway uninstall
npm uninstall -g @galaxy-yearn/codex-deepseek-gateway
```

## Configuration

### Codex Provider

Add this provider to `~/.codex/config.toml`:

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

Restart Codex after editing `config.toml`.

### System Prompt Language

`codexPromptLanguage` in `gateway.local.json` selects the packaged prompt catalog. Supported values are `en` and `zh`; invalid values fall back to `en`:

```text
en -> ~/.codex/deepseek-gateway/config/codex-model-catalog.json
zh -> ~/.codex/deepseek-gateway/config/codex-model-catalog.zh.json
```

### Model Aliases

Model aliases are read from:

```text
~/.codex/deepseek-gateway/config/model-aliases.json
```

`model-aliases.json` is managed by this package and refreshed on install. The packaged Codex catalog currently allows the default aliases `deepseek-v4-flash` and `deepseek-v4-pro` for Codex-native sub-agent validation.

### Reasoning Cache

The gateway keeps a bounded DeepSeek reasoning cache under:

```text
~/.codex/deepseek-gateway/state/reasoning-cache.jsonl
```

Each JSONL record maps tool `call_id` values to the assistant message containing raw `reasoning_content`, so DeepSeek thinking-mode tool turns can be replayed after a gateway restart. Codex owns conversation history in its rollout and sends that history in `input`; the gateway does not persist `previous_response_id`, `conversation`, or full message history. The cache is append-only between bounded compactions, is preserved by `install`, and can be deleted safely. Tune it with `reasoningCachePath`, `reasoningCacheMaxMessages` (default 1000), `reasoningCacheMaxBytes` (default 16 MB), or `reasoningCacheEnabled: false`; matching `REASONING_CACHE_*` environment variables also work. An existing `sessions.json` cache is migrated once and removed.

## Usage

Start a new Codex conversation with gateway overrides:

```sh
codex-deepseek-gateway new
```

Resume a Codex session from the current project:

```sh
codex-deepseek-gateway sessions
```

Use only these `new` / `sessions` commands for the intended DeepSeek-backed Codex experience. Plain `codex` / `codex resume` do not load the packaged model catalog; the launcher adds the gateway provider, model catalog, model, and reasoning overrides.

In the interactive session picker, use Up/Down to move through a scrolling window of sessions. Press `n` to start a new conversation instead of resuming an existing session.

Useful non-interactive forms:

```sh
codex-deepseek-gateway new --model deepseek-v4-flash --reasoning-effort low  # start with explicit model and effort
codex-deepseek-gateway sessions --print                                      # list resume commands
codex-deepseek-gateway sessions --all                                        # include sessions from all projects
codex-deepseek-gateway sessions --exec <id-or-row>                           # resume directly by row or session id
```

`new` chooses a model, then Codex reasoning effort. `sessions` chooses a session first, then model and reasoning effort. Both launch Codex with:

```sh
codex -c model_provider=deepseek-gateway -c model=<model> -c model_reasoning_effort=<effort> -c model_supports_reasoning_summaries=true -c model_reasoning_summary=auto
```

The launcher also passes `model_catalog_json` pointing at the packaged catalog, so Codex-native multi-agent validation accepts the DeepSeek model aliases and `low|medium|high|xhigh|max` reasoning efforts. This setting replaces the default model catalog for that Codex process; it is not merged into it. The packaged catalog declares a 1M context window and a 900K auto-compaction threshold. When the caller does not set `max_output_tokens`, the gateway uses the remaining 100K as the default DeepSeek output budget; an explicit request value or `UPSTREAM_MAX_TOKENS` takes precedence.

Inside a launcher-started Codex TUI, `/model` switches between the packaged DeepSeek models and reasoning efforts, and `/personality` works with the catalog's `personality_default`, `personality_friendly`, and `personality_pragmatic` entries.

## Commands

```sh
codex-deepseek-gateway install    # copy runtime into ~/.codex/deepseek-gateway
codex-deepseek-gateway start      # start the local gateway
codex-deepseek-gateway stop       # stop the local gateway
codex-deepseek-gateway status     # show process and endpoint status
codex-deepseek-gateway doctor     # inspect config and request mapping
codex-deepseek-gateway new        # start a Codex conversation through the launcher
codex-deepseek-gateway sessions   # pick and resume a Codex session through the launcher
codex-deepseek-gateway uninstall  # remove the local runtime
```

`doctor` checks the active Codex config, DeepSeek request shape, reasoning mode, and optional web-search backend readiness. For deeper debugging, set `debugPayload: true` in `gateway.local.json` to log per-request mapping summaries to `gateway.debug.log` (rotated at 5 MB).

## Capabilities

### Reasoning

Codex effort maps to DeepSeek V4 thinking mode:

| Codex effort | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |
| `max` | `thinking.type = enabled`, `reasoning_effort = max` |

When DeepSeek returns `reasoning_content`, the raw text is preserved for DeepSeek history, while Codex receives a display summary: Markdown-cleaned, with a leading bold `**Reasoning**` header. The header drives the Codex status line while the model thinks.

### Progress Updates

When function tools are available, the gateway exposes a small `commentary` tool to DeepSeek. Calls are returned to Codex as `phase: "commentary"` message items for visible progress updates and are never forwarded as executable function calls.

### Tool Discovery

Codex keeps some native tools out of the initial tool list and lets the model discover them with `tool_search`. The gateway bridges this end to end: `tool_search` is exposed to DeepSeek as a callable function, Codex executes the search locally, and the tool definitions returned in `tool_search_output` history are merged into the DeepSeek tool list, so discovered tools become directly callable in later turns.

### Web Search

Web search is optional and off by default. Configure Tavily for search:

```json
{
  "tavilyApiKey": "tvly-...",
  "tavilyWebSearchEnabled": true
}
```

Configure Firecrawl if you also want opened-page reading:

```json
{
  "firecrawlApiKey": "fc-...",
  "firecrawlWebFetchEnabled": true
}
```

Codex can keep requesting `web_search` / `web_search_preview`. DeepSeek receives the capability-oriented `web_search` tool; with Firecrawl configured, it also receives `web_open_page` and `web_find_in_page`. Execution is routed to Tavily and Firecrawl, and each search automatically reads the top result by default when page reading is available. Identical searches and page reads are reused only within the current Responses turn.

Streaming stays live through every round — reasoning, `web_search_call` progress, and the final answer — and turns that never search behave like the non-web path. Multi-round Responses usage reports the final upstream round for Codex context accounting; aggregate hidden-round usage is written when debug logging is enabled. `TAVILY_MAX_SEARCH_ROUNDS` (default `20`, hard cap `40`) is a runaway/cost guardrail; when reached, the gateway disables web tools for one final-answer turn.

Final answers should include useful source titles and URLs directly.

## Limits

Chat Completions is not a full Responses API replacement.

- Hosted tools without a local Codex executor are represented as function shims. Web search is the only hosted tool the gateway emulates directly.
- Tavily/Firecrawl web emulation is text-focused; it does not provide browser control, screenshots, raw HTML, cookies, crawl jobs, or private-network access.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- Plain `codex` commands do not automatically load the packaged model catalog. Use only `codex-deepseek-gateway new` / `sessions` for the supported DeepSeek workflow, including TUI `/model` and sub-agent validation.
- Codex may duplicate the displayed tail of certain long Markdown turns after session resume. The rollout and model history are not duplicated; this is an upstream Codex TUI replay issue.

## License

MIT. See [LICENSE](LICENSE).
