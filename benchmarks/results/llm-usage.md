# LLM usage (offline pipeline)

Generated 2026-10-02T05:55:32+00:00 from `logs/llm-usage.jsonl`. Total: **42 calls, $3.5352**.

| Stage | Model | Calls | Failed | Prompt tok | Completion tok | Reasoning tok | Cost | p50 s | p95 s |
|---|---|---|---|---|---|---|---|---|---|
| crosscheck | anthropic/claude-opus-5.5 | 10 | 0 | 68527 | 31055 | 11603 | $0.8952 | 24.8 | 64.5 |
| extract | google/gemini-2.5-pro | 32 | 1 | 91065 | 253189 | 117762 | $2.64 | 50.9 | 154.6 |
