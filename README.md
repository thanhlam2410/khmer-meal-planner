# Khmer Menu Planner

A web app that answers:

> "I have a budget of $10. I want chicken, some vegetables, and a couple of beers. What should I order, and from where?"

using ~30 restaurant menus from Cambodia, written in Khmer.

**Live:** https://swift-sleet-z44r.here.now/

| Step | What | Status |
|---|---|---|
| 1 | Turn menu photos into a structured dataset (OCR + translation + USD prices) | ✅ done — see below |
| 2 | Meal-plan algorithm (fewest restaurants, then cheapest) | ✅ implemented |
| 3 | Chat agent that calls the algorithm as a tool | ✅ implemented + deployed |
| 4 | Deploy to here.now (static site + proxy route for the LLM) | ✅ live |

---

## Project layout

```
data/
  raw/<folder>/*.png        menu screenshots, one folder per restaurant (manual grouping)
  raw/_original_names.json  original screenshot file names
  restaurant-names.json     manual restaurant names (with evidence)
  menus.json                ⭐ final dataset used by the app
  extraction-report.json    accuracy, cost, items needing review
  cache/                    per-image model outputs (gitignored)
scripts/
  extraction/               step 1 pipeline (Python) + requirements.txt
  extract.mjs, lib/         first JS version of the same pipeline (kept for reference)
  export-session.mjs        exports Claude Code chat logs to ai-session/
src/                        React chat app (Vite)
public/.herenow/proxy.json  here.now proxy route: /api/chat -> OpenRouter
logs/llm-usage.jsonl        every LLM call: model, tokens, cost, latency
ai-session/                 readable logs of the AI-assisted working sessions
PLAN.md / PLAN.txt          the plan, accuracy prediction and assumptions (written before processing)
```

## Setup

```bash
cp .env.example .env          # add OPENROUTER_API_KEY (all AI calls go through OpenRouter)
npm install                   # web app
uv venv scripts/extraction/.venv
uv pip install -p scripts/extraction/.venv/bin/python -r scripts/extraction/requirements.txt
npm run dev                   # local app; /api/chat is proxied to OpenRouter with the key from .env
```

Secrets live only in `.env` (gitignored). In production the OpenRouter key is a here.now account variable injected by the proxy route, so it never reaches the browser.

---

## Step 1 — Menu extraction

### Approach

There are 31 screenshots (Google Maps photos of printed menus): rotated photos, glare, two-page spreads, Khmer numerals (១២,០០០), prices in riel (៛) and dollars, per-plate / per-kg / can-vs-bottle price columns.

Instead of a classic OCR engine (weak on Khmer), a **vision LLM reads each image and returns structured JSON directly**, and a second model audits a sample.

```
data/raw/*.png
   │ 1. prepare      PNG -> JPEG (Pillow, full resolution)
   │ 2. extract      google/gemini-2.5-pro: every item -> Khmer name (as printed), English name,
   │                 description, section, category, tags, prices[] (exact printed text,
   │                 amount, currency, variant, unit), confidence, notes
   │ 3. cross-check  anthropic/claude-opus-5.5 audits a random 30% of images item by item
   │                 (exists? Khmer spelling? translation? price? category?) + missed items
   │ 4. build        code (not the model) re-parses each printed price, converts Khmer digits,
   │                 converts to USD at a fixed 4,000 ៛ = $1, flags suspicious prices,
   │                 groups images into restaurants
   ▼
data/menus.json + data/extraction-report.json
```

Model choice: [SEA-Vision (2026)](https://arxiv.org/pdf/2603.15409) reports Gemini 2.5 Pro as the strongest general model on Khmer document OCR; Claude was used as an independent second opinion so the two models' errors are less correlated.

**The original Khmer is always kept** (`name_km`, `section_km`, `prices[].price_text`, `variant_km`, `unit_km`) next to the English, so any item can be checked against the photo (`source_image`).

### Run it

```bash
npm run extract                                      # all stages, cached (re-runs skip finished images)
npm run extract -- --crosscheck-rate 0               # extraction only
npm run extract -- --skip-extract --crosscheck-rate 0.3   # cross-check only
npm run extract -- --build-only                      # rebuild menus.json from cache, no model calls
npm run extract -- --help
```

### Manual refinement

The automatic output was refined by hand, without re-running any model:

1. **Restaurant grouping** — the images were sorted by hand into `data/raw/<folder>/`, one folder per restaurant. The model only finds a restaurant name on some pages, and it sometimes mistakes section headings for names.
2. **Restaurant names** — `data/restaurant-names.json` fixes names the model missed or misread, with the evidence for each:
   - Folder 3 → *Tbal Khmer* (logo on the menu edges, not detected)
   - Folder 6 → *Mhoub Bopha* (the other "names" were the headings "dishes" / "stir-fried dishes")
   - Folder 10 → *Bayon* (stylised logo misread as "Lilis")
   - Folder 11 → *Rainbow*: 4 photos merged (Rainbow logo, Rainbow-branded dishes, shared design, taken within 27 s)
3. **Item fixes:** `data/manual-fixes.json` holds hand corrections, each with its reason, and the item keeps a `manual_fix` note.
   - Reatry Battambong: 4 sticker-covered prices flagged `handwritten_sticker`, so the planner never uses them.
   - Rainbow: 9 dishes in the "chicken feet / chicken / duck / frog / eel" section re-categorised as chicken (one had been mistranslated as clams).
4. `npm run extract -- --build-only` re-applies all of this from cache in a second, for free.

Result: **12 restaurants, 546 items, 31 images.**

### Accuracy — predicted vs measured

The prediction was written in [PLAN.md](PLAN.md) before any image was processed. "Measured" is the cross-check: Claude auditing Gemini on 165 items from 10 randomly chosen images.

| Field | Predicted | Measured |
|---|---|---|
| Item exists (no hallucinated items) | — | 100% |
| Price | 88–93% | **97.0%** |
| Category (chicken / vegetable / beer …) | 90–95% | **97.0%** |
| English meaning | 85–90% | **92.7%** |
| Khmer spelling (exact) | 60–75% | **87.9%** |
| All fields correct | — | 79.4% |
| Missed items | — | 2 in 10 images |

Caveat: this is model-vs-model agreement, not a human-labelled gold set. If both models make the same mistake, it isn't caught, so treat the numbers as upper bounds.

### Known limitations (extraction is not perfect)

- **Handwritten price stickers** (`15/2026-07-21_11-16-25.png`, Reatry Battambong): the affected prices are flagged and excluded rather than guessed, and 2 more items there have no price.
- **Category mistakes** remain possible in the 21 images that weren't audited. The ones found in the audited images are fixed in `manual-fixes.json`.
- **Khmer spelling slips**: ~12% of names have a one-character error. This doesn't affect the meal planner, which uses category, tags and prices.
- **22 items have no readable price** and are ignored by the planner.
- 21 of 31 images were not cross-checked.
- Prices are from ~2024 photos at a flat 4,000 ៛/$, so real prices may have changed.
- Every disputed or flagged item is listed in `data/extraction-report.json → items_needing_review`. Nothing is silently auto-corrected.

### Cost

| Stage | Calls | Cost |
|---|---|---|
| Extraction (Gemini 2.5 Pro) | 32 | $2.64 |
| Cross-check (Claude Opus 5.5) | 10 | $0.90 |
| **Total** | 42 | **$3.53** |

Every call is logged in `logs/llm-usage.jsonl` (model, tokens, reasoning tokens, cost, latency, errors).

---

## Step 2 — Meal-plan algorithm

[src/optimizer/planMeal.ts](src/optimizer/planMeal.ts) runs in the browser over `menus.json`.

**Problem.** Given a budget and a list of *wants* (e.g. 1× chicken, 1× vegetables, 2× beer), choose menu items, from one or more restaurants, that satisfy every want. This is a **multiple-choice knapsack** with a set-cover layer on top.

**Objective (lexicographic):**
1. **Fewest restaurants.** One stop is best; two only if no single restaurant has everything, and so on.
2. **Lowest total cost** among plans with that number of restaurants.
3. If that optimum is **over budget, it is still returned, flagged** (`within_budget: false`, `over_budget_by_usd`). The search then continues with more restaurants and returns `within_budget_option` if a cheaper plan with more stops fits the budget. The agent is told to highlight this.

**Method (exact, ~1–10 ms):**
1. For each restaurant and each subset of wants: the cheapest way that restaurant alone serves the subset, by exhaustive search with pruning. A dish never counts for two wants. Beverages may repeat (2× the same beer); food dishes are distinct.
2. Enumerate restaurant sets of size k = 1, 2, … and the cheapest split of the wants among them. Stop at the first k that covers everything.

**Classification.**
- Every item is `food` or `beverage` (from its category). Of the 546 items, 402 are food and 144 beverages.
- A want like `vegetables` means a *vegetable dish*: vegetable or salad category, or a meat-free dish tagged vegetables. Herb salads with shrimp count; a beef dish with a lettuce garnish doesn't.
- `beer` excludes beer cocktails.

**Price safety.** Prices the cross-checker disputed, prices flagged as suspicious, and items with no price are never recommended.

Other options considered: ILP (e.g. `javascript-lp-solver`) for richer constraints, 0/1-knapsack DP for a "maximise value" objective, and greedy (cheapest per want) as a baseline. Exhaustive search is exact and fast enough for 12 menus.

Example (the brief): **Rainbow, $5.50**: chicken with rice, papaya salad, 2× Anchor beer ($4.50 left). Alternative: The Street Cambodia TK branch, $7.51.

## Step 3 — Chat agent

[src/agent/](src/agent/) is an OpenRouter **tool-calling loop that runs in the browser** (model from `AGENT_MODEL` in `.env`).

| Tool | What it does |
|---|---|
| `plan_meal` | The algorithm above |
| `search_menu` | Search items by text, tag, kind (food/beverage), restaurant, max price |
| `list_restaurants` | Restaurants with food/beverage counts and chicken/vegetable/beer availability |

The LLM interprets casual wording ("a couple of beers" → 2) and writes the advice. **All prices and arithmetic come from the tools.** The chat UI renders plan cards straight from the tool result, so the numbers shown never depend on the model's wording. Over-budget plans are highlighted in the card and in the reply.

## Deployment

here.now serves static files only (no Docker or server code), so:

| Runs in the browser | Goes through the here.now proxy route |
|---|---|
| React UI, `menus.json`, the meal-plan algorithm, the agent loop | `POST /api/chat` → OpenRouter chat completions; the API key is injected server-side from a here.now account variable |
