import { useState, type FormEvent } from 'react'
import { planMeal, type PlanResult, type Style, type Want } from '../optimizer/planMeal.ts'
import type { MenuData } from '../optimizer/types.ts'
import { PlanCards } from './PlanCard.tsx'

// AI-free fallback: the same optimizer, driven by a plain form. Works even if OpenRouter is down.
const PRESETS: { tag: string; label: string; initial: number }[] = [
  { tag: 'chicken', label: '🍗 Chicken dishes', initial: 1 },
  { tag: 'vegetables', label: '🥬 Vegetable dishes', initial: 1 },
  { tag: 'beer', label: '🍺 Beers', initial: 2 },
  { tag: 'seafood', label: '🦐 Seafood dishes', initial: 0 },
  { tag: 'rice', label: '🍚 Rice dishes', initial: 0 },
  { tag: 'soft_drink', label: '🥤 Soft drinks', initial: 0 },
]

export function QuickPlanner({ data, open, onToggle, reason }: { data: MenuData | null; open: boolean; onToggle: (open: boolean) => void; reason?: string | null }) {
  const [budget, setBudget] = useState('10')
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(PRESETS.map((p) => [p.tag, p.initial])))
  const [dish, setDish] = useState('')
  const [dishQty, setDishQty] = useState(1)
  const [style, setStyle] = useState<Style>('cheapest')
  const [result, setResult] = useState<PlanResult | null>(null)

  function run(e: FormEvent) {
    e.preventDefault()
    if (!data) return
    const wants: Want[] = PRESETS.filter((p) => qty[p.tag] > 0).map((p) => ({ tag: p.tag, qty: qty[p.tag] }))
    if (dish.trim()) wants.push({ tag: dish.trim(), qty: dishQty })
    const b = Number(budget)
    setResult(planMeal(data, { budget_usd: b > 0 ? b : null, wants, style }))
  }

  return (
    <details className="quick" open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}>
      <summary>⚡ Quick planner — no AI</summary>
      {reason && <div className="quick-reason">{reason}</div>}
      <form onSubmit={run} className="quick-form">
        <label className="quick-budget">
          Budget (USD)
          <input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <div className="quick-grid">
          {PRESETS.map((p) => (
            <label key={p.tag} className="quick-row">
              <span>{p.label}</span>
              <input
                type="number"
                min="0"
                max="6"
                value={qty[p.tag]}
                onChange={(e) => setQty((q) => ({ ...q, [p.tag]: Math.max(0, Math.min(6, Number(e.target.value) || 0)) }))}
              />
            </label>
          ))}
          <label className="quick-row">
            <input className="quick-dish" placeholder="Other dish, e.g. oyster" value={dish} onChange={(e) => setDish(e.target.value)} />
            <input type="number" min="1" max="6" value={dishQty} onChange={(e) => setDishQty(Math.max(1, Math.min(6, Number(e.target.value) || 1)))} />
          </label>
        </div>
        <div className="quick-actions">
          <select value={style} onChange={(e) => setStyle(e.target.value as Style)} aria-label="Plan style">
            <option value="cheapest">Cheapest</option>
            <option value="premium">Best spread for the budget</option>
          </select>
          <button type="submit" className="new-chat" disabled={!data}>
            Find a plan
          </button>
        </div>
      </form>
      {result && <PlanCards result={result} />}
    </details>
  )
}
