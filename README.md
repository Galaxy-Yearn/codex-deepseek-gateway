# Codex DeepSeek Gateway

A lightweight local gateway for using DeepSeek models in Codex.

Codex keeps using the OpenAI `Responses API` wire format. The gateway translates requests to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then translates the result back to Responses JSON or `response.*` SSE events.

Package: [@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

## Requirements

- Node.js 22 or newer
- A DeepSeek API key
- Codex CLI

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
  "upstreamApiKey": "sk-..."
}
```

`install` preserves an existing `gateway.local.json`. If this is your first install, add the key and start the gateway:

```sh
codex-deepseek-gateway start
codex-deepseek-gateway status
```

`status` should show `"reachable": true`.

## Codex Config

Add this provider to `~/.codex/config.toml`:

```toml
model_provider = "deepseek-gateway"
model = "deepseek-v4-flash"
model_reasoning_effort = "low"
model_supports_reasoning_summaries = true
model_reasoning_summary = "auto"

[model_providers.deepseek-gateway]
name = "DeepSeek"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
```

Use `deepseek-v4-pro` if you want the pro model. Restart Codex after editing `config.toml`.

## Usage

Start a new Codex conversation with gateway overrides:

```sh
codex-deepseek-gateway new
```

Resume a Codex session from the current project:

```sh
codex-deepseek-gateway sessions
```

Useful non-interactive forms:

```sh
codex-deepseek-gateway new --model deepseek-v4-flash --reasoning-effort low
codex-deepseek-gateway new --print
codex-deepseek-gateway sessions --print
codex-deepseek-gateway sessions --all
codex-deepseek-gateway sessions --exec <id-or-row>
```

`new` chooses a model, then Codex reasoning effort. `sessions` chooses a session first, then model and reasoning effort. Both launch Codex with:

```sh
codex -c model_provider=deepseek-gateway -c model=<model> -c model_reasoning_effort=<effort> -c model_supports_reasoning_summaries=true -c model_reasoning_summary=auto
```

Model aliases are read from:

```text
~/.codex/deepseek-gateway/config/model-aliases.json
```

## Commands

```sh
codex-deepseek-gateway install
codex-deepseek-gateway start
codex-deepseek-gateway stop
codex-deepseek-gateway status
codex-deepseek-gateway doctor
codex-deepseek-gateway new
codex-deepseek-gateway sessions
codex-deepseek-gateway uninstall
```

`doctor` checks the active Codex config, DeepSeek request shape, reasoning mode, and optional web-search backend readiness.

To remove the local runtime and then uninstall the global package:

```sh
codex-deepseek-gateway uninstall
npm uninstall -g @galaxy-yearn/codex-deepseek-gateway
```

## Reasoning

Codex effort maps to DeepSeek V4 thinking mode:

| Codex effort | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |

When DeepSeek returns `reasoning_content`, the gateway preserves the raw text for DeepSeek history and sends a display-only Markdown-cleaned copy through Codex's reasoning summary UI. The raw reasoning is not duplicated into visible message content.

## Web Search

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

Codex can keep requesting `web_search` / `web_search_preview`. The gateway exposes compact internal web tools to DeepSeek, executes Tavily/Firecrawl calls itself, feeds tool results back to the model, and returns Codex-compatible `web_search_call` items. `TAVILY_MAX_SEARCH_ROUNDS` defaults to `10` and is only a runaway/cost guardrail; when reached, the gateway disables web tools for one final-answer turn.

Final answers should include useful source titles and URLs directly.

## 0.1.5 Updates

- Global CLI usage: install once with `npm install -g`, then run `codex-deepseek-gateway ...` from any directory.
- `install` preserves `gateway.local.json`; runtime defaults stay in code.
- `new` and `sessions` launch Codex with reasoning-summary config overrides.
- `sessions` first chooses the session, hides subagent transcripts, and sorts by the latest user-message date.
- DeepSeek-facing tool descriptions are compact; namespaced Codex local tools, including multi-agent tools, pass back to Codex with namespace preserved.
- Web search uses a model-driven loop: internal Tavily/Firecrawl tools run in the gateway, local Codex tools pass through to Codex, and final-answer turns no longer end as empty completions.
- Reasoning display now uses Codex summary events only, with display-only Markdown cleanup to avoid duplicate or truncated thinking text.

## Limits

Chat Completions is not a full Responses API replacement.

- Hosted tools without a local Codex executor are represented as function shims. Web search is the only hosted tool the gateway emulates directly.
- Tavily/Firecrawl web emulation is text-focused; it does not provide browser control, screenshots, raw HTML, cookies, crawl jobs, or private-network access.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- In-memory `previous_response_id` / `conversation` history is lost when the gateway process restarts.
- The gateway exposes model aliases on `/v1/models`; whether Codex TUI `/model` shows them depends on the Codex build. `config.toml`, `new`, and `sessions` are the reliable model-selection paths.

## License

MIT. See [LICENSE](LICENSE).
