# Codex DeepSeek Gateway

English | [简体中文](README.zh-CN.md)

A lightweight local gateway that lets Codex run on DeepSeek models, with an experience nearly identical to the native GPT models. Codex keeps speaking the OpenAI `Responses API`; the gateway translates each request into DeepSeek-compatible `Chat Completions` and translates the result back, so tools, reasoning, streaming, and session replay all keep working.

```text
Codex /v1/responses
  -> request normalization and mapping
  -> DeepSeek /chat/completions
  -> JSON / SSE normalization and mapping
  -> Codex Responses items and events
```

Package: [@galaxy-yearn/codex-deepseek-gateway](https://www.npmjs.com/package/@galaxy-yearn/codex-deepseek-gateway)

## Requirements

- [Node.js](https://nodejs.org/en/download) 22 or newer
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)
- [Codex CLI](https://developers.openai.com/codex) 0.144.0 or newer

## Install and Start

Install the package and copy the runtime into `~/.codex/deepseek-gateway`:

```sh
npm install -g @galaxy-yearn/codex-deepseek-gateway
codex-deepseek-gateway --version          # confirm the installed version (short form: -v)
codex-deepseek-gateway install            # a first install opens the config file automatically
codex-deepseek-gateway install --no-edit  # install without opening the config file
```

Put your DeepSeek API key in `~/.codex/deepseek-gateway/config/gateway.local.json`:

```json
{
  "upstreamApiKey": "sk-...",
  "codexPromptLanguage": "en"
}
```

`install` never overwrites an existing `gateway.local.json`. Start the gateway and check it:

```sh
codex-deepseek-gateway start
codex-deepseek-gateway status
```

`status` should show `Gateway status: HEALTHY`.

## Configure the Codex Provider

Codex reaches the gateway through a provider entry in `~/.codex/config.toml`. The launcher commands (`codex-deepseek-gateway new` / `sessions`, next section) do not create it, so add this block yourself (create the file if needed) and restart any running Codex:

```toml
[model_providers.deepseek-gateway]
name = "DeepSeek"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
```

The top-level model settings can stay out of `config.toml`: on every launch the launcher passes `model_provider`, your chosen `model` and `model_reasoning_effort`, plus `model_supports_reasoning_summaries = true` and `model_reasoning_summary = "auto"`. Add them only if you also want plain `codex` to use the gateway; the launcher then uses your `model` and `model_reasoning_effort` as its defaults:

```toml
model_provider = "deepseek-gateway"
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
model_supports_reasoning_summaries = true
model_reasoning_summary = "auto"
```

Even then, plain `codex` does not load the packaged model catalog described in the next section; prefer the launcher commands.

## Use with Codex

Start Codex through the launcher:

```sh
codex-deepseek-gateway new       # start a new conversation
codex-deepseek-gateway sessions  # pick and resume a session from the current project
```

Both commands launch Codex with the provider overrides described above and load the packaged model catalog: the DeepSeek models, system prompts (English or Chinese, per `codexPromptLanguage`), reasoning levels, and personalities that ship with the gateway.

Without options, `new` asks for a model, then a Codex reasoning effort. `sessions` shows a session picker first (Up/Down to browse, `n` to start a new conversation instead), then model and effort.

Useful non-interactive forms:

```sh
codex-deepseek-gateway new --model deepseek-v4-flash --reasoning-effort low
codex-deepseek-gateway sessions --print             # list resume commands
codex-deepseek-gateway sessions --all               # include sessions from all projects
codex-deepseek-gateway sessions --exec <id-or-row>  # resume by row number or session id
```

Inside a launcher-started Codex TUI, `/model` switches between the packaged DeepSeek models and reasoning efforts, and `/personality` switches between the catalog personalities.

### Models and Reasoning

The gateway ships two model aliases, `deepseek-v4-flash` and `deepseek-v4-pro`. Codex reasoning effort maps to DeepSeek thinking mode:

| Codex effort | DeepSeek request |
| --- | --- |
| `low` | `thinking.type = disabled` |
| `medium` | `thinking.type = enabled`, `reasoning_effort = high` |
| `high` | `thinking.type = enabled`, `reasoning_effort = high` |
| `xhigh` | `thinking.type = enabled`, `reasoning_effort = max` |
| `max` | `thinking.type = enabled`, `reasoning_effort = max` |

DeepSeek's chain of thought is shown in full in the Codex TUI, and the raw `reasoning_content` is preserved for model history.

The packaged catalog declares a 1M-token context window with automatic compaction near 900K tokens; when a request sets no output limit, the remaining ~100K is the default DeepSeek output budget (`upstreamMaxTokens` overrides it). The catalog also registers the aliases and reasoning levels with Codex, so features that validate model names, such as native sub-agents, accept the DeepSeek models.

## Project Highlights

The core goal is to keep DeepSeek as close to native GPT behavior in Codex as possible: the same workflow and session lifecycle, every Codex tool usable from DeepSeek (including parallel calls and tools revealed mid-session via `tool_search`), and live progress notes while tools run. Tool execution, history, and resume stay entirely owned by Codex.

On top of that, the gateway adds:

- A replacement model list: the bundled catalog registers the DeepSeek models and reasoning levels with Codex, so `/model` switches between them and features that validate model names, such as native sub-agents, keep working.
- Stronger compaction: the gateway runs compaction itself and validates every generated checkpoint before it enters session history; broken model output is rejected, and thinking effort and output budget are tunable.
- Very high cache hit rate: request construction is tuned for DeepSeek's context caching, so multi-turn sessions hit the cache at a very high rate, cutting cost and response latency.
- Web search: optional Tavily and Firecrawl backends make Codex web-search requests actually work.
- Tuned system prompts: bilingual system prompts and personalities adapted for DeepSeek.

## Configuration Reference

All settings live in `~/.codex/deepseek-gateway/config/gateway.local.json`. Copy the block below and change what you need; every value shown is the default (`sk-REPLACE_ME` is a placeholder the gateway treats as unset). Each key can also be set as an `UPPER_SNAKE_CASE` environment variable, which takes precedence. Restart the gateway (`stop`, then `start`) after changes.

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

- `upstreamApiKey` — your [DeepSeek API key](https://platform.deepseek.com/api_keys) (`DEEPSEEK_API_KEY` also works).
- `upstreamBaseUrl` — DeepSeek API endpoint; see the [DeepSeek API documentation](https://api-docs.deepseek.com/).
- `upstreamMaxTokens` — cap on DeepSeek output tokens; `0` uses the catalog's default ~100K budget.
- `host`, `port` — gateway listen address.
- `codexPromptLanguage` — prompt catalog language, `en` or `zh`; invalid values fall back to `en`.
- `compactReasoningEffort` — thinking effort used for compaction, `high` or `max`.
- `compactMaxTokens` — compaction output budget, capped at 100000.
- `reasoningCacheEnabled` — set `false` to disable the reasoning cache described below.
- `debugPayload` — log per-request mapping summaries to `gateway.debug.log` (rotated at 5 MB).
- `tavilyApiKey`, `tavilyWebSearchEnabled` — [Tavily](https://docs.tavily.com/documentation/quickstart) web search backend (see Web Search).
- `tavilyMaxSearchRounds` — web search rounds per turn, hard cap `40`.
- `firecrawlApiKey`, `firecrawlWebFetchEnabled` — [Firecrawl](https://docs.firecrawl.dev/introduction) page-reading backend (see Web Search).

Two support files under the install directory are managed for you:

- `config/model-aliases.json` — the model aliases; refreshed on every install and start.
- `state/reasoning-cache.jsonl` — a bounded cache (default 1000 messages / 16 MB) that restores raw DeepSeek reasoning for tool turns across gateway restarts; preserved by `install` and safe to delete.

## Web Search (Optional)

Web search is off by default. Create a [Tavily API key](https://app.tavily.com/home), then enable search:

```json
{
  "tavilyApiKey": "tvly-...",
  "tavilyWebSearchEnabled": true
}
```

If you also want opened-page reading, create a [Firecrawl API key](https://www.firecrawl.dev/app/api-keys), then enable it:

```json
{
  "firecrawlApiKey": "fc-...",
  "firecrawlWebFetchEnabled": true
}
```

Codex `web_search` / `web_search_preview` requests are then executed through Tavily; with Firecrawl configured, DeepSeek can also open pages and search within them, and each search reads the top result automatically. Streaming stays live through every search round. `tavilyMaxSearchRounds` limits search rounds per turn; at the cap, the gateway withholds the web tools for one final turn so the model answers with what it has.

## Upgrade

Exit all running Codex sessions before you upgrade. A session left open across a gateway upgrade can fail afterwards: its next compact requests may repeatedly return `upstream_error` until the session is reopened.

```sh
codex-deepseek-gateway update
```

`update` requires an installed gateway with an API key configured. It stops the gateway, installs and runs the latest npm package, preserves your `gateway.local.json`, reinstalls the local runtime, then runs `status` and `doctor` to verify the version, process identity, health, and configuration. Once it completes, start your Codex sessions again with `codex-deepseek-gateway new` or `codex-deepseek-gateway sessions`.

## Uninstall

Stop the gateway, remove the local runtime, then remove the global package:

```sh
codex-deepseek-gateway stop
codex-deepseek-gateway uninstall
npm uninstall -g @galaxy-yearn/codex-deepseek-gateway
```

`uninstall` removes the local runtime, including its local configuration and state.

## Command Reference

```sh
codex-deepseek-gateway install    # copy the runtime into ~/.codex/deepseek-gateway
codex-deepseek-gateway update     # update the package and verify the local runtime
codex-deepseek-gateway start      # start the local gateway
codex-deepseek-gateway stop       # stop the local gateway
codex-deepseek-gateway status     # show install, process, and endpoint status
codex-deepseek-gateway doctor     # inspect config and request mapping
codex-deepseek-gateway new        # start a Codex conversation through the launcher
codex-deepseek-gateway sessions   # pick and resume a Codex session
codex-deepseek-gateway uninstall  # remove the local runtime
```

`status` is a fast local check: it verifies the installed, running, and CLI versions, authenticates the recorded process, reports uptime, and checks the actual local API endpoint. `doctor` reuses that result and checks gateway configuration, listener security, Codex CLI/provider setup, bilingual catalogs and model aliases, the local model endpoint, DeepSeek authentication through `GET /models`, the reasoning cache, and optional web-backend configuration. It never sends a completion or calls Tavily/Firecrawl. Add `--json` to either command for the stable structured report.

Run `codex-deepseek-gateway --help` for all options.

## Troubleshooting

- `codex-deepseek-gateway status` — `HEALTHY` means the recorded process is running, authenticated, version-aligned, and reachable on its actual endpoint.
- `codex-deepseek-gateway doctor` — reports `OK`, `WARNING`, or `FAIL` across the complete Codex → gateway → DeepSeek configuration path, with a direct fix for each warning or failure.
- Debug log: set `"debugPayload": true` in `gateway.local.json` to write per-request mapping summaries to `~/.codex/deepseek-gateway/gateway.debug.log` (rotated at 5 MB).
- `stop` refuses to terminate a process it cannot authenticate. Verify `gateway.pid` in the install directory before using `stop --force`.
- Repeated `upstream_error` on compaction right after an upgrade usually means the session was open during the upgrade; exit and reopen the session (see Upgrade).

## Limits

- Chat Completions is not a full Responses API replacement. Codex hosted tools without a local executor are declared to DeepSeek as plain function tools rather than executed; web search is the only hosted tool the gateway executes itself.
- Tavily/Firecrawl web emulation is text-focused: no browser control, screenshots, raw HTML, cookies, crawl jobs, or private-network access.
- OpenAI `file_id` values are passed through; the gateway cannot fetch private OpenAI-hosted files.
- Plain `codex` commands do not load the packaged model catalog; use `new` / `sessions`.
- After resume, Codex may duplicate the displayed tail of certain long Markdown turns. History is not duplicated; this is an upstream Codex TUI display issue.

## License

MIT. See [LICENSE](LICENSE).
