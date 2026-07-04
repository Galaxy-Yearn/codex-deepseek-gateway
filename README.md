# Codex DeepSeek Gateway

A lightweight local gateway for using DeepSeek models in Codex. It performs nearly identically to the native GPT model.

Codex keeps using the OpenAI `Responses API` wire format. The gateway translates requests to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then translates the result back to Responses JSON or `response.*` SSE events.

Package: [@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

DeepSeek is a great company.

## Requirements

- Node.js 22 or newer
- A DeepSeek API key
- Codex CLI 0.142.0 or newer is recommended

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

### Session State

The gateway persists its Responses-side `previous_response_id` / `conversation` graph under:

```text
~/.codex/deepseek-gateway/state/sessions.json
```

That state lets DeepSeek receive reconstructed Chat history — including raw reasoning for thinking-mode tool turns — after a gateway restart. Codex sends `store: false`, so its turns persist only a compact per-`call_id` reasoning cache; full history snapshots are kept only for clients that use `previous_response_id` / `conversation` with storage enabled. The file is human-readable JSON (`state/sessions.example.json` shows the shape) and safe to delete at any time. Tune it with `sessionStorePath`, `sessionStoreMaxSessions` (default 500), `sessionStoreMaxBytes` (default 16 MB), or `sessionStoreEnabled: false`; the matching `SESSION_STORE_*` environment variables work too.

## Usage

Start a new Codex conversation with gateway overrides:

```sh
codex-deepseek-gateway new
```

Resume a Codex session from the current project:

```sh
codex-deepseek-gateway sessions
```

Prefer these `new` / `sessions` commands over plain `codex` / `codex resume`. The launcher adds the gateway provider, model catalog, model, and reasoning overrides.

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

The launcher also passes `model_catalog_json` pointing at the packaged catalog, so Codex-native multi-agent validation accepts the DeepSeek model aliases and `low|medium|high|xhigh` reasoning efforts. This setting replaces the default model catalog for that Codex process; it is not merged into it. The default context window is expanded to 1M since both `deepseek-v4-flash` and `deepseek-v4-pro` model supports that. `context_window` and `max_context_window` can be customized.

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

When DeepSeek returns `reasoning_content`, the raw text is preserved for DeepSeek history, while Codex receives a display summary: Markdown-cleaned, with a leading bold `**Reasoning**` header. The header drives the Codex status line while the model thinks.

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

Codex can keep requesting `web_search` / `web_search_preview`. The gateway exposes compact internal web tools to DeepSeek, executes Tavily/Firecrawl calls itself, feeds tool results back to the model, and returns Codex-compatible `web_search_call` items. Streaming stays live through every round — reasoning, `web_search_call` progress, and the final answer — and turns that never search behave like the non-web path. `TAVILY_MAX_SEARCH_ROUNDS` (default `20`, hard cap `40`) is a runaway/cost guardrail; when reached, the gateway disables web tools for one final-answer turn.

Final answers should include useful source titles and URLs directly.

## Limits

Chat Completions is not a full Responses API replacement.

- Hosted tools without a local Codex executor are represented as function shims. Web search is the only hosted tool the gateway emulates directly.
- Tavily/Firecrawl web emulation is text-focused; it does not provide browser control, screenshots, raw HTML, cookies, crawl jobs, or private-network access.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- Plain `codex` commands do not automatically load the packaged model catalog. Use the launcher when you want TUI `/model` and sub-agent validation to use the DeepSeek catalog.
- Resumed sessions may hide parts of earlier assistant replies that contain Markdown tables. This is a Codex TUI replay bug ([openai/codex#29218](https://github.com/openai/codex/issues/29218)); the session data itself is intact.

## License

MIT. See [LICENSE](LICENSE).
