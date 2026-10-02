// Chat agent: an OpenRouter tool-calling loop that runs in the browser.
// The LLM interprets the request and writes the advice; all prices and arithmetic come from the tools.

import { chatCompletion, type ApiMessage } from '../lib/openrouter.ts'
import type { PlanResult } from '../optimizer/planMeal.ts'
import type { MenuData } from '../optimizer/types.ts'
import { TOOL_SPECS, runTool } from './tools.ts'
import { derror, dlog } from '../lib/debug.ts'

const MAX_STEPS = 6 // the last step is forced to answer from what the agent already has

export const SYSTEM_PROMPT = `You are a friendly food guide for restaurants in Cambodia. You help people decide what to order and where, within a budget.

Data: menus of 12 Cambodian restaurants, read from photos of Khmer menus (~2024 prices), converted at a fixed 4000 riel = 1 US dollar. Every item is classified as food or beverage.

Before planning — confirm the two essentials (never assume or invent them):
- BUDGET: if the user hasn't given one, ask for it in one short question before calling plan_meal. Never make up a budget.
- WHAT TO EAT / DRINK: if they named it (e.g. "chicken, vegetables, 2 beers"), use exactly that. If it's vague or open ("any recommendation?", "something nice"), you may call search_menu / list_restaurants for ideas, then PROPOSE a short set from the real menus (e.g. "1 grilled seafood dish, 1 vegetable dish, rice, 2 beers") and ask them to confirm or change it. Plan only after they confirm.
- If both are missing, ask both in ONE message (budget + what they feel like, with 2-3 concrete suggestions from the menus).
- If the user tells you to just pick ("you choose", "surprise me", "go ahead"), use your proposal without asking again.
- Questions about what exists ("which restaurants serve beer?") need no budget: answer them directly with search_menu / list_restaurants.
- A clarifying question is a normal short reply: no plan, no bullets of prices.

Rules once you have budget + wants:
- Call plan_meal. Never invent dishes, prices or restaurants; only use tool results.
- plan_meal optimises fewest restaurants first, then lowest total (style "cheapest", default) or the best spread within the budget (style "premium" — use for luxury / treat / "something nice" / generous budgets). Present its "best" plan as the recommendation.
- Interpret casual wording: "a couple" = 2, "a few" = 3, "some vegetables" = 1 vegetable dish. Beverages are counted in units, food in dishes. "For two" usually means 2 of each drink.
- Budget is in US dollars unless the user gives riel (divide by 4000).
- For a specific dish ("oysters", "papaya salad", "amok"), pass that word as the want tag; plan_meal matches dish names too.
- Don't reuse wants from earlier questions unless the user asks for the same thing.
- Call plan_meal at most twice per question, then answer.

Answer format (short, plain text with simple "- " bullets, no tables):
1. First line: where to go and the total. If the plan needs 2+ restaurants, say so clearly ("No single place has everything, so this needs 2 stops").
2. OVER BUDGET: if best.within_budget is false, the first line must start with "⚠️ Over budget:" and say by how much (over_budget_by_usd). If within_budget_option exists, offer it next (more stops, but fits the budget). Otherwise suggest what to drop or how much more to bring.
3. The order as bullets, grouped by restaurant: quantity × English name (Khmer name) — price as printed ≈ USD.
4. If within budget: one line with the money left over and a practical tip (e.g. add rice, or "point at the Khmer name when ordering").
5. If any item has warnings, add one short line: prices are from menu photos and may have changed.
Reply in the user's language.
Your reply is shown to the user as-is: do NOT think out loud, restate these instructions, or describe your reasoning ("Wait…", "Let's see…"). Think silently, call tools, then write only the final answer or your clarifying question.`

export type AgentStep =
  | { kind: 'thought'; text: string } // model reasoning or text written alongside tool calls (not the answer)
  | { kind: 'tool'; name: string; args: string; result: unknown }
  | { kind: 'usage'; cost: number; tokens: number }

/** Runs the agent on the conversation so far. Returns the new messages to append (assistant/tool turns). */
export async function runAgent(data: MenuData, history: ApiMessage[], onStep?: (s: AgentStep) => void): Promise<ApiMessage[]> {
  const added: ApiMessage[] = []
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1
    const { message, reasoning, usage } = await chatCompletion(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...history, ...added],
      TOOL_SPECS,
      last ? 'none' : 'auto', // final step: no more tools, answer with what we have
    )
    if (usage) onStep?.({ kind: 'usage', cost: usage.cost ?? 0, tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) })
    added.push(message)
    if (reasoning) onStep?.({ kind: 'thought', text: reasoning })
    if (message.role !== 'assistant' || !message.tool_calls?.length) return added
    // Text written alongside tool calls is the model thinking aloud, not the answer.
    if (message.content?.trim()) onStep?.({ kind: 'thought', text: message.content })

    for (const call of message.tool_calls) {
      const t0 = performance.now()
      let result: unknown
      try {
        result = runTool(data, call.function.name, call.function.arguments, latestUserText(history))
      } catch (err) {
        derror(`tool ${call.function.name} threw`, err)
        result = { error: `Tool failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      dlog(`tool ${call.function.name} (${Math.round(performance.now() - t0)} ms)`, { args: call.function.arguments, result })
      onStep?.({ kind: 'tool', name: call.function.name, args: call.function.arguments, result })
      added.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }
  dlog('stopped: step limit reached without a final answer', added)
  added.push({ role: 'assistant', content: 'Sorry, I could not finish that request. Please try rephrasing it.' })
  return added
}

function latestUserText(history: ApiMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user') return m.content
  }
  return ''
}

export const isPlanResult = (x: unknown): x is PlanResult =>
  typeof x === 'object' && x !== null && 'best' in x && 'within_budget_option' in x
