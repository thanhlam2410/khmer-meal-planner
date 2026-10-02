# Benchmarks

Raw numbers plus the scripts that produce them. Run everything with:

```bash
npm run bench
```

| Script | Measures | Input | Raw output | Summary |
|---|---|---|---|---|
| [extraction_accuracy.py](extraction_accuracy.py) | Extraction accuracy per field (model-vs-model agreement, 95% Wilson CI), per image, every disputed item | `data/cache/crosscheck/`, `data/cache/extract/` | [results/extraction-accuracy.json](results/extraction-accuracy.json) | [results/extraction-accuracy.md](results/extraction-accuracy.md) |
| [llm_usage.py](llm_usage.py) | Calls, tokens (incl. reasoning), cost, latency p50/p95 per stage and model | `logs/llm-usage.jsonl` | [results/llm-usage.json](results/llm-usage.json) | [results/llm-usage.md](results/llm-usage.md) |
| [solver_bench.ts](solver_bench.ts) | `planMeal` latency (200 timed runs per scenario) and the plan it returns for 9 fixed scenarios (brief, over-budget, no budget, dish name, premium, stress, unavailable, synonym) | `data/menus.json` | [results/solver-bench.json](results/solver-bench.json) | [results/solver-bench.md](results/solver-bench.md) |

Upstream raw data, also committed:
- `data/cache/extract/*.json`: Gemini 2.5 Pro's raw extraction per image (with token usage and latency)
- `data/cache/crosscheck/*.json`: Claude Opus 5.5's raw per-item verdicts
- `logs/llm-usage.jsonl`: one line per model call
- `logs/run-*.log`: console output of the full runs

Notes:
- **Extraction accuracy is agreement between two models, not human ground truth.** See the caveats in the main README ("How these numbers were measured").
- These are records of what the system does, not pass/fail tests. No unit-test suite exists by design.
- The chat agent's runtime calls happen in visitors' browsers through the here.now proxy, so they aren't in `logs/llm-usage.jsonl`. With `?debug`, the browser console shows each call's timing and usage.
