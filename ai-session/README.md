# AI usage trail

Everything the AI did on this project: the full agent session, the prompts, and the tool and model logs.

## The agent session

| | |
|---|---|
| Agent | **Claude Code** (VS Code extension), model **Claude Opus 5.5** |
| Sessions | 1 session, `b942e31f-bdc1-4301-9fae-0977b8ab5a02`, 2026-10-02 from 03:22 UTC (≈ 2.5 h) |
| **Full history (raw)** | [raw/session-01-b942e31f-bdc1-4301-9fae-0977b8ab5a02.jsonl](raw/session-01-b942e31f-bdc1-4301-9fae-0977b8ab5a02.jsonl): the complete Claude Code transcript, with every user message (incl. screenshots), assistant message, tool call and tool result, one JSON object per line |
| **Readable transcript** | [session-01-2026-10-02-planning-setup-deploy.md](session-01-2026-10-02-planning-setup-deploy.md): the same session as Markdown. User turns (incl. ones sent mid-turn), replies, and collapsible tool calls with result previews. Hidden reasoning and system messages are omitted |
| Agent memory | [claude-memory/](claude-memory/): notes the agent saved for itself during the session (deploy procedure, the "no unit tests unless asked" rule) |

Both transcript files come from `~/.claude/projects/<project>/<session>.jsonl` via [scripts/export-session.mjs](../scripts/export-session.mjs):

```bash
node scripts/export-session.mjs ~/.claude/projects/-Users-lam-Projects-khmer-menus/<session>.jsonl \
  ai-session/session-NN-<date>-<topic>.md --title "Session NN — …" --raw ai-session/raw/session-NN-<id>.jsonl
```

**Redaction:** the exporter blanks out OpenRouter/Anthropic/here.now key patterns and the exact values of every secret-looking variable in `.env` (`*KEY*`, `*PASSWORD*`, `*TOKEN*`, `*CODE*`). Both files were scanned after export: no secrets. Nothing else is altered.

## Prompts

| Prompt | Where |
|---|---|
| The user's requests to the coding agent | Inside the transcripts above (every user turn) |
| Menu extraction prompt and JSON schema (Gemini 2.5 Pro) | [scripts/extraction/prompts.py](../scripts/extraction/prompts.py) → `EXTRACT_SYSTEM`, `extract_user_prompt()` |
| Cross-check (judge) prompt (Claude Opus 5.5) | [scripts/extraction/prompts.py](../scripts/extraction/prompts.py) → `CROSSCHECK_SYSTEM`, `crosscheck_user_prompt()` |
| Same prompts, first JS version | [scripts/lib/prompts.mjs](../scripts/lib/prompts.mjs) |
| Chat agent system prompt (Gemini 3.5 Flash) | [src/agent/agent.ts](../src/agent/agent.ts) → `SYSTEM_PROMPT` |
| Chat agent tool definitions | [src/agent/tools.ts](../src/agent/tools.ts) → `TOOL_SPECS` |

## Tool and model logs

| Log | Where | What's in it |
|---|---|---|
| Every LLM call made by the pipeline | [../logs/llm-usage.jsonl](../logs/llm-usage.jsonl) | Stage, image, model, provider, request id, tokens (prompt / completion / reasoning), cost, latency, retries, errors |
| Pipeline run output | [../logs/run-extract-full.log](../logs/run-extract-full.log), [../logs/run-crosscheck.log](../logs/run-crosscheck.log) | Console output of the full extraction and cross-check runs |
| Raw model outputs (extraction) | [../data/cache/extract/](../data/cache/extract/) | Gemini 2.5 Pro's JSON per image, with model, usage and latency |
| Raw model outputs (cross-check) | [../data/cache/crosscheck/](../data/cache/crosscheck/) | Claude Opus 5.5's per-item verdicts per image |
| Coding agent's tool calls (Bash, file edits, web search, browser) | Inside the raw transcript (`tool_use` / `tool_result` records) | Every command run, file written and result returned |
| Chat agent at runtime | Visitor's browser console with `?debug` (not persisted) | Each request/response, tool call and timing |

Summaries of these logs: [../benchmarks/](../benchmarks/) (`npm run bench`).

## External tools the coding agent used

- **here.now skill** (`npx skills add heredotnow/skill --skill here-now`): publishing, auth, proxy variable, password.
- **OpenRouter API**: all model calls (one key, kept in `.env`).
- **Web search / fetch**: model and benchmark research (the sources are listed in the transcript).
- **Playwright browser (MCP)**: debugging the live site (the black-screen crash, the oyster query).
- **Mermaid CLI**: rendering the diagrams in `docs/diagrams/`.
