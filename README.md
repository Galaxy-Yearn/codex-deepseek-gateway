# Codex DeepSeek Gateway

A small local gateway for using DeepSeek V4 models from Codex.

Codex sends OpenAI `Responses API` requests to the local gateway. The gateway converts them to DeepSeek-compatible `Chat Completions`, calls DeepSeek, then converts the answer back to Responses objects or streaming `response.*` events.

The runtime uses only the Node.js standard library. It installs under `~/.codex/deepseek-gateway`, runs as a detached background process, and does not edit your existing Codex config.

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

### Tavily Web Search

Tavily search is off by default. To let Codex's native `web_search` tool work while the active model is DeepSeek, set these fields in `gateway.local.json`:

```json
"tavilyApiKey": "tvly-REPLACE_ME",
"tavilyWebSearchEnabled": true
```

Codex does not need MCP, a different tool name, or any prompt changes. It can keep sending the normal Responses `web_search` or `web_search_preview` tool. The gateway converts that request to an internal `tavily_search` function for DeepSeek, calls Tavily, then maps the result back to Responses-style output.

The compatibility is two-sided:

- Codex sees `web_search_call` items and final assistant messages in the Responses format.
- DeepSeek sees a normal Chat Completions function tool named `tavily_search`.
- If Codex replays prior `web_search_call` items as conversation state, the gateway keeps them as Responses search records instead of sending broken, unpaired Chat tool calls upstream.

Codex receives:

- `web_search_call` output items
- final assistant `message` items
- streaming `response.output_text.annotation.added` events for URL citations when the final text contains a matching source marker
- final `url_citation` annotations on matching cited source markers
- `web_search_call.action.sources` only when the request includes `include: ["web_search_call.action.sources"]`

DeepSeek receives a compact text summary it can read directly:

- the search query
- an optional Tavily answer summary
- numbered sources
- each source's title, URL, optional date, relevance score, and snippet

The gateway does not pass Tavily's raw response object, raw page content, images, or extra Tavily-only fields to DeepSeek. Tavily is called with `include_raw_content: false`. The model is also told not to write Markdown links or raw URLs in the final answer; URL data is carried through Responses citation annotations when the client supports rendering them.

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
name = "DeepSeekGateway"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
```

Use `deepseek-v4-pro` instead of `deepseek-v4-flash` if you want the pro model.

`config.toml` can change:

- the active provider via `model_provider`
- the active model ID via `model`
- the provider label via `[model_providers.<id>].name`

It does not define a separate display name for each model entry inside Codex `/model`. If your Codex build reads custom provider models from `/v1/models`, the visible model names come from the gateway's model IDs in `~/.codex/deepseek-gateway/config/model-aliases.json`.

These reasoning settings do different jobs:

- `model_supports_reasoning_summaries = true`
- `model_reasoning_summary = "auto"`

These tell Codex to use its normal thinking UI path. When DeepSeek returns `reasoning_content`, the gateway maps it into that path while thinking is enabled. It keeps the raw text as `reasoning_text` and sends a display-safe `summary_text` version with a small heading and common Markdown markers removed, because Codex TUI renders reasoning summaries as plain summary blocks.

When DeepSeek thinking is enabled, the gateway buffers visible assistant text and tool-call output until the upstream response completes. It then flushes collected reasoning before the answer/tool calls through one summary part streamed as small deltas. The tradeoff is higher first-token latency while thinking is on.

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

When thinking is enabled, every non-empty DeepSeek streaming `reasoning_content` chunk is collected and converted into Responses reasoning events:

- `reasoning_summary_text.delta` for Codex's native summary-style thinking UI

The completed response keeps the original DeepSeek text as `reasoning_text`. The visible summary path uses a plain-text rendering of the same text with common Markdown markers removed and a `Reasoning` heading for Codex TUI compatibility. When thinking is enabled, the gateway holds back visible answer/tool output until completion so the reasoning block can land first and stay contiguous.

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
- Responses-style URL citation metadata for Tavily-backed answers when the final text contains matching source markers
- DeepSeek thinking mode and `reasoning_content`
- lightweight local `previous_response_id` / `conversation` history while the gateway process is running
- `GET /v1/models` with local DeepSeek V4 aliases and optional upstream discovery

## Limits

Chat Completions is not a full Responses API replacement. Some Responses features have no equivalent upstream field.

- Hosted tools such as file search, computer use, image generation, and code interpreter are represented as function-tool shims unless Codex executes matching tools locally. Web search is the only hosted tool the gateway can emulate directly, and only when Tavily is configured.
- Tavily search emulation is intentionally narrow. It uses Tavily Search results for text web lookup; it does not expose Tavily extract/crawl/map, raw page content, images, or other Tavily-specific capabilities through Codex `web_search`.
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
