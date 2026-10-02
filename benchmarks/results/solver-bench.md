# Solver benchmark (planMeal)

Generated 2026-10-02T05:56:23.894Z by `benchmarks/solver_bench.ts` on Node v24.12.0; 12 restaurants, 546 items; 200 timed runs per scenario after a warm-up.

| Scenario | p50 ms | p95 ms | Best plan | Total | Within budget | Within-budget option |
|---|---|---|---|---|---|---|
| brief: $10 chicken + vegetables + 2 beers | 0.21 | 0.39 | Rainbow | $5.5 | yes | — |
| brief at $4 (over budget → 2-stop option) | 0.23 | 0.35 | Rainbow | $5.5 | no (+$1.5) | The Street + Rainbow $3.76 |
| no budget: chicken + 2 beers | 0.13 | 0.2 | Rainbow | $3.5 | yes | — |
| dish name: $10 oysters | 0.23 | 0.32 | The Street | $3 | yes | — |
| premium: $100 feast for two | 1.69 | 1.98 | Rainbow | $52.25 | yes | — |
| $10 duck + juice + beer | 0.46 | 0.53 | Rainbow | $3.51 | yes | — |
| stress: 6 wants, 3 dishes each kind | 7.84 | 8.77 | Rainbow | $19.76 | yes | — |
| unavailable dish: pizza | 0.21 | 0.24 | — (pizza unavailable) | — | — | — |
| synonym: wine → alcohol category | 0.21 | 0.25 | Rainbow | $1.63 | yes | — |

Full plans (every line item) are in `solver-bench.json`.
