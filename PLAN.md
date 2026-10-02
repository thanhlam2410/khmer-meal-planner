# Khmer Menu Intelligence — Plan

**Goal:** a web app, live at a here.now link, that answers:
> "I have a budget of $10. I want chicken, some vegetables, and a couple of beers. What should I order, and from where?"

**Constraint:** all AI calls go through **OpenRouter** (one API key, OpenAI-compatible endpoint `https://openrouter.ai/api/v1/chat/completions`). Time limit: 3 hours.

---

## 1. Approach

**Extract once, offline.** Run each of the 31 screenshots through a vision model on OpenRouter, using a strict JSON schema. Each item comes back as `{restaurant, item_km, item_en, category, price, currency, unit, variant, confidence}`. A Node script normalises prices to USD (4,000៛ = $1), converts Khmer numerals (០–៩) to ASCII digits, and writes **`menus.json`**. That file is the whole database. Nothing is OCR'd at runtime.

- **Primary extractor:** `google/gemini-2.5-pro`. It is strong on Khmer script and dense layouts.
- **Cross-checker:** a second vision model, e.g. `anthropic/claude-sonnet-4.5` or `openai/gpt-5`. I'll check the exact slugs on openrouter.ai/models on the day. Rows where the two models disagree on price or category get flagged for a human to check.
- **Pre-processing:** auto-rotate sideways photos (some are rotated 90°), and split very tall images into overlapping tiles.

**Optimizer: deterministic code, not the LLM.** The question is a **multiple-choice knapsack** problem. Pick ≥1 chicken dish, ≥1 vegetable dish and 2 beers, all from **one restaurant**, with total ≤ budget. Prefer more food and money left over, in that order. Each restaurant's menu has tens of items, so **exhaustive enumeration per restaurant** finds the best answer in milliseconds. It returns the top 3 restaurants. Alternatives if the constraints grow:
- **ILP** with `javascript-lp-solver`, for general constraints
- **0/1 knapsack DP**, for a "maximise value" objective
- **Greedy**, cheapest item per category, kept as a test baseline

**Agent: thin tool-use loop through OpenRouter.** An OpenRouter model with tool calling (default `google/gemini-2.5-flash` for speed and cost; a Claude model as the alternative) turns free text into constraints. It calls one tool, `plan_meal({budget_usd, wants:[{category, qty}], restaurant?})`, then explains the result in plain English. The explanation covers what to order (Khmer + English names), where, the total and the change left over. The LLM never does the arithmetic.

## 2. Fallback

| Failure | Fallback |
|---|---|
| Primary model misreads Khmer or prices | Cross-check model, plus a hand check of every **chicken / vegetable / beer** row (~15 min). Only these rows affect the demo question. |
| Both models fail on an image (glare, blur) | Drop that image from the dataset and record it in `menus.json` as `excluded` |
| OpenRouter rate-limits or the proxy fails at runtime | The page has a structured form (budget + category checkboxes) that calls the same optimizer directly. The core question still gets answered with no AI. |
| Agent picks the wrong tool arguments | A regex parser for budget, "chicken", "vegetables" and "N beers" pre-fills defaults; the LLM can only override them |

## 3. Not doing

No live OCR or image upload in the app. No OCR fine-tuning. No backend database or vector store. No LangChain-style framework. No accounts. No multi-restaurant combinations (one meal comes from one place). No delivery fees or taxes.

## 4. Getting it live on here.now

| Runs in the browser (static) | Goes through the proxy route |
|---|---|
| `index.html`, UI, `menus.json`, optimizer (JS), fallback form, the `plan_meal` tool | `POST /api/chat` → OpenRouter chat completions, with `OPENROUTER_API_KEY` held server-side |
| Runs the tool locally when the model asks for it, then sends the result back | Only messages and tool results pass through; nothing is stored |

Steps: Claude Code deploys the local folder to a free here.now account. I add the OpenRouter key as a proxy secret, then check the live URL with the exact brief question, on desktop and mobile.

## 5. Accuracy prediction (written before processing anything)

Each figure is per item, from automated extraction before the human check. I'll measure against a hand-labelled gold set of 3 menus (~60 items).

| Field | Expected accuracy | Main risk seen in the samples |
|---|---|---|
| Restaurant identification | ~85% | Several screenshots have no restaurant name or logo |
| Item name, Khmer, character-exact | 60–75% | Stylised fonts, glare over text, rotated photos, subscript consonants |
| Item meaning (English gloss correct) | 85–90% | Dishes regional enough that a near-miss name gives a different dish |
| Category tag (chicken / vegetable / beer / other) | 90–95% | Chicken depends on spotting មាន់; "vegetable" is vague (stir-fried greens vs. a dish with lettuce on the side) |
| Price digits | 88–93% | Khmer numerals (១២,០០០), thousand separators, glare |
| Currency (៛ vs $) | 95%+ | Columns where the symbol appears only in the header |
| Price ↔ item/variant pairing | 80–85% | **Largest risk:** can vs. bottle columns, small vs. large, per-plate vs. per-kg (`1ចាន/6000៛`, `កន្លះគីឡូ` = half kg) |
| Beer items (name + price) | ~95% | Brand names are in Latin script |
| **Demo-relevant rows after the human check** | **~99%** | Remaining risk: reading the menu correctly but tagging the wrong variant |

## 6. Assumptions

**Task**
1. "A couple of beers" means exactly 2 beers. The cheapest beer format (can or small bottle) is fine unless the user says otherwise.
2. "Chicken" means at least one dish whose main protein is chicken (មាន់), including chicken soups and chicken feet.
3. "Some vegetables" means at least one dish that is mostly vegetables (stir-fried greens, salad, vegetable soup), or a chicken dish cooked with vegetables. Garnish alone doesn't count.
4. The whole order comes from **one restaurant** ("from where?" is singular).
5. The $10 budget covers menu prices only: no tax, tip, service charge or delivery.
6. Exchange rate is a flat 4,000៛ = $1. Where a menu prints both $ and ៛, the $ price is used.
7. Rice is not added automatically. A side of rice is suggested only if there is budget left.
8. Answers are in English, with Khmer dish names kept so the user can point at the menu.
9. Other budgets and food wishes should work too; the brief question is the main test case.

**Data**
10. ~31 screenshots ≈ ~30 menus, but some restaurants span several screenshots. They are grouped by logo or name, then by nearby timestamps.
11. Prices are current and accurate. Menus are 2024-era Google Maps photos, so real prices may have drifted.
12. Items without a readable price are excluded rather than guessed.
13. Per-kg or "half kg" items are priced as printed, as one order unit.
14. Not every menu has beer or chicken. Restaurants missing a required category are skipped for that query.
15. Images are photos and screenshots of printed menus (some rotated, some with glare or partly cut off). None are handwritten.
16. Item photos are not used to infer categories; text is the source of truth.

**Platform**
17. OpenRouter provides vision and tool-calling models through one key; exact model slugs are checked on the day.
18. The here.now free tier supports static hosting plus a proxy route with a stored secret. This is **not yet verified**. If it doesn't, the app ships with only the AI-free form.

## 7. Two extra requirements for the brief

1. **Every recommendation shows its evidence.** Each suggested item lists its Khmer name, English gloss, original printed price (៛ or $), USD conversion and the source screenshot, so the user can check it against the real menu. When the extraction confidence was low, the item is labelled *"verify price"*.
2. **Honest infeasibility.** If no restaurant can meet every constraint within budget, the app says so. It then shows the closest option and what to change: "nearest is $11.25 at X", or "drop to 1 beer to fit at Y". It never invents an item or a price.

## 8. Timeline (3 h)

| Time | Work |
|---|---|
| 0:00–0:15 | Check here.now proxy docs and OpenRouter slugs; group screenshots by restaurant |
| 0:15–1:15 | Extraction script, run both models, compare with gold set, hand-check demo rows |
| 1:15–1:45 | Optimizer + unit tests against hand-solved answers |
| 1:45–2:15 | Agent loop via proxy, and the fallback form |
| 2:15–2:45 | UI, deploy to here.now, live test |
| 2:45–3:00 | Buffer and write-up (measured accuracy vs. prediction) |
