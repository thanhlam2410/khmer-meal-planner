// Debug logging for the agent loop. On in `npm run dev`, in `npm run build:debug`, or with ?debug in the URL.

const fromUrl = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
export const DEBUG = import.meta.env.DEV || import.meta.env.MODE === 'debug' || fromUrl

const STYLE = 'color:#b5452a;font-weight:bold'

export function dlog(label: string, ...data: unknown[]) {
  if (!DEBUG) return
  console.groupCollapsed(`%c[agent] ${label}`, STYLE)
  for (const d of data) console.log(d)
  console.groupEnd()
}

export function derror(label: string, err: unknown) {
  // Errors are always logged, debug or not.
  console.error(`[agent] ${label}`, err)
}

if (DEBUG) console.info('%c[agent] debug logging on', STYLE, { mode: import.meta.env.MODE })
