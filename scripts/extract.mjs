#!/usr/bin/env node
// Offline menu extraction: images -> structured, translated, USD-priced dataset.
//
//   node --env-file=.env scripts/extract.mjs [options]
//
// Stages (each cached under data/cache/, so re-runs only redo what's missing):
//   1. prepare     PNG -> JPEG (macOS `sips`, full resolution) to keep uploads small
//   2. extract     EXTRACT_MODEL reads Khmer text, translates to English, returns JSON
//   3. crosscheck  CROSSCHECK_MODEL audits a random sample of images item-by-item
//   4. build       normalise prices to USD, group images into restaurants,
//                  write data/menus.json + data/extraction-report.json
//
// Options:
//   --only a.png,b.png     process only these images
//   --limit N              process only the first N images (sorted by time)
//   --force                re-run extraction even if cached
//   --force-crosscheck     re-run cross-check even if cached
//   --crosscheck-rate R    fraction of images to audit (default 0.3; 0 disables)
//   --seed N               random seed for the audit sample (default 42)
//   --concurrency N        parallel model calls (default 3)
//   --build-only           skip model calls; rebuild outputs from cache
//
// Env: OPENROUTER_API_KEY, EXTRACT_MODEL, CROSSCHECK_MODEL, RIEL_PER_USD (default 4000)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, parse } from 'node:path'
import { createHash } from 'node:crypto'
import { USAGE_LOG, chatJSON, imagePart } from './lib/openrouter.mjs'
import { CROSSCHECK_SYSTEM, EXTRACT_SYSTEM, crosscheckUserPrompt, extractUserPrompt } from './lib/prompts.mjs'

// ---------- config ----------
const RAW_DIR = 'data/raw'
const CACHE = { jpeg: 'data/cache/jpeg', extract: 'data/cache/extract', crosscheck: 'data/cache/crosscheck' }
const OVERRIDES_FILE = 'data/restaurant-overrides.json' // optional: { "image.png": "restaurant-id" }
const OUT_MENUS = 'data/menus.json'
const OUT_REPORT = 'data/extraction-report.json'

const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'google/gemini-2.5-pro'
const CROSSCHECK_MODEL = process.env.CROSSCHECK_MODEL || 'anthropic/claude-opus-5.5'
const RIEL_PER_USD = Number(process.env.RIEL_PER_USD || 4000)
const NEIGHBOUR_GAP_SEC = 180 // an unnamed image inherits the previous image's restaurant if taken within 3 min

const args = parseArgs(process.argv.slice(2))
Object.values(CACHE).forEach((d) => mkdirSync(d, { recursive: true }))

// ---------- stage 1: prepare ----------
function prepareJpeg(img) {
  const out = join(CACHE.jpeg, `${parse(img).name}.jpg`)
  if (existsSync(out)) return
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', join(RAW_DIR, img), '--out', out], { stdio: 'ignore' })
}
const jpegBase64 = (img) => readFileSync(join(CACHE.jpeg, `${parse(img).name}.jpg`)).toString('base64')

// ---------- stage 2: extract ----------
function validateExtraction(json, img) {
  if (!json || !Array.isArray(json.items)) throw new Error(`no "items" array for ${img}`)
  json.items = json.items.filter((it) => it && (it.name_km || it.name_en || it.name_printed_latin))
  for (const it of json.items) {
    it.prices = Array.isArray(it.prices) ? it.prices : []
    it.tags = Array.isArray(it.tags) ? it.tags : []
  }
}

// ---------- stage 3: crosscheck ----------
function itemsForAudit(img) {
  const { result } = readJSON(join(CACHE.extract, `${img}.json`))
  return result.items.map((it, i) => ({
    id: itemId(img, i),
    name_km: it.name_km,
    name_printed_latin: it.name_printed_latin,
    name_en: it.name_en,
    category: it.category,
    tags: it.tags,
    prices: it.prices.map(({ price_text, amount, currency, variant_en }) => ({ price_text, amount, currency, variant_en })),
  }))
}

const isAgree = (v) => v.exists !== false && v.name_km_ok !== false && v.translation_ok !== false && v.price_ok !== false && v.category_ok !== false

function sampleImages(list, rate, seed) {
  const n = Math.min(list.length, Math.max(1, Math.ceil(list.length * rate)))
  const rand = mulberry32(seed)
  const shuffled = [...list]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n).sort()
}

// ---------- stage 4: build ----------
function build(images) {
  const overrides = existsSync(OVERRIDES_FILE) ? readJSON(OVERRIDES_FILE) : {}
  const pages = images
    .filter((img) => existsSync(join(CACHE.extract, `${img}.json`)))
    .map((img) => ({ img, ext: readJSON(join(CACHE.extract, `${img}.json`)), cc: maybeJSON(join(CACHE.crosscheck, `${img}.json`)) }))

  // -- group pages into restaurants --
  const restaurants = new Map()
  let prev = null
  for (const p of pages) {
    const r = p.ext.result.restaurant ?? {}
    let id, source
    if (overrides[p.img]) {
      id = overrides[p.img]
      source = 'override'
    } else if (r.visible && (r.name_en || r.name_km)) {
      id = restaurantId(r)
      source = 'visible'
    } else if (prev && timeGapSec(prev.img, p.img) <= NEIGHBOUR_GAP_SEC) {
      id = prev.restaurantId
      source = 'inferred_from_previous_image'
    } else {
      id = `unknown-${parse(p.img).name}`
      source = 'unknown'
    }
    if (!restaurants.has(id)) restaurants.set(id, { id, name_en: null, name_km: null, name_source: source, images: [], items: [] })
    const rest = restaurants.get(id)
    if (r.visible) {
      rest.name_en ??= r.name_en ?? null
      rest.name_km ??= r.name_km ?? null
      rest.name_source = source === 'override' ? 'override' : 'visible'
    }
    rest.images.push({ file: p.img, restaurant_source: source, image_quality: p.ext.result.image_quality ?? null })
    p.restaurantId = id
    prev = p

    // -- items --
    const audit = new Map((p.cc?.result?.items ?? []).map((v) => [v.id, v]))
    p.ext.result.items.forEach((it, i) => {
      const id = itemId(p.img, i)
      const prices = it.prices.map(normalisePrice)
      const usd = prices.map((x) => x.price_usd).filter((x) => x != null)
      const v = audit.get(id)
      rest.items.push({
        id,
        name_en: it.name_en ?? null,
        name_km: it.name_km ?? null,
        name_printed_latin: it.name_printed_latin ?? null,
        description_en: it.description_en ?? null,
        section_en: it.section_en ?? null,
        section_km: it.section_km ?? null,
        category: it.category ?? 'other',
        tags: it.tags,
        prices,
        min_price_usd: usd.length ? Math.min(...usd) : null,
        confidence: typeof it.confidence === 'number' ? it.confidence : null,
        notes: it.notes ?? null,
        source_image: p.img,
        crosscheck: p.cc
          ? v
            ? {
                verdict: isAgree(v) ? 'agree' : 'disagree',
                name_km_ok: v.name_km_ok ?? null,
                translation_ok: v.translation_ok ?? null,
                price_ok: v.price_ok ?? null,
                category_ok: v.category_ok ?? null,
                exists: v.exists ?? null,
                correct_prices: v.correct_prices ?? null,
                note: v.note ?? null,
              }
            : { verdict: 'not_returned' }
          : null,
      })
    })
  }

  const list = [...restaurants.values()].map((r) => ({
    ...r,
    name_en: r.name_en ?? (r.id.startsWith('unknown-') ? `Unnamed restaurant (${r.images[0].file})` : r.id),
  }))
  const itemCount = list.reduce((n, r) => n + r.items.length, 0)

  writeJSON(OUT_MENUS, {
    meta: {
      generated_at: new Date().toISOString(),
      extract_model: EXTRACT_MODEL,
      crosscheck_model: CROSSCHECK_MODEL,
      riel_per_usd: RIEL_PER_USD,
      source_images: pages.length,
      restaurants: list.length,
      items: itemCount,
      note: 'Original Khmer text is kept in *_km fields and prices[].price_text. USD prices are computed in code at a fixed rate.',
    },
    restaurants: list,
  })

  writeJSON(OUT_REPORT, report(pages, list))
  log(`built ${OUT_MENUS}: ${list.length} restaurants, ${itemCount} items from ${pages.length} images`)
}

// Prices: re-derive the amount from the literal printed text (Khmer numerals -> ASCII) and
// convert to USD in code. Disagreements with the model's own reading are flagged, not hidden.
function normalisePrice(p) {
  const text = String(p.price_text ?? '')
  const ascii = khmerDigits(text)
  let currency = /\$|usd/i.test(ascii) ? 'USD' : /៛|riel|\bR\b/i.test(ascii) ? 'KHR' : p.currency === 'USD' ? 'USD' : 'KHR'
  const flags = []

  const nums = [...ascii.matchAll(/\d[\d.,\s]*\d|\d/g)].map((m) => parseNumber(m[0].trim(), currency))
  const modelAmount = typeof p.amount === 'number' ? p.amount : null
  let amount = nums.find((n) => n === modelAmount) ?? (nums.length ? Math.max(...nums) : modelAmount)
  if (amount == null || Number.isNaN(amount)) {
    amount = modelAmount
    flags.push('unparsed_price_text')
  }
  if (modelAmount != null && amount !== modelAmount) flags.push('model_amount_differs')
  if (p.currency && p.currency !== currency) flags.push('currency_differs_from_model')
  if (currency === 'KHR' && amount != null && amount < 100) flags.push('suspect_low_riel')
  if (currency === 'USD' && amount != null && amount > 100) flags.push('suspect_high_usd')

  const usd = amount == null ? null : currency === 'USD' ? amount : amount / RIEL_PER_USD
  return {
    price_text: text,
    amount,
    currency,
    price_usd: usd == null ? null : Math.round(usd * 100) / 100,
    variant_en: p.variant_en ?? null,
    variant_km: p.variant_km ?? null,
    unit_en: p.unit_en ?? null,
    unit_km: p.unit_km ?? null,
    flags,
  }
}

function parseNumber(s, currency) {
  const t = s.replace(/\s/g, '')
  if (currency === 'KHR') return Number(t.replace(/[.,]/g, '')) // riel: separators are thousands
  if (/^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''))
  return Number(t.replace(',', '.'))
}

const khmerDigits = (s) => s.replace(/[០-៩]/g, (d) => String(d.charCodeAt(0) - 0x17e0))

function report(pages, restaurants) {
  const extractCost = pages.reduce((s, p) => s + Number(p.ext.usage?.cost ?? 0), 0)
  const audited = pages.filter((p) => p.cc)
  const verdicts = audited.flatMap((p) => p.cc.result?.items ?? [])
  const rate = (field) => {
    const vals = verdicts.map((v) => v[field]).filter((x) => typeof x === 'boolean')
    return vals.length ? Math.round((vals.filter(Boolean).length / vals.length) * 1000) / 10 : null
  }
  const allItems = restaurants.flatMap((r) => r.items)
  const flagged = allItems.filter((it) => it.prices.some((p) => p.flags.length) || it.crosscheck?.verdict === 'disagree')
  return {
    generated_at: new Date().toISOString(),
    models: { extract: EXTRACT_MODEL, crosscheck: CROSSCHECK_MODEL },
    cost_usd: {
      extract: round4(extractCost),
      crosscheck: round4(audited.reduce((s, p) => s + Number(p.cc.usage?.cost ?? 0), 0)),
    },
    images: pages.map((p) => ({
      file: p.img,
      restaurant: p.restaurantId,
      items: p.ext.result.items.length,
      image_quality: p.ext.result.image_quality ?? null,
      rotation_degrees: p.ext.result.rotation_degrees ?? null,
      audited: Boolean(p.cc),
    })),
    crosscheck: {
      images_audited: audited.length,
      items_audited: verdicts.length,
      agreement_pct: {
        overall: verdicts.length ? Math.round((verdicts.filter(isAgree).length / verdicts.length) * 1000) / 10 : null,
        exists: rate('exists'),
        name_km: rate('name_km_ok'),
        translation: rate('translation_ok'),
        price: rate('price_ok'),
        category: rate('category_ok'),
      },
      missing_items_reported: audited.reduce((n, p) => n + (p.cc.result?.missing_items?.length ?? 0), 0),
      missing_items: audited.flatMap((p) => (p.cc.result?.missing_items ?? []).map((m) => ({ image: p.img, ...m }))),
    },
    restaurants: restaurants.map((r) => ({ id: r.id, name_en: r.name_en, name_source: r.name_source, images: r.images.map((i) => i.file), items: r.items.length })),
    items_needing_review: flagged.map((it) => ({
      id: it.id,
      name_en: it.name_en,
      name_km: it.name_km,
      prices: it.prices.map((p) => `${p.price_text} -> $${p.price_usd}${p.flags.length ? ` [${p.flags.join(', ')}]` : ''}`),
      crosscheck: it.crosscheck?.verdict === 'disagree' ? { note: it.crosscheck.note, correct_prices: it.crosscheck.correct_prices } : null,
    })),
  }
}

// Per-run totals from logs/llm-usage.jsonl.
function summariseUsage(since) {
  if (!existsSync(USAGE_LOG)) return
  const rows = readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ts >= since)
  if (!rows.length) return log('usage: no model calls this run')
  const by = {}
  for (const r of rows) {
    const k = `${r.stage} · ${r.model_requested}`
    by[k] ??= { calls: 0, failed: 0, cost: 0, tokens: 0 }
    by[k].calls++
    if (!r.ok) by[k].failed++
    by[k].cost += Number(r.cost_usd ?? 0)
    by[k].tokens += Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0)
  }
  for (const [k, v] of Object.entries(by)) log(`usage ${k}: ${v.calls} calls (${v.failed} failed), ${v.tokens} tokens, $${round4(v.cost)}`)
  log(`usage total this run: $${round4(rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0))} → ${USAGE_LOG}`)
}

// ---------- helpers ----------
function restaurantId(r) {
  const base = (r.name_en || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (base) return base
  return `km-${createHash('sha1').update(r.name_km).digest('hex').slice(0, 8)}`
}
const itemId = (img, i) => `${parse(img).name}#${String(i + 1).padStart(3, '0')}`

function timeGapSec(a, b) {
  const t = (f) => {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/)
    return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) / 1000 : NaN
  }
  return Math.abs(t(b) - t(a))
}

async function pool(items, n, fn) {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift())
  }))
}

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parseArgs(argv) {
  const a = { concurrency: 3, crosscheckRate: 0.3, seed: 42 }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const next = () => argv[++i]
    if (k === '--only') a.only = next().split(',').map((s) => s.trim())
    else if (k === '--limit') a.limit = Number(next())
    else if (k === '--force') a.force = true
    else if (k === '--force-crosscheck') a.forceCrosscheck = true
    else if (k === '--crosscheck-rate') a.crosscheckRate = Number(next())
    else if (k === '--seed') a.seed = Number(next())
    else if (k === '--concurrency') a.concurrency = Number(next())
    else if (k === '--build-only') a.buildOnly = true
    else throw new Error(`unknown option ${k}`)
  }
  return a
}

function readJSON(f) { return JSON.parse(readFileSync(f, 'utf8')) }
function maybeJSON(f) { return existsSync(f) ? readJSON(f) : null }
function writeJSON(f, v) { writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`) }
const secs = (t0) => Math.round((Date.now() - t0) / 100) / 10
const cost = (u) => round4(Number(u?.cost ?? 0))
const round4 = (x) => Math.round(x * 10000) / 10000
function log(msg) { console.log(`[extract] ${msg}`) }

// ---------- main ----------
async function main() {
  const runStart = new Date().toISOString()
  const allImages = readdirSync(RAW_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()
  let images = allImages
  if (args.only) images = images.filter((f) => args.only.includes(f))
  if (args.limit) images = images.slice(0, args.limit)
  log(`images: ${images.length}/${allImages.length} · extract=${EXTRACT_MODEL} · crosscheck=${CROSSCHECK_MODEL} · ${RIEL_PER_USD}៛/$`)

  if (!args.buildOnly) {
    images.forEach(prepareJpeg)

    await pool(images, args.concurrency, async (img) => {
      const out = join(CACHE.extract, `${img}.json`)
      if (existsSync(out) && !args.force) return
      const t0 = Date.now()
      try {
        const { json, usage, model } = await chatJSON({
          model: EXTRACT_MODEL,
          meta: { script: 'extract', stage: 'extract', image: img },
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: [{ type: 'text', text: extractUserPrompt(img) }, imagePart(jpegBase64(img))] },
          ],
        })
        validateExtraction(json, img)
        writeJSON(out, { image: img, model, extracted_at: new Date().toISOString(), seconds: secs(t0), usage, result: json })
        log(`✓ extract ${img}: ${json.items.length} items, ${json.restaurant?.name_en ?? '(no name)'} (${secs(t0)}s, $${cost(usage)})`)
      } catch (err) {
        log(`✗ extract ${img}: ${err.message}`)
      }
    })

    if (args.crosscheckRate > 0) {
      const extracted = images.filter((img) => existsSync(join(CACHE.extract, `${img}.json`)))
      const sample = sampleImages(extracted, args.crosscheckRate, args.seed)
      log(`cross-checking ${sample.length}/${extracted.length} images: ${sample.join(', ')}`)
      await pool(sample, args.concurrency, async (img) => {
        const out = join(CACHE.crosscheck, `${img}.json`)
        if (existsSync(out) && !args.forceCrosscheck) return
        const t0 = Date.now()
        try {
          const items = itemsForAudit(img)
          const { json, usage, model } = await chatJSON({
            model: CROSSCHECK_MODEL,
            meta: { script: 'extract', stage: 'crosscheck', image: img },
            messages: [
              { role: 'system', content: CROSSCHECK_SYSTEM },
              { role: 'user', content: [{ type: 'text', text: crosscheckUserPrompt(items) }, imagePart(jpegBase64(img))] },
            ],
          })
          writeJSON(out, { image: img, model, checked_at: new Date().toISOString(), seconds: secs(t0), usage, result: json })
          const bad = (json.items ?? []).filter((v) => !isAgree(v)).length
          log(`✓ crosscheck ${img}: ${bad}/${items.length} disputed, ${(json.missing_items ?? []).length} missing (${secs(t0)}s, $${cost(usage)})`)
        } catch (err) {
          log(`✗ crosscheck ${img}: ${err.message}`)
        }
      })
    }
  }

  build(allImages)
  summariseUsage(runStart)
}

await main()
