#!/usr/bin/env python3
"""LLM usage benchmark: calls, tokens, cost and latency per stage/model from logs/llm-usage.jsonl.

    python3 benchmarks/llm_usage.py      (stdlib only)

Writes benchmarks/results/llm-usage.json + .md. The chat agent's runtime calls happen in visitors'
browsers and are not in this log (only offline pipeline calls are).
"""

import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "llm-usage.jsonl"
OUT = ROOT / "benchmarks" / "results"


def pct(xs, q):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))], 1) if xs else None


def main():
    rows = [json.loads(l) for l in LOG.read_text().splitlines() if l.strip()]
    groups = defaultdict(list)
    for r in rows:
        groups[(r.get("stage"), r.get("model_requested"))].append(r)
    summary = []
    for (stage, model), rs in sorted(groups.items()):
        ok = [r for r in rs if r.get("ok")]
        secs = [r["seconds"] for r in ok if r.get("seconds") is not None]
        summary.append({
            "stage": stage,
            "model": model,
            "calls": len(rs),
            "failed_attempts": len(rs) - len(ok),
            "prompt_tokens": sum(r.get("prompt_tokens") or 0 for r in rs),
            "completion_tokens": sum(r.get("completion_tokens") or 0 for r in rs),
            "reasoning_tokens": sum(r.get("reasoning_tokens") or 0 for r in rs),
            "cost_usd": round(sum(float(r.get("cost_usd") or 0) for r in rs), 4),
            "cost_per_success_usd": round(sum(float(r.get("cost_usd") or 0) for r in rs) / max(1, len(ok)), 4),
            "latency_s": {"p50": pct(secs, 0.5), "p95": pct(secs, 0.95), "max": max(secs) if secs else None, "mean": round(statistics.mean(secs), 1) if secs else None},
            "errors": sorted({r.get("error", "")[:120] for r in rs if not r.get("ok")}),
        })
    total = round(sum(s["cost_usd"] for s in summary), 4)
    result = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "logs/llm-usage.jsonl", "calls": len(rows), "total_cost_usd": total, "by_stage_model": summary}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "llm-usage.json").write_text(json.dumps(result, indent=2) + "\n")
    lines = ["# LLM usage (offline pipeline)", "", f"Generated {result['generated_at']} from `logs/llm-usage.jsonl`. Total: **{len(rows)} calls, ${total}**.", "",
             "| Stage | Model | Calls | Failed | Prompt tok | Completion tok | Reasoning tok | Cost | p50 s | p95 s |", "|---|---|---|---|---|---|---|---|---|---|"]
    for s in summary:
        lines.append(f"| {s['stage']} | {s['model']} | {s['calls']} | {s['failed_attempts']} | {s['prompt_tokens']} | {s['completion_tokens']} | {s['reasoning_tokens']} | ${s['cost_usd']} | {s['latency_s']['p50']} | {s['latency_s']['p95']} |")
    (OUT / "llm-usage.md").write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}/llm-usage.json + .md ({len(rows)} calls, ${total})")


if __name__ == "__main__":
    main()
