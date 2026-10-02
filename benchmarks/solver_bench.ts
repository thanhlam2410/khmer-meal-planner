// Solver benchmark: latency and results of planMeal over fixed scenarios on the real dataset.
//
//   node benchmarks/solver_bench.ts            (Node 24 runs TypeScript directly)
//
// Writes benchmarks/results/solver-bench.json (raw: every scenario's full best plan + timings)
// and benchmarks/results/solver-bench.md. Not a test suite: it records what the solver does.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planMeal, type PlanRequest } from '../src/optimizer/planMeal.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(ROOT, 'data/menus.json'), 'utf8'))
const RUNS = 200

const scenarios: { name: string; req: PlanRequest }[] = [
  { name: 'brief: $10 chicken + vegetables + 2 beers', req: { budget_usd: 10, wants: [{ tag: 'chicken', qty: 1 }, { tag: 'vegetables', qty: 1 }, { tag: 'beer', qty: 2 }] } },
  { name: 'brief at $4 (over budget → 2-stop option)', req: { budget_usd: 4, wants: [{ tag: 'chicken', qty: 1 }, { tag: 'vegetables', qty: 1 }, { tag: 'beer', qty: 2 }] } },
  { name: 'no budget: chicken + 2 beers', req: { wants: [{ tag: 'chicken', qty: 1 }, { tag: 'beer', qty: 2 }] } },
  { name: 'dish name: $10 oysters', req: { budget_usd: 10, wants: [{ tag: 'oyster', qty: 1 }] } },
  { name: 'premium: $100 feast for two', req: { budget_usd: 100, style: 'premium', wants: [{ tag: 'seafood', qty: 1 }, { tag: 'beef', qty: 1 }, { tag: 'vegetables', qty: 1 }, { tag: 'soup', qty: 1 }, { tag: 'beer', qty: 2 }] } },
  { name: '$10 duck + juice + beer', req: { budget_usd: 10, wants: [{ tag: 'duck', qty: 1 }, { tag: 'juice', qty: 1 }, { tag: 'beer', qty: 1 }] } },
  { name: 'stress: 6 wants, 3 dishes each kind', req: { budget_usd: 60, wants: [{ tag: 'chicken', qty: 2 }, { tag: 'vegetables', qty: 2 }, { tag: 'seafood', qty: 2 }, { tag: 'pork', qty: 1 }, { tag: 'rice', qty: 1 }, { tag: 'beer', qty: 4 }] } },
  { name: 'unavailable dish: pizza', req: { budget_usd: 20, wants: [{ tag: 'pizza', qty: 1 }] } },
  { name: 'synonym: wine → alcohol category', req: { budget_usd: 20, wants: [{ tag: 'wine', qty: 1 }] } },
]

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.round(q * (xs.length - 1)))]
const round = (x: number) => Math.round(x * 100) / 100

const results = scenarios.map(({ name, req }) => {
  planMeal(data, req) // warm-up
  const times: number[] = []
  let out = planMeal(data, req)
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    out = planMeal(data, req)
    times.push(performance.now() - t0)
  }
  const b = out.best
  return {
    name,
    request: req,
    latency_ms: { p50: round(pct(times, 0.5)), p95: round(pct(times, 0.95)), max: round(Math.max(...times)), runs: RUNS },
    found: out.found,
    best: b && {
      restaurants: b.stops.map((s) => s.restaurant.name_en),
      total_usd: b.total_usd,
      within_budget: b.within_budget,
      over_budget_by_usd: b.over_budget_by_usd,
      lines: b.stops.flatMap((s) => s.lines.map((l) => `${l.qty}× ${l.name_en} (${l.price_text} ≈ $${l.unit_price_usd}) @ ${s.restaurant.name_en}`)),
    },
    within_budget_option: out.within_budget_option && { restaurants: out.within_budget_option.stops.map((s) => s.restaurant.name_en), total_usd: out.within_budget_option.total_usd },
    alternatives: out.alternatives.map((a) => ({ restaurants: a.stops.map((s) => s.restaurant.name_en), total_usd: a.total_usd })),
    unavailable_wants: out.unavailable_wants,
    notes: out.notes,
  }
})

const outDir = join(ROOT, 'benchmarks/results')
mkdirSync(outDir, { recursive: true })
const meta = { generated_at: new Date().toISOString(), node: process.version, dataset: data.meta, runs_per_scenario: RUNS }
writeFileSync(join(outDir, 'solver-bench.json'), JSON.stringify({ meta, results }, null, 2) + '\n')

const md = [
  '# Solver benchmark (planMeal)',
  '',
  `Generated ${meta.generated_at} by \`benchmarks/solver_bench.ts\` on Node ${meta.node}; ${data.meta.restaurants} restaurants, ${data.meta.items} items; ${RUNS} timed runs per scenario after a warm-up.`,
  '',
  '| Scenario | p50 ms | p95 ms | Best plan | Total | Within budget | Within-budget option |',
  '|---|---|---|---|---|---|---|',
  ...results.map((r) =>
    `| ${r.name} | ${r.latency_ms.p50} | ${r.latency_ms.p95} | ${r.best ? r.best.restaurants.join(' + ') : '— (' + (r.unavailable_wants.join(', ') || 'none') + ' unavailable)'} | ${r.best ? '$' + r.best.total_usd : '—'} | ${r.best ? (r.best.within_budget ? 'yes' : `no (+$${r.best.over_budget_by_usd})`) : '—'} | ${r.within_budget_option ? r.within_budget_option.restaurants.join(' + ') + ' $' + r.within_budget_option.total_usd : '—'} |`,
  ),
  '',
  'Full plans (every line item) are in `solver-bench.json`.',
].join('\n')
writeFileSync(join(outDir, 'solver-bench.md'), md + '\n')
console.log(`wrote benchmarks/results/solver-bench.json + .md (${results.length} scenarios)`)
