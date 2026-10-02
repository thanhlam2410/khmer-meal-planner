// Tools the chat agent can call. They run locally in the browser over menus.json.

import type { ToolSpec } from '../lib/openrouter.ts'
import { listRestaurants, mentionedDishes, normaliseTag, planMeal, searchMenu, type PlanRequest, type SearchRequest } from '../optimizer/planMeal.ts'
import type { MenuData } from '../optimizer/types.ts'

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'plan_meal',
      description:
        'Plan an order from the real menus. Exact search: fewest restaurants first, then (style "cheapest") the lowest total or (style "premium") the best spread within the budget. Plans may span several restaurants when no single one has everything. The best plan is returned even if over budget (within_budget=false, over_budget_by_usd), plus within_budget_option when one exists. ALWAYS use this for any "what should I order / where should I go" question.',
      parameters: {
        type: 'object',
        properties: {
          budget_usd: { type: 'number', description: 'Total budget in US dollars, as stated by the user (convert riel at 4000 = $1). If the user has not given a budget, ask them first instead of calling this tool — never invent one.' },
          style: {
            type: 'string',
            enum: ['cheapest', 'premium'],
            description: 'cheapest (default): lowest total. premium: the best/most generous spread within the budget — use when the user says luxury, treat, splurge, best, or gives a generous budget for an open request.',
          },
          wants: {
            type: 'array',
            description:
              'What the user wants, one entry per thing. Food tags: chicken | vegetables | pork | beef | fish | seafood | duck | egg | rice | noodle | soup | dessert | food. Beverage tags: beer | alcohol | soft_drink | juice | coffee_tea | water | drink. For a specific dish use its name as the tag (e.g. "oyster", "papaya salad", "amok"). qty = number of dishes (food) or units (beverages). "a couple" = 2, "some" = 1.',
            items: {
              type: 'object',
              properties: { tag: { type: 'string' }, qty: { type: 'integer', minimum: 1, maximum: 6 } },
              required: ['tag', 'qty'],
            },
          },
          restaurant: { type: 'string', description: 'Optional: restrict to one restaurant (name or id).' },
        },
        required: ['budget_usd', 'wants'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_menu',
      description: 'Search menu items across restaurants by text, tag/category, restaurant and max price. Use for questions like "which beers does Rainbow have?" or "cheapest chicken dish".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to match in English or Khmer names/descriptions.' },
          tag: { type: 'string', description: 'Category or tag, e.g. chicken, vegetables, beer, soup.' },
          kind: { type: 'string', enum: ['food', 'beverage'], description: 'Only food or only beverages.' },
          restaurant: { type: 'string' },
          max_price_usd: { type: 'number' },
          limit: { type: 'integer', description: 'Default 15, max 40.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_restaurants',
      description: 'List all restaurants with food / beverage item counts and whether they serve chicken, vegetable dishes and beer.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

/** `userText` is the user's latest message, used to catch dishes the model generalised away. */
export function runTool(data: MenuData, name: string, rawArgs: string, userText = ''): unknown {
  let args: Record<string, unknown> = {}
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {}
  } catch {
    return { error: `Arguments were not valid JSON: ${rawArgs.slice(0, 200)}` }
  }
  switch (name) {
    case 'plan_meal': {
      const req = args as unknown as PlanRequest
      const result = planMeal(data, req)
      // Guard: the user named a specific dish ("oysters") but the call only used broad tags ("seafood").
      const tags = (Array.isArray(req.wants) ? req.wants : []).map((w) => normaliseTag(String(w?.tag ?? '')))
      const missed = mentionedDishes(data, userText).filter((d) => !tags.some((t) => t.includes(d) || d.includes(t.replace(/_/g, ' '))))
      if (missed.length) {
        result.notes.unshift(
          `IMPORTANT: the user asked for ${missed.map((d) => `"${d}"`).join(', ')} specifically, but this plan used broader tags (${tags.join(', ')}). Call plan_meal again with ${missed.map((d) => `tag "${d}"`).join(' and ')} before answering.`,
        )
      }
      return result
    }
    case 'search_menu':
      return searchMenu(data, args as SearchRequest)
    case 'list_restaurants':
      return listRestaurants(data)
    default:
      return { error: `Unknown tool ${name}` }
  }
}
