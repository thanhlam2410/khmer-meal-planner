import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isPlanResult, runAgent } from './agent/agent'
import { PlanCards } from './components/PlanCard'
import { QuickPlanner } from './components/QuickPlanner'
import { RichText } from './components/RichText'
import { SessionSidebar } from './components/SessionSidebar'
import { ThinkingPanel } from './components/ThinkingPanel'
import { derror, dlog } from './lib/debug'
import { loadMenus } from './lib/menuData'
import { CHAT_MODEL, type ApiMessage } from './lib/openrouter'
import { loadSessions, newSession, saveSessions, titleFrom, type Session, type Step } from './lib/sessions'
import type { PlanResult } from './optimizer/planMeal'
import type { MenuData } from './optimizer/types'

const EXAMPLES = [
  'I have a budget of $10. I want chicken, some vegetables, and a couple of beers. What should I order, and from where?',
  'I have $60 for a nice dinner for two. What do you recommend?',
  'Which restaurants serve beer?',
]

function initialSessions(): { sessions: Session[]; activeId: string } {
  const fresh = newSession() // always open on a clean chat; past chats are in the switcher
  return { sessions: [fresh, ...loadSessions()], activeId: fresh.id }
}

export default function App() {
  const [data, setData] = useState<MenuData | null>(null)
  const [{ sessions, activeId }, setState] = useState(initialSessions)
  const [input, setInput] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null) // session with a request in flight
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false) // sidebar on small screens
  const [quickOpen, setQuickOpen] = useState(false) // AI-free planner; opens itself if the AI fails
  const endRef = useRef<HTMLDivElement>(null)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const busy = pendingId !== null

  useEffect(() => {
    loadMenus().then(setData, (e) => setError(String(e.message ?? e)))
  }, [])
  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])
  // Block body on purpose: newer browsers return a Promise from scrollIntoView(), and React would
  // treat any returned value as the effect's cleanup and crash calling it ("l is not a function").
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.entries.length, status, activeId])

  const updateSession = (id: string, fn: (s: Session) => Session) =>
    setState((st) => ({ ...st, sessions: st.sessions.map((s) => (s.id === id ? fn(s) : s)) }))

  function startNewChat() {
    if (busy) return
    setDrawerOpen(false)
    setError(null)
    setInput('')
    setState((st) => {
      // Reuse the current chat if it's still empty instead of piling up blank ones.
      const current = st.sessions.find((s) => s.id === st.activeId)
      if (current && !current.entries.length) return st
      const fresh = newSession()
      return { sessions: [fresh, ...st.sessions], activeId: fresh.id }
    })
  }

  function switchTo(id: string) {
    if (busy) return
    setDrawerOpen(false)
    setError(null)
    setState((st) => ({ sessions: st.sessions.filter((s) => s.entries.length || s.id === id), activeId: id }))
  }

  function deleteSession(id: string) {
    if (busy || !confirm('Delete this chat?')) return
    setState((st) => {
      const rest = st.sessions.filter((s) => s.id !== id)
      if (id !== st.activeId) return { ...st, sessions: rest }
      const empty = rest.find((s) => !s.entries.length)
      const next = empty ?? newSession()
      return { sessions: empty ? rest : [next, ...rest], activeId: next.id }
    })
  }

  async function send(e?: FormEvent, preset?: string) {
    e?.preventDefault()
    const text = (preset ?? input).trim()
    if (!text || busy || !data) return
    const sessionId = active.id // the answer goes to the chat that asked, even if the user switches away
    const history = active.history
    const userMsg: ApiMessage = { role: 'user', content: text }
    updateSession(sessionId, (s) => ({
      ...s,
      title: s.entries.length ? s.title : titleFrom(text),
      updatedAt: Date.now(),
      entries: [...s.entries, { role: 'user', text }],
    }))
    setInput('')
    setError(null)
    setPendingId(sessionId)
    setStatus('Thinking…')
    const plans: PlanResult[] = []
    const steps: Step[] = []
    try {
      const added = await runAgent(data, [...history, userMsg], (step) => {
        if (step.kind !== 'usage') steps.push(step)
        if (step.kind === 'tool') {
          setStatus(step.name === 'plan_meal' ? 'Comparing menus…' : 'Searching menus…')
          if (step.name === 'plan_meal' && isPlanResult(step.result)) plans.push(step.result)
        }
      })
      dlog('turn finished', { sessionId, added, plans, steps })
      // The answer is the final assistant message (the one without tool calls); earlier text is thinking.
      const final = [...added].reverse().find((m) => m.role === 'assistant' && !m.tool_calls?.length)
      updateSession(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        history: [...s.history, userMsg, ...added],
        entries: [...s.entries, { role: 'assistant', text: (final?.role === 'assistant' && final.content) || '', plans, steps }],
      }))
    } catch (err) {
      // The failed question stays visible but isn't added to the model history.
      derror('send failed', err)
      setError(err instanceof Error ? err.message : String(err))
      setQuickOpen(true) // fallback: the same optimizer without the AI
    } finally {
      setPendingId(null)
      setStatus(null)
    }
  }

  const past = sessions.filter((s) => s.entries.length).sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="shell">
      <SessionSidebar
        sessions={past}
        activeId={active.id}
        busy={busy}
        open={drawerOpen}
        onNew={startNewChat}
        onSelect={switchTo}
        onDelete={deleteSession}
        onClose={() => setDrawerOpen(false)}
      />
    <div className="app">
      <header>
        <div className="header-row">
          <button className="icon-btn menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Show chats">
            ☰
          </button>
          <h1>Khmer Menu Planner</h1>
        </div>
        <p>
          Tell me your budget and what you feel like eating.
          {data && ` ${data.meta.restaurants} restaurants · ${data.meta.items} dishes from Khmer menus.`}
        </p>
      </header>

      <QuickPlanner
        data={data}
        open={quickOpen}
        onToggle={setQuickOpen}
        reason={error ? 'The AI assistant is unavailable right now — you can still plan with this form.' : null}
      />

      <main className="log">
        {active.entries.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="example" disabled={!data || busy} onClick={() => send(undefined, ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {active.entries.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg user">{m.text}</div>
          ) : (
            <div key={i} className="msg assistant">
              <ThinkingPanel steps={m.steps ?? []} />
              {m.plans.length > 0 && <PlanCards result={m.plans[m.plans.length - 1]} />}
              {m.text && <RichText text={m.text} />}
            </div>
          ),
        )}
        {status && pendingId === active.id && <div className="msg assistant pending">{status}</div>}
        {error && <div className="error">⚠️ {error}</div>}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={send}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e)
          }}
          placeholder="e.g. $10, chicken, vegetables, 2 beers"
          rows={2}
        />
        <button type="submit" disabled={busy || !input.trim() || !data}>Send</button>
      </form>
      <footer>
        Prices read by AI from menu photos (~2024), converted at 4,000៛ = $1 — may differ in person. Chats are saved in this browser only. Model: {CHAT_MODEL} via OpenRouter.
      </footer>
    </div>
    </div>
  )
}
