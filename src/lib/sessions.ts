// Chat sessions, saved per browser in localStorage. Each session has its own model history, so a
// new chat never sees earlier conversations.

import type { AgentStep } from '../agent/agent.ts'
import type { PlanResult } from '../optimizer/planMeal.ts'
import type { ApiMessage } from './openrouter.ts'

export type Step = Exclude<AgentStep, { kind: 'usage' }>
export type Entry = { role: 'user'; text: string } | { role: 'assistant'; text: string; plans: PlanResult[]; steps: Step[] }

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  history: ApiMessage[] // sent to the model
  entries: Entry[] // shown in the chat log
}

const KEY = 'khmer-menus.sessions.v1'
const MAX_SESSIONS = 20

export function newSession(): Session {
  const now = Date.now()
  return { id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title: 'New chat', createdAt: now, updatedAt: now, history: [], entries: [] }
}

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as Session[]) : []
    return Array.isArray(list) ? list.filter((s) => s && s.id && Array.isArray(s.entries)) : []
  } catch {
    return [] // storage blocked or corrupt: start fresh, the app still works
  }
}

export function saveSessions(sessions: Session[]) {
  try {
    // Keep only sessions with messages, newest first.
    const keep = sessions.filter((s) => s.entries.length).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
    localStorage.setItem(KEY, JSON.stringify(keep))
  } catch {
    // storage full or blocked: sessions just won't persist across reloads
  }
}

export const titleFrom = (text: string) => (text.length > 48 ? `${text.slice(0, 45).trimEnd()}…` : text)
