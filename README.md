# Codex DeepSeek Gateway

A small local gateway for using DeepSeek V4 models from Codex.

Codex sends OpenAI `Responses API` requests to the local gateway. The gateway converts them to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then converts the answer back to Responses objects or streaming `response.*` events.

The runtime uses only the Node.js standard library. It installs under `~/.codex/deepseek-gateway`, runs as a detached background process, and does not edit your existing Codex config.

Use this if you want Codex to keep its normal Responses API client path while the actual model is DeepSeek, including DeepSeek thinking output and optional web search emulation through Tavily and Firecrawl.

## Requirements

- Node.js 20 or newer
- A DeepSeek API key
- Codex configured from `~/.codex/config.toml`

## Install

Run:

```sh
npx @galaxy-yearn/codex-deepseek-gateway install
```

This copies the gateway to:

```text
~/.codex/deepseek-gateway
```

It also creates:

```text
~/.codex/deepseek-gateway/config/gateway.local.json
```

Open that file and replace `sk-REPLACE_ME` with your DeepSeek API key.

The install also creates:

```text
~/.codex/deepseek-gateway/config/model-aliases.json
```

That file controls which model IDs the gateway exposes on `GET /v1/models`. You only need to edit it if you want to add or rename gateway-facing model aliases.

By default, the gateway serves the local alias list directly. If you also want to merge DeepSeek's upstream `/models` list, set `"fetchUpstreamModels": true` in `gateway.local.json`. Leaving it `false` keeps `/v1/models` lighter and more predictable.

### Web Search

Web search is off by default. To let Codex's native `web_search` tool work while the active model is DeepSeek, configure Tavily in `gateway.local.json`:

```json
"tavilyApiKey": "tvly-REPLACE_ME",
"tavilyWebSearchEnabled": true
```

To add opened-page reading after search, also configure Firecrawl:

```json
"firecrawlApiKey": "fc-REPLACE_ME",
"firecrawlWebFetchEnabled": true,
"firecrawlAutoScrapeTopResults": 3
```

Codex does not need MCP, a different tool name, or prompt changes. It can keep sending the normal Responses `web_search` or `web_search_preview` tool. The gateway converts that request to internal Chat Completions tools for DeepSeek:

- `tavily_search` searches the web and returns citation-ready snippets.
- `firecrawl_open_page` reads a specific public page.
- `firecrawl_find_in_page` reads a page with a focused query.

DeepSeek receives a compact text summary it can read directly:

- the search query
- an optional Tavily answer summary
- numbered sources
- each source's title, URL, optional date, relevance score, and snippet
- optional Firecrawl opened-page title, summary, relevant matches, cleaned markdown excerpt, and page links

Codex receives Responses-compatible `web_search_call` items, final assistant messages, and URL citation annotations when the final text cites a matching source marker. If Codex replays prior `web_search_call` items as conversation state, the gateway preserves them as search records instead of sending broken Chat tool calls upstream.

The gateway does not pass Tavily's raw response object, images, screenshots, or provider-only fields to DeepSeek. Tavily is called with `include_raw_content: false`. Firecrawl returns cleaned page text, defaults to main content, removes base64 images, rejects local/private URLs, and truncates page text before it reaches the model.

If the key is already configured, `install` also starts the gateway. If this is your first install, run `start` after adding the key:

```sh
npx @galaxy-yearn/codex-deepseek-gateway start
```

Check that it is running:

```sh
npx @galaxy-yearn/codex-deepseek-gateway status
```

You should see `"reachable": true`.

## Configure Codex

Edit `~/.codex/config.toml` and set the active provider to the gateway:

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

`config.toml` can change:

- the active provider via `model_provider`
- the active model ID via `model`
- the provider label via `[model_providers.<id>].name`

It does not define a separate display name for each model entry inside Codex `/model`. If your Codex build reads custom provider models from `/v1/models`, the visible model names come from the gateway's model IDs in `~/.codex/deepseek-gateway/config/model-aliases.json`.

`model_supports_reasoning_summaries = true` and `model_reasoning_summary = "auto"` tell Codex to use its normal thinking UI path. When DeepSeek returns `reasoning_content`, the gateway keeps the raw text as `reasoning_text` and mirrors it into a display-safe `summary_text` value for Codex.

When DeepSeek thinking is enabled, the gateway buffers visible assistant text and tool-call output until the upstream response completes. It then emits reasoning before the answer or tool calls. The tradeoff is higher first-token latency while thinking is on.

Restart Codex after changing `config.toml`.

## Verify

Run:

```sh
npx @galaxy-yearn/codex-deepseek-gateway doctor
```

Important fields:

- `codexConfigUsingGateway` should be `true`
- `codexModel` should be your DeepSeek model, for example `deepseek-v4-pro`
- `codexReasoningEffort` should match `model_reasoning_effort`
- `deepseekThinking` shows the DeepSeek `thinking` payload
- `deepseekReasoningEffort` shows the DeepSeek effort sent upstream
- `reasoningDisplayMode` shows whether the gateway will emit `summary`, `disabled`, or `hidden`
- `gatewayEmitsReasoningSummary` should be `true` when DeepSeek thinking is enabled
- `codexSummaryConfigured` should be `true` so Codex TUI is configured to show summaries
- `tavilyWebSearchReady` should be `true` if you want Codex `web_search` to route through Tavily
- `firecrawlWebFetchReady` should be `true` if you want Tavily search results to include opened-page excerpts

For example, with:

```toml
model_reasoning_effort = "xhigh"
```

`doctor` should show:

```json
"deepseekThinking": { "type": "enabled" },
"deepseekReasoningEffort": "max"
```

## Reasoning Mapping

| Codex `model_reasoning_effort` | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |

When thinking is enabled, every non-empty DeepSeek `reasoning_content` value is converted into Responses reasoning output:

- `reasoning_summary_text.delta` for Codex's native summary-style thinking UI

The completed response keeps the original DeepSeek text as `reasoning_text`. The visible summary path uses a plain-text rendering of the same text with common Markdown markers removed and a `Reasoning` heading for Codex TUI compatibility. This also applies to Tavily/Firecrawl-backed `web_search` turns.

## Commands

```sh
npx @galaxy-yearn/codex-deepseek-gateway install
npx @galaxy-yearn/codex-deepseek-gateway start
npx @galaxy-yearn/codex-deepseek-gateway stop
npx @galaxy-yearn/codex-deepseek-gateway status
npx @galaxy-yearn/codex-deepseek-gateway doctor
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
- conservative schema-based repair for streamed and non-streamed tool arguments where DeepSeek returns stringified JSON values for fields that Codex declared as arrays, objects, booleans, or numbers
- Codex `web_search` emulation through Tavily when `tavilyWebSearchEnabled` is true and `tavilyApiKey` is configured, with Responses-style `web_search_call` output and compact source snippets for DeepSeek
- Firecrawl-backed opened-page reading for `web_search` when `firecrawlWebFetchEnabled` is true and `firecrawlApiKey` is configured, including automatic top-result scraping plus explicit `open_page` and `find_in_page` internal tool calls
- Responses-style URL citation metadata for Tavily-backed answers when the final text contains matching source markers
- DeepSeek thinking mode and `reasoning_content`
- lightweight local `previous_response_id` / `conversation` history while the gateway process is running
- `GET /v1/models` with local DeepSeek V4 aliases and optional upstream discovery

## Limits

Chat Completions is not a full Responses API replacement. Some Responses features have no equivalent upstream field.

- Hosted tools such as file search, computer use, image generation, and code interpreter are represented as function-tool shims unless Codex executes matching tools locally. Web search is the only hosted tool the gateway can emulate directly, and only when Tavily is configured.
- Tavily and Firecrawl web emulation is intentionally text-focused. It covers search, opened-page excerpts, page links, and find-in-page style matching; it does not expose raw HTML, screenshots, browser actions, crawl/map jobs, cookies, private network access, or provider-specific payloads through Codex `web_search`.
- URL citations are returned in the Responses metadata path. Whether they appear as clickable links in the terminal depends on the Codex client build and how it renders custom-provider citation annotations.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- In-memory conversation history is lost when the gateway restarts.
- The gateway exposes model aliases on `/v1/models`, including aliases from `config/model-aliases.json`. Whether Codex TUI `/model` actually shows custom provider models depends on the Codex build. `config.toml` remains the reliable fallback.

## Local Testing Before Publish

From this repository:

```sh
npm test
npm pack
npx --yes --package ./<generated-tarball>.tgz codex-deepseek-gateway install --no-edit
npx --yes --package ./<generated-tarball>.tgz codex-deepseek-gateway status
npx --yes --package ./<generated-tarball>.tgz codex-deepseek-gateway doctor
```

Replace `<generated-tarball>.tgz` with the filename printed by `npm pack`.

For published usage, use the shorter package command shown in the install section.

## Publish

When ready:

```sh
npm login
npm test
npm pack --dry-run
npm publish
```
