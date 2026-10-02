import type { Session } from '../lib/sessions.ts'

type Props = {
  sessions: Session[] // chats with messages, newest first
  activeId: string
  busy: boolean
  open: boolean // mobile drawer state
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

function when(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function SessionSidebar({ sessions, activeId, busy, open, onNew, onSelect, onDelete, onClose }: Props) {
  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Chats">
        <button className="new-chat" onClick={onNew} disabled={busy}>
          ＋ New chat
        </button>
        <div className="sidebar-title">Chats</div>
        {sessions.length === 0 && <div className="sidebar-empty">No chats yet. Ask something to start one.</div>}
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeId ? 'active' : ''}>
              <button className="session-item" onClick={() => onSelect(s.id)} disabled={busy} title={s.title}>
                <span className="session-title">{s.title}</span>
                <span className="session-time">{when(s.updatedAt)}</span>
              </button>
              <button
                className="session-delete"
                onClick={() => onDelete(s.id)}
                disabled={busy}
                aria-label={`Delete chat: ${s.title}`}
                title="Delete chat"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">Saved in this browser only.</div>
      </aside>
    </>
  )
}
