import type { AgentStep } from '../agent/agent.ts'

// Collapsed-by-default panel with the agent's intermediate thoughts and tool calls.
type Step = Exclude<AgentStep, { kind: 'usage' }>

const TOOL_LABEL: Record<string, string> = {
  plan_meal: 'Planned a meal',
  search_menu: 'Searched menus',
  list_restaurants: 'Listed restaurants',
}

function argsSummary(raw: string): string {
  try {
    const a = JSON.parse(raw || '{}')
    const parts: string[] = []
    if (a.budget_usd != null) parts.push(`$${a.budget_usd}`)
    if (Array.isArray(a.wants)) parts.push(a.wants.map((w: { qty?: number; tag?: string }) => `${w.qty ?? 1}× ${w.tag}`).join(', '))
    for (const k of ['query', 'tag', 'kind', 'restaurant']) if (a[k]) parts.push(`${k}: ${a[k]}`)
    if (a.max_price_usd != null) parts.push(`≤ $${a.max_price_usd}`)
    return parts.join(' · ')
  } catch {
    return raw.slice(0, 80)
  }
}

export function ThinkingPanel({ steps }: { steps: Step[] }) {
  if (!steps.length) return null
  const tools = steps.filter((s) => s.kind === 'tool').length
  return (
    <details className="thinking">
      <summary>
        Thinking · {tools} tool call{tools === 1 ? '' : 's'}
      </summary>
      <ol>
        {steps.map((s, i) =>
          s.kind === 'tool' ? (
            <li key={i} className="step-tool">
              🔧 {TOOL_LABEL[s.name] ?? s.name}
              <span className="step-args">{argsSummary(s.args)}</span>
            </li>
          ) : (
            <li key={i} className="step-thought">{s.text.trim()}</li>
          ),
        )}
      </ol>
    </details>
  )
}
