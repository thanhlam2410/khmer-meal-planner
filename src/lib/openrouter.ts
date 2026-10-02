// All model calls go to the same-origin /api/chat route:
//  - dev:  Vite proxy (vite.config.ts) adds the key from .env
//  - prod: here.now proxy route (public/.herenow/proxy.json) adds the key from an account variable
// The browser never sees the OpenRouter key.

import { derror, dlog } from './debug.ts'

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolSpec = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

// Injected at build time from AGENT_MODEL in .env (see vite.config.ts); not a secret.
export const CHAT_MODEL: string = import.meta.env.AGENT_MODEL || 'google/gemini-2.5-flash'

export async function chatCompletion(messages: ApiMessage[], tools?: ToolSpec[], toolChoice: 'auto' | 'none' = 'auto') {
  const body = {
    model: CHAT_MODEL,
    messages,
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
    temperature: 0.2,
    max_tokens: 4000, // headroom: the model spends some tokens on reasoning before answering
    reasoning: { effort: 'low' }, // keep the model's thinking in the separate `reasoning` field, not in the reply
  }
  dlog(`→ request (${messages.length} messages)`, body)
  const t0 = performance.now()
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => null)
  dlog(`← response ${res.status} in ${Math.round(performance.now() - t0)} ms`, data)
  if (!res.ok || !data?.choices) {
    const err = new Error(typeof data?.error?.message === 'string' ? data.error.message : `Request failed (${res.status})`)
    derror('chat request failed', { status: res.status, data })
    throw err
  }
  const msg = data.choices[0].message
  return {
    // reasoning_details is passed back on the next turn: Gemini 3 needs its "thought signatures"
    // returned with tool-call history, or the follow-up request fails.
    message: {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
      tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined,
      ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}),
    } as ApiMessage,
    reasoning: typeof msg.reasoning === 'string' && msg.reasoning.trim() ? (msg.reasoning as string) : null,
    usage: data.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined,
  }
}
