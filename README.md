# Codex DeepSeek Gateway

A small local gateway for using DeepSeek V4 models from Codex.

Codex keeps sending OpenAI `Responses API` requests to a local endpoint. The gateway converts those requests to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then converts the result back to Responses JSON or streaming `response.*` events.

NPM package: [@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

The runtime uses only the Node.js standard library. It installs under `~/.codex/deepseek-gateway`, runs as a detached background process, and does not edit your existing Codex config.

Use this when you want Codex to stay on its normal Responses API path while the actual model is DeepSeek, including DeepSeek thinking output, function calls, local session resume help, and optional web search emulation through Tavily and Firecrawl.

## Requirements

- Node.js 20 or newer
- A DeepSeek API key
- Codex configured from `~/.codex/config.toml`

## Install

Run:

```sh
npx @galaxy-yearn/codex-deepseek-gateway install
```

This copies the runtime to:

```text
~/.codex/deepseek-gateway
```

It creates two local config files:

```text
~/.codex/deepseek-gateway/config/gateway.local.json
~/.codex/deepseek-gateway/config/model-aliases.json
```

Put your DeepSeek API key in `gateway.local.json`:

```json
"upstreamApiKey": "sk-..."
```

`model-aliases.json` controls the gateway-facing model IDs exposed on `GET /v1/models` and used by the `sessions` picker. Edit it only if you want to add or rename model aliases.

If the key is already configured, `install` also starts the gateway. If this is your first install, add the key and then run:

```sh
npx @galaxy-yearn/codex-deepseek-gateway start
```

## Configure Codex

Edit `~/.codex/config.toml`:

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

Use `deepseek-v4-pro` instead of `deepseek-v4-flash` if you want the pro model.

Restart Codex after changing `config.toml`.

## Start And Verify

Start, stop, and inspect the local background process:

```sh
npx @galaxy-yearn/codex-deepseek-gateway start
npx @galaxy-yearn/codex-deepseek-gateway stop
npx @galaxy-yearn/codex-deepseek-gateway status
```

`status` should show `"reachable": true`.

Run `doctor` to check the active Codex config and the DeepSeek request shape the gateway will send:

```sh
npx @galaxy-yearn/codex-deepseek-gateway doctor
```

Important fields:

- `codexConfigUsingGateway` should be `true`
- `codexModel` should be your gateway model, for example `deepseek-v4-pro`
- `codexReasoningEffort` should match `model_reasoning_effort`
- `deepseekThinking` shows the DeepSeek `thinking` payload
- `deepseekReasoningEffort` shows the DeepSeek effort sent upstream
- `gatewayEmitsReasoningSummary` should be `true` when DeepSeek thinking is enabled
- `tavilyWebSearchReady` and `firecrawlWebFetchReady` show whether optional web search backends are usable

Avoid running Codex through a proxy while using the local gateway. Some proxy clients intercept `http://127.0.0.1:3000` and can break local gateway requests.

## Models

The installed `config/model-aliases.json` starts with:

```json
{
  "deepseek-v4-flash": {
    "model": "deepseek-v4-flash",
    "thinking": "auto"
  },
  "deepseek-v4-pro": {
    "model": "deepseek-v4-pro",
    "thinking": "auto"
  }
}
```

The gateway serves these aliases directly on `GET /v1/models`. If you also want to merge DeepSeek's upstream `/models` list, set this in `gateway.local.json`:

```json
"fetchUpstreamModels": true
```

Whether Codex TUI `/model` shows custom provider models depends on the Codex client build. `config.toml` and the `sessions` command remain the reliable ways to choose a model.

## Reasoning

Codex reasoning effort maps to DeepSeek V4 thinking mode:

| Codex `model_reasoning_effort` | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |

`model_supports_reasoning_summaries = true` and `model_reasoning_summary = "auto"` tell Codex to use its normal thinking UI path. When DeepSeek returns `reasoning_content`, the gateway keeps the raw text as `reasoning_text` and mirrors it into `summary_text` with a `Reasoning` heading for Codex TUI compatibility.

When thinking is enabled, the gateway intentionally buffers visible assistant text and tool-call output until the upstream response completes, then emits reasoning first. This improves thinking order in Codex at the cost of higher first-token latency.

## Web Search

Web search is off by default. To let Codex's native `web_search` or `web_search_preview` tool work while DeepSeek is active, configure the optional backends in `gateway.local.json`.

Tavily provides search results:

```json
"tavilyApiKey": "tvly-...",
"tavilyWebSearchEnabled": true
```

Firecrawl provides opened-page reading and focused page lookup:

```json
"firecrawlApiKey": "fc-...",
"firecrawlWebFetchEnabled": true,
"firecrawlAutoScrapeTopResults": 3
```

Codex does not need MCP, a different tool name, or prompt changes. The gateway converts Codex web search requests into internal Chat Completions tools:

- `tavily_search` searches the web and returns citation-ready snippets.
- `firecrawl_open_page` reads a specific public page.
- `firecrawl_find_in_page` reads a page with a focused query.

DeepSeek receives compact text context containing the search query, sources, snippets, and optional opened-page excerpts. Codex receives Responses-compatible `web_search_call` items, final assistant messages, and URL citation annotations when the final text cites a matching source marker.

The web payload is intentionally text-focused. Tavily is called with `include_raw_content: false`; Firecrawl defaults to main content, removes base64 images, rejects local/private URLs, and truncates page text before it reaches the model.

## Sessions

Open a cross-provider session picker from a project:

```sh
npx @galaxy-yearn/codex-deepseek-gateway sessions
```

The picker is read-only. It scans Codex local transcript files, lists sessions for the current project across providers, then runs:

```sh
codex resume <session-id> -c model_provider=deepseek-gateway -c model=<model> -c model_reasoning_effort=<effort>
```

Flow:

- choose a model from `~/.codex/deepseek-gateway/config/model-aliases.json`
- choose Codex reasoning effort
- choose the session to resume
- use `Up/Down` to select, `Enter` to confirm, `Left` to go back, and `Esc` to quit

Print copyable resume commands instead of opening the picker:

```sh
npx @galaxy-yearn/codex-deepseek-gateway sessions --print
```

Include sessions outside the current project:

```sh
npx @galaxy-yearn/codex-deepseek-gateway sessions --all
```

The command does not edit session files, change provider ownership, or change Codex's native resume picker filters. It only helps you find the hidden session id and resume it with explicit config overrides.

## Commands

```sh
npx @galaxy-yearn/codex-deepseek-gateway install
npx @galaxy-yearn/codex-deepseek-gateway start
npx @galaxy-yearn/codex-deepseek-gateway stop
npx @galaxy-yearn/codex-deepseek-gateway status
npx @galaxy-yearn/codex-deepseek-gateway doctor
npx @galaxy-yearn/codex-deepseek-gateway sessions
npx @galaxy-yearn/codex-deepseek-gateway uninstall
```

`start` launches a headless background Node.js process. `stop` stops it. `uninstall` stops the gateway and removes `~/.codex/deepseek-gateway`, but it does not edit `~/.codex/config.toml`.

If `start` returns without visible output on your terminal, run `status`; `"reachable": true` is the source of truth.

## What Works

- Codex `POST /v1/responses`
- streaming and non-streaming responses
- text input and output
- image, file, and audio content parts when DeepSeek accepts the corresponding Chat Completions shape
- function tools and tool-call history
- DeepSeek thinking mode and `reasoning_content`
- lightweight local `previous_response_id` / `conversation` history while the gateway process is running
- `GET /v1/models` with local model aliases and optional upstream discovery
- optional Tavily/Firecrawl-backed `web_search` emulation
- read-only cross-provider session picker

## Limits

Chat Completions is not a full Responses API replacement. Some Responses features have no equivalent upstream field.

- Hosted tools such as file search, computer use, image generation, and code interpreter are represented as function-tool shims unless Codex executes matching tools locally. Web search is the only hosted tool the gateway can emulate directly.
- Tavily and Firecrawl web emulation is text-focused. It does not expose raw HTML, screenshots, browser actions, crawl/map jobs, cookies, private network access, or provider-specific payloads through Codex `web_search`.
- URL citations are returned in the Responses metadata path. Whether they appear as clickable links in the terminal depends on the Codex client build and how it renders custom-provider citation annotations.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- In-memory conversation history is lost when the gateway restarts.
- The gateway exposes model aliases on `/v1/models`, including aliases from `config/model-aliases.json`. Whether Codex TUI `/model` actually shows custom provider models depends on the Codex build. `config.toml` remains the reliable fallback.

## License

MIT. See [LICENSE](LICENSE).
