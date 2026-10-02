// Minimal OpenRouter client for offline scripts (Node 24, no deps).
// Reads OPENROUTER_API_KEY from the environment: run with `node --env-file=.env`.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

// Every model call (including failed attempts) is appended here as one JSON line.
export const USAGE_LOG = 'logs/llm-usage.jsonl'

export function logUsage(entry) {
  mkdirSync(dirname(USAGE_LOG), { recursive: true })
  appendFileSync(USAGE_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
}

// `meta` (e.g. { script, stage, image }) is copied into the usage log line.
export async function chatJSON({ model, messages, maxTokens = 32000, retries = 2, temperature = 0, meta = {} }) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY missing — run with: node --env-file=.env ...')

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now()
    let data = null
    let status = null
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'khmer-menus extraction',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
      })
      status = res.status
      data = await res.json().catch(() => null)
      if (!res.ok || !data?.choices?.length) {
        throw new Error(`OpenRouter ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`)
      }
      const text = data.choices[0].message?.content ?? ''
      const json = parseJSONLoose(text)
      logUsage(usageEntry({ meta, model, data, status, t0, attempt, ok: true }))
      return { json, usage: data.usage ?? {}, model: data.model ?? model }
    } catch (err) {
      lastErr = err
      logUsage(usageEntry({ meta, model, data, status, t0, attempt, ok: false, error: err.message }))
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw lastErr
}

function usageEntry({ meta, model, data, status, t0, attempt, ok, error }) {
  const u = data?.usage ?? {}
  return {
    ...meta,
    model_requested: model,
    model: data?.model ?? null,
    provider: data?.provider ?? null,
    generation_id: data?.id ?? null,
    ok,
    http_status: status,
    attempt: attempt + 1,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null,
    cost_usd: u.cost ?? null,
    finish_reason: data?.choices?.[0]?.finish_reason ?? null,
    ...(error ? { error: error.slice(0, 300) } : {}),
  }
}

// Models sometimes wrap JSON in ``` fences or add a sentence; take the outermost object.
export function parseJSONLoose(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`)
  }
}

export const imagePart = (base64Jpeg) => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` },
})
