// Meal planner — fewest restaurants first, then lowest total cost.
//
// Given a shopping list of "wants" (e.g. 1× chicken, 1× vegetables, 2× beer) and a budget:
//   1. For every restaurant r and every subset S of wants, find the cheapest way r alone can serve S
//      (exact: exhaustive search over that menu, a dish is never counted for two wants).
//   2. Search sets of k = 1, 2, 3 … restaurants and the split of wants between them. The minimal k
//      that covers every want wins; among those, the cheapest total wins (lexicographic objective).
//   3. If that optimum is over budget it is still returned, marked over budget, together with a
//      cheaper option that uses more restaurants when one fits the budget.
// Menus have ≤ ~130 items and requests a handful of wants, so this exact search runs in milliseconds.

import type { MenuData, MenuItem, Price, Restaurant } from './types.ts'

export type Kind = 'food' | 'beverage'
export type Want = { tag: string; qty: number; kind?: Kind }

export type Style = 'cheapest' | 'premium'

export type PlanRequest = {
  budget_usd?: number | null // omit for "no budget given": no limit, nothing reported as left over
  wants: Want[]
  style?: Style // cheapest (default): fewest restaurants, then lowest total. premium: fewest restaurants, then the best spread the budget allows
  restaurant?: string // restrict to restaurants matching this (id or name, case-insensitive substring)
  max_plans?: number // alternatives with the same (minimal) number of restaurants; default 3
}

export type PlanLine = {
  want: string
  kind: Kind
  item_id: string
  name_en: string
  name_km: string | null
  variant: string | null
  qty: number
  unit_price_usd: number
  subtotal_usd: number
  price_text: string
  source_image: string
  verified: 'agree' | 'disagree' | 'unchecked'
  confidence: number | null
}

export type Stop = {
  restaurant: { id: string; name_en: string; name_km: string | null }
  wants: string[]
  lines: PlanLine[]
  subtotal_usd: number
}

export type Plan = {
  restaurants_count: number
  stops: Stop[]
  total_usd: number
  within_budget: boolean
  leftover_usd: number | null // negative when over budget; null when no budget was given
  over_budget_by_usd: number // 0 when within budget
  warnings: string[]
}

export type PlanResult = {
  budget_usd: number | null
  style: Style
  wants: Want[]
  found: boolean
  best: Plan | null // fewest restaurants, then cheapest — may be over budget
  alternatives: Plan[] // other options with the same number of restaurants, cheapest first
  within_budget_option: Plan | null // when best is over budget: cheapest plan within budget using more restaurants
  unavailable_wants: string[] // wants that no restaurant can serve
  notes: string[]
}

type Offer = { item: MenuItem; price: Price; usd: number }
type Solution = { cost: number; groups: Map<number, Offer[]> } // want index -> chosen offers

// ---------- classification ----------
const BEVERAGE_CATEGORIES = new Set(['beer', 'alcohol', 'soft_drink', 'coffee_tea', 'juice', 'water'])
const PROTEIN_CATEGORIES = new Set(['chicken', 'pork', 'beef', 'duck', 'fish', 'seafood'])
const BAD_PRICE_FLAGS = new Set(['suspect_low_riel', 'suspect_high_usd', 'unparsed_price_text', 'handwritten_sticker'])

export const itemKind = (item: MenuItem): Kind => item.kind ?? (BEVERAGE_CATEGORIES.has(item.category) ? 'beverage' : 'food')
export const wantKind = (tag: string): Kind => (tag === 'drink' || BEVERAGE_CATEGORIES.has(tag) ? 'beverage' : 'food')

const SYNONYMS: Record<string, string> = {
  vegetable: 'vegetables', veg: 'vegetables', veggies: 'vegetables', greens: 'vegetables', salad: 'vegetables',
  beers: 'beer', chickens: 'chicken', drinks: 'drink', beverage: 'drink', beverages: 'drink',
  soda: 'soft_drink', coffee: 'coffee_tea', tea: 'coffee_tea', cocktail: 'alcohol', wine: 'alcohol',
}

export const normaliseTag = (tag: string) => {
  const t = tag.trim().toLowerCase().replace(/\s+/g, '_')
  return SYNONYMS[t] ?? t
}

export function matches(item: MenuItem, tag: string): boolean {
  switch (tag) {
    case 'chicken':
      return item.category === 'chicken' || item.tags.includes('chicken')
    case 'vegetables':
      // A vegetable *dish*: vegetable/salad category, or vegetable-tagged and either meat-free or a
      // salad (e.g. Khmer herb salads with shrimp) — not a meat dish that merely comes with greens.
      return (
        item.category === 'vegetable' ||
        item.category === 'salad' ||
        (item.tags.includes('vegetables') && (!PROTEIN_CATEGORIES.has(item.category) || /salad/i.test(item.name_en ?? '')))
      )
    case 'beer':
      return item.category === 'beer' // beer cocktails are 'alcohol'
    case 'drink':
      return itemKind(item) === 'beverage'
    case 'food':
      return itemKind(item) === 'food'
    default:
      // Category/tag, or a specific dish word in the name ("oyster", "papaya_salad", "amok").
      return item.category === tag || item.tags.includes(tag) || nameMatches(item, tag)
  }
}

// Words that are request plumbing or broad tags, never a specific dish.
const NOT_DISHES = new Set([
  'want', 'have', 'some', 'with', 'where', 'should', 'what', 'which', 'order', 'food', 'drink', 'drinks', 'meal', 'menu',
  'dish', 'dishes', 'restaurant', 'restaurants', 'place', 'budget', 'dollar', 'dollars', 'riel', 'cheap', 'cheapest', 'best',
  'please', 'find', 'like', 'love', 'would', 'could', 'eat', 'eating', 'get', 'need', 'and', 'the', 'for', 'from', 'about',
  'couple', 'few', 'many', 'much', 'more', 'less', 'only', 'also', 'just', 'good', 'nice', 'there', 'here', 'near', 'today',
  'tonight', 'lunch', 'dinner', 'breakfast', 'serve', 'serves', 'under', 'within', 'total', 'people', 'person', 'friends',
])

/** Specific dish words the user typed that appear in menu item names (e.g. "oysters" -> "oyster"). */
export function mentionedDishes(data: MenuData, text: string): string[] {
  const broad = new Set([...Object.keys(SYNONYMS), ...Object.values(SYNONYMS), 'chicken', 'beer', 'vegetables', 'drink', 'food'])
  const words = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])]
  return words
    .map((w) => (w.endsWith('s') ? w.slice(0, -1) : w))
    .filter((w) => !NOT_DISHES.has(w) && !NOT_DISHES.has(`${w}s`) && !broad.has(w) && !broad.has(`${w}s`))
    .filter((w) => data.restaurants.some((r) => r.items.some((it) => nameMatches(it, w))))
}

function nameMatches(item: MenuItem, tag: string): boolean {
  const word = tag.replace(/_/g, ' ').trim()
  const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word // "oysters" -> "oyster"
  if (!stem) return false
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Whole word, and not a flavouring/variety: "oyster sauce", "oyster mushroom" are not oysters.
  const re = new RegExp(`\\b${escaped}s?\\b(?!\\s+(?:sauce|mushrooms?|paste|flavou?r))`, 'i')
  return [item.name_en, item.name_printed_latin].some((s) => !!s && re.test(s)) || (!!item.name_km && item.name_km.includes(stem))
}

// An offer is usable only if its price is trustworthy enough to recommend.
function offersOf(item: MenuItem): Offer[] {
  if (item.crosscheck?.exists === false || item.crosscheck?.price_ok === false) return []
  return item.prices
    .filter((p) => p.price_usd != null && p.price_usd > 0 && !p.flags.some((f) => BAD_PRICE_FLAGS.has(f)))
    .map((p) => ({ item, price: p, usd: p.price_usd as number }))
}

// ---------- step 1: cheapest way one restaurant serves a subset of wants ----------
// Food: `qty` distinct dishes. Beverages: `qty` units, repeats allowed (2 beers can be the same beer).
function unitCombos(offers: Offer[], qty: number, repeats: boolean): Offer[][] {
  const out: Offer[][] = []
  const pick = (start: number, acc: Offer[]) => {
    if (acc.length === qty) return void out.push([...acc])
    for (let i = start; i < offers.length; i++) {
      if (!repeats && acc.some((a) => a.item.id === offers[i].item.id)) continue
      acc.push(offers[i])
      pick(repeats ? i : i + 1, acc)
      acc.pop()
    }
  }
  pick(0, [])
  return out
}

const sum = (xs: Offer[]) => xs.reduce((s, o) => s + o.usd, 0)
const round2 = (x: number) => Math.round(x * 100) / 100
const MAX_CANDIDATES_PER_WANT = 25
const MAX_COMBOS_PER_WANT = 3000

/** Per restaurant: combos[wantIndex] sorted by price, ascending (cheapest search) or descending
 *  (premium search, only offers ≤ maxPrice); empty when the restaurant can't serve that want. */
function wantCombos(r: Restaurant, wants: Want[], order: 'asc' | 'desc' = 'asc', maxPrice = Infinity): Offer[][][] {
  const dir = order === 'asc' ? 1 : -1
  return wants.map((w) => {
    const offers = r.items
      .filter((it) => matches(it, w.tag))
      .flatMap(offersOf)
      .filter((o) => o.usd <= maxPrice)
      .sort((a, b) => dir * (a.usd - b.usd))
      .slice(0, MAX_CANDIDATES_PER_WANT)
    return unitCombos(offers, w.qty, wantKind(w.tag) === 'beverage')
      .filter((c) => sum(c) <= maxPrice)
      .sort((a, b) => dir * (sum(a) - sum(b)))
      .slice(0, MAX_COMBOS_PER_WANT)
  })
}

/** Premium: the best spread one restaurant can serve within the budget — spend on food first
 *  (drinks count half), never over budget. Exhaustive with an optimistic-bound prune. */
function premiumForRestaurant(r: Restaurant, wants: Want[], budget: number): Solution | null {
  const combos = wantCombos(r, wants, 'desc', budget)
  if (combos.some((c) => !c.length)) return null
  const weight = wants.map((w) => (wantKind(w.tag) === 'beverage' ? 0.5 : 1))
  const value = (wi: number, c: Offer[]) => weight[wi] * sum(c)
  const maxRest = wants.map((_, j) => wants.slice(j).reduce((s, _w, k) => s + value(j + k, combos[j + k][0]), 0))
  const minCostRest = wants.map((_, j) => wants.slice(j).reduce((s, _w, k) => s + Math.min(...combos[j + k].map(sum)), 0))
  let best: (Solution & { value: number }) | null = null
  const chosen = new Map<number, Offer[]>()
  const used = new Set<string>()
  const dfs = (wi: number, cost: number, val: number) => {
    if (cost + (minCostRest[wi] ?? 0) > budget + 1e-9) return
    if (best && val + (maxRest[wi] ?? 0) <= best.value + 1e-9) return
    if (wi === wants.length) {
      best = { cost, value: val, groups: new Map(chosen) }
      return
    }
    for (const combo of combos[wi]) {
      if (cost + sum(combo) + (minCostRest[wi + 1] ?? 0) > budget + 1e-9) continue // too pricey; cheaper ones follow
      if (best && val + value(wi, combo) + (maxRest[wi + 1] ?? 0) <= best.value + 1e-9) break // sorted by price, desc
      if (combo.some((o) => used.has(o.item.id))) continue
      combo.forEach((o) => used.add(o.item.id))
      chosen.set(wi, combo)
      dfs(wi + 1, cost + sum(combo), val + value(wi, combo))
      chosen.delete(wi)
      combo.forEach((o) => used.delete(o.item.id))
    }
  }
  dfs(0, 0, 0)
  return best
}

function cheapestForSubset(combos: Offer[][][], wantIdx: number[]): Solution | null {
  if (wantIdx.some((i) => !combos[i].length)) return null
  let best: Solution | null = null
  const minRest = wantIdx.map((_, j) => wantIdx.slice(j).reduce((s, i) => s + sum(combos[i][0]), 0))
  const chosen = new Map<number, Offer[]>()
  const used = new Set<string>()
  const dfs = (j: number, cost: number) => {
    if (best && cost + (minRest[j] ?? 0) >= best.cost - 1e-9) return
    if (j === wantIdx.length) {
      best = { cost, groups: new Map(chosen) }
      return
    }
    const wi = wantIdx[j]
    for (const combo of combos[wi]) {
      const c = sum(combo)
      if (best && cost + c + (minRest[j + 1] ?? 0) >= best.cost - 1e-9) break // sorted by price
      if (combo.some((o) => used.has(o.item.id))) continue // one dish can't serve two wants
      combo.forEach((o) => used.add(o.item.id))
      chosen.set(wi, combo)
      dfs(j + 1, cost + c)
      chosen.delete(wi)
      combo.forEach((o) => used.delete(o.item.id))
    }
  }
  dfs(0, 0)
  return best
}

// ---------- step 2: fewest restaurants, then cheapest ----------
type Candidate = { cost: number; parts: { r: Restaurant; sol: Solution }[] }

function* subsets<T>(xs: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) return void (yield [...acc])
  for (let i = start; i < xs.length; i++) {
    acc.push(xs[i])
    yield* subsets(xs, k, i + 1, acc)
    acc.pop()
  }
}

/** Cheapest split of all wants across exactly these restaurants (each restaurant serves ≥ 1 want). */
function bestSplit(set: number[], table: (Solution | null)[][], restaurants: Restaurant[], nWants: number): Candidate | null {
  const full = (1 << nWants) - 1
  let best: { cost: number; masks: number[] } | null = null
  const assign = (pos: number, remaining: number, masks: number[], cost: number) => {
    if (best && cost >= best.cost - 1e-9) return
    if (pos === set.length) {
      if (remaining === 0) best = { cost, masks: [...masks] }
      return
    }
    const slotsLeft = set.length - pos - 1
    for (let m = remaining; m > 0; m = (m - 1) & remaining) {
      if (slotsLeft > 0 && (remaining & ~m) === 0) continue // leave something for the other restaurants
      const sol = table[set[pos]][m]
      if (!sol) continue
      masks.push(m)
      assign(pos + 1, remaining & ~m, masks, cost + sol.cost)
      masks.pop()
    }
  }
  assign(0, full, [], 0)
  if (!best) return null
  const b = best as { cost: number; masks: number[] }
  return { cost: b.cost, parts: set.map((ri, i) => ({ r: restaurants[ri], sol: table[ri][b.masks[i]] as Solution })) }
}

function toPlan(cand: Candidate, wants: Want[], budget: number): Plan {
  const stops: Stop[] = cand.parts.map(({ r, sol }) => {
    const lines: PlanLine[] = []
    for (const [wi, group] of [...sol.groups.entries()].sort((a, b) => a[0] - b[0])) {
      for (const o of group) {
        const existing = lines.find((l) => l.item_id === o.item.id && l.price_text === o.price.price_text && l.want === wants[wi].tag)
        if (existing) {
          existing.qty += 1
          existing.subtotal_usd = round2(existing.qty * existing.unit_price_usd)
          continue
        }
        const v = o.item.crosscheck?.verdict
        lines.push({
          want: wants[wi].tag,
          kind: itemKind(o.item),
          item_id: o.item.id,
          name_en: o.item.name_en ?? o.item.name_printed_latin ?? o.item.name_km ?? 'Unnamed item',
          name_km: o.item.name_km || null,
          variant: [o.price.variant_en, o.price.unit_en].filter(Boolean).join(', ') || null,
          qty: 1,
          unit_price_usd: round2(o.usd),
          subtotal_usd: round2(o.usd),
          price_text: o.price.price_text,
          source_image: o.item.source_image,
          verified: v === 'agree' ? 'agree' : v === 'disagree' ? 'disagree' : 'unchecked',
          confidence: o.item.confidence,
        })
      }
    }
    return {
      restaurant: { id: r.id, name_en: r.name_en, name_km: r.name_km },
      wants: [...sol.groups.keys()].sort().map((wi) => wants[wi].tag),
      lines,
      subtotal_usd: round2(sol.cost),
    }
  })
  const total = round2(cand.cost)
  const warnings: string[] = []
  for (const l of stops.flatMap((s) => s.lines)) {
    if (l.verified === 'disagree') warnings.push(`"${l.name_en}": the cross-checker disputed some details of this item.`)
    if (l.confidence != null && l.confidence < 0.8) warnings.push(`"${l.name_en}": low extraction confidence; check the menu photo.`)
  }
  if (total > budget) warnings.unshift(`Over budget by $${round2(total - budget).toFixed(2)}.`)
  return {
    restaurants_count: stops.length,
    stops,
    total_usd: total,
    within_budget: total <= budget + 1e-9,
    leftover_usd: Number.isFinite(budget) ? round2(budget - total) : null,
    over_budget_by_usd: total > budget ? round2(total - budget) : 0,
    warnings,
  }
}

export function planMeal(data: MenuData, req: PlanRequest): PlanResult {
  const hasBudget = req.budget_usd != null && Number(req.budget_usd) > 0
  const budget = hasBudget ? Number(req.budget_usd) : Infinity
  let style: Style = req.style === 'premium' ? 'premium' : 'cheapest'
  // Merge duplicate tags ("beer" twice -> qty summed) and classify each want as food or beverage.
  const merged = new Map<string, number>()
  for (const w of req.wants ?? []) {
    const tag = normaliseTag(String(w.tag ?? ''))
    if (tag) merged.set(tag, (merged.get(tag) ?? 0) + Math.max(1, Math.round(Number(w.qty) || 1)))
  }
  const wants: Want[] = [...merged].slice(0, 6).map(([tag, qty]) => ({ tag, qty: Math.min(qty, 6), kind: wantKind(tag) }))
  const notes: string[] = []
  const empty = (extra: string[] = []): PlanResult => ({
    budget_usd: hasBudget ? budget : null, style, wants, found: false, best: null, alternatives: [], within_budget_option: null, unavailable_wants: extra, notes,
  })

  if (!wants.length) {
    notes.push('No food or drink wants were given. For an open request, pick a balanced set yourself (e.g. a signature meat or seafood dish, a vegetable dish, rice or soup, drinks).')
    return empty()
  }
  if (style === 'premium' && !hasBudget) {
    notes.push('Premium needs a budget; showing the cheapest plan instead.')
    style = 'cheapest'
  }

  let restaurants = data.restaurants
  if (req.restaurant) {
    const q = req.restaurant.toLowerCase()
    restaurants = restaurants.filter((r) => r.id.toLowerCase().includes(q) || r.name_en.toLowerCase().includes(q) || (r.name_km ?? '').includes(req.restaurant!))
    if (!restaurants.length) {
      notes.push(`No restaurant matches "${req.restaurant}".`)
      return empty()
    }
  }

  // Step 1: table[r][mask] = cheapest way restaurant r serves the wants in `mask` (or null).
  const n = wants.length
  const table: (Solution | null)[][] = restaurants.map((r) => {
    const combos = wantCombos(r, wants)
    const row: (Solution | null)[] = [null]
    for (let mask = 1; mask < 1 << n; mask++) {
      const idx = wants.map((_, i) => i).filter((i) => mask & (1 << i))
      row.push(cheapestForSubset(combos, idx))
    }
    return row
  })

  const unavailable = wants.filter((_, i) => !table.some((row) => row[1 << i])).map((w) => w.tag)
  if (unavailable.length) {
    notes.push(`No restaurant in the dataset serves: ${unavailable.join(', ')}.`)
    return empty(unavailable)
  }

  // Premium: one restaurant, best spread within the budget. Falls back to the cheapest search below.
  if (style === 'premium') {
    const found: Candidate[] = []
    restaurants.forEach((r) => {
      const sol = premiumForRestaurant(r, wants, budget)
      if (sol) found.push({ cost: sol.cost, parts: [{ r, sol }] })
    })
    if (found.length) {
      found.sort((a, b) => b.cost - a.cost)
      const plans = found.slice(0, Math.max(1, req.max_plans ?? 3) + 1).map((c) => toPlan(c, wants, budget))
      notes.push(`Premium: the most generous single-restaurant spreads within $${budget}.`)
      notes.push(`Prices come from menu photos (~2024) at a fixed ${data.meta.riel_per_usd} riel per US dollar.`)
      return { budget_usd: budget, style, wants, found: true, best: plans[0], alternatives: plans.slice(1), within_budget_option: null, unavailable_wants: [], notes }
    }
    notes.push('No single restaurant covers every want within the budget; showing the cheapest plan instead.')
    style = 'cheapest'
  }

  // Step 2: k = 1, 2, … restaurants; stop at the first k that covers everything (and, if that is
  // over budget, keep going until a within-budget option appears).
  const idx = restaurants.map((_, i) => i)
  let best: Plan | null = null
  let alternatives: Plan[] = []
  let withinBudget: Plan | null = null
  for (let k = 1; k <= Math.min(n, restaurants.length); k++) {
    const found: Candidate[] = []
    for (const set of subsets(idx, k)) {
      const c = bestSplit(set, table, restaurants, n)
      if (c) found.push(c)
    }
    if (!found.length) continue
    found.sort((a, b) => a.cost - b.cost)
    if (!best) {
      const plans = found.slice(0, Math.max(1, req.max_plans ?? 3) + 1).map((c) => toPlan(c, wants, budget))
      best = plans[0]
      alternatives = plans.slice(1)
      if (best.within_budget) break
      notes.push(`The best plan (${k} restaurant${k > 1 ? 's' : ''}) is over budget.`)
    } else if (found[0].cost <= budget + 1e-9) {
      withinBudget = toPlan(found[0], wants, budget)
      notes.push(`A plan within budget exists if you visit ${k} restaurants.`)
      break
    }
  }
  notes.push(`Prices come from menu photos (~2024) at a fixed ${data.meta.riel_per_usd} riel per US dollar.`)

  if (!hasBudget) notes.push('No budget was given: plans are not limited by price.')
  return { budget_usd: hasBudget ? budget : null, style, wants, found: !!best, best, alternatives, within_budget_option: withinBudget, unavailable_wants: [], notes }
}

// ---------- menu search (second agent tool) ----------
export type SearchRequest = { query?: string; tag?: string; kind?: Kind; restaurant?: string; max_price_usd?: number; limit?: number }

export function searchMenu(data: MenuData, req: SearchRequest) {
  const q = req.query?.trim().toLowerCase()
  const tag = req.tag ? normaliseTag(req.tag) : null
  const rq = req.restaurant?.toLowerCase()
  const max = req.max_price_usd ?? Infinity
  const rows = data.restaurants
    .filter((r) => !rq || r.id.includes(rq) || r.name_en.toLowerCase().includes(rq))
    .flatMap((r) =>
      r.items
        .filter((it) => !tag || matches(it, tag))
        .filter((it) => !req.kind || itemKind(it) === req.kind)
        .filter((it) => !q || [it.name_en, it.name_km, it.name_printed_latin, it.description_en].some((s) => s?.toLowerCase().includes(q)))
        .filter((it) => it.min_price_usd != null && it.min_price_usd <= max)
        .map((it) => ({
          restaurant: r.name_en,
          name_en: it.name_en,
          name_km: it.name_km || null,
          kind: itemKind(it),
          category: it.category,
          prices: it.prices.map((p) => `${p.price_text} ≈ $${p.price_usd}${p.variant_en ? ` (${p.variant_en})` : ''}`),
          min_price_usd: it.min_price_usd,
        })),
    )
    .sort((a, b) => (a.min_price_usd ?? 0) - (b.min_price_usd ?? 0))
  return { total_matches: rows.length, items: rows.slice(0, Math.min(req.limit ?? 15, 40)) }
}

export function listRestaurants(data: MenuData) {
  return data.restaurants.map((r) => ({
    id: r.id,
    name_en: r.name_en,
    name_km: r.name_km,
    food_items: r.items.filter((it) => itemKind(it) === 'food').length,
    beverage_items: r.items.filter((it) => itemKind(it) === 'beverage').length,
    has_chicken: r.items.some((it) => matches(it, 'chicken')),
    has_vegetables: r.items.some((it) => matches(it, 'vegetables')),
    has_beer: r.items.some((it) => matches(it, 'beer')),
  }))
}
