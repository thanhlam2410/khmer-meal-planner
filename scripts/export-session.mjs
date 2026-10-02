#!/usr/bin/env node
// Export a Claude Code session transcript (.jsonl) to a readable Markdown file.
//
// Usage:
//   node scripts/export-session.mjs <session.jsonl> <out.md> [--title "Session 01"]
//
// Keeps: user messages (incl. ones sent mid-turn), assistant replies, tool calls
// (collapsed, with a short result preview). Drops: hidden reasoning, system
// reminders, IDE/attachment noise. Redacts API keys.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [, , inPath, outPath, ...rest] = process.argv
if (!inPath || !outPath) {
  console.error('usage: node scripts/export-session.mjs <session.jsonl> <out.md> [--title "..."]')
  process.exit(1)
}
const titleIdx = rest.indexOf('--title')
const title = titleIdx >= 0 ? rest[titleIdx + 1] : 'AI working session'

const PREVIEW_CHARS = 600

const redact = (s) =>
  s
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, 'sk-or-v1-[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
    .replace(/hnk_[A-Za-z0-9]+/g, 'hnk_[REDACTED]')

const cleanUserText = (s) =>
  s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, '$1')
    .trim()

const fence = (body, lang = '') => {
  const ticks = body.includes('```') ? '````' : '```'
  return `${ticks}${lang}\n${body}\n${ticks}`
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [truncated ${s.length - n} chars]` : s)

const resultText = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[${b.type}]`))
    .join('\n')
}

const describeTool = (name, input = {}) => {
  switch (name) {
    case 'Bash':
      return { label: input.description || 'Run command', body: fence(input.command ?? '', 'bash') }
    case 'Read':
      return { label: `Read \`${input.file_path}\``, body: '' }
    case 'Write':
      return { label: `Write \`${input.file_path}\``, body: fence(truncate(input.content ?? '', 3000)) }
    case 'Edit':
      return { label: `Edit \`${input.file_path}\``, body: fence(truncate(`- ${input.old_string}\n+ ${input.new_string}`, 2000), 'diff') }
    case 'WebSearch':
      return { label: `Web search: "${input.query}"`, body: '' }
    case 'WebFetch':
      return { label: `Fetch ${input.url}`, body: input.prompt ? `> ${input.prompt}` : '' }
    default:
      return { label: name, body: fence(truncate(JSON.stringify(input, null, 2), 1500), 'json') }
  }
}

const lines = readFileSync(inPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const out = []
const pendingTools = new Map() // tool_use_id -> index in out[]
let firstTs, lastTs
let turn = 0

const pushUser = (text, ts, midTurn = false) => {
  const t = cleanUserText(text)
  if (!t || t.startsWith('[Image:')) return
  turn += 1
  const when = ts ? ` · ${new Date(ts).toISOString().slice(11, 16)} UTC` : ''
  out.push(`\n---\n\n## 🧑 User${midTurn ? ' (sent mid-turn)' : ''} — turn ${turn}${when}\n\n${t}\n`)
}

for (const d of lines) {
  if (d.timestamp) {
    firstTs ??= d.timestamp
    lastTs = d.timestamp
  }
  if (d.isSidechain) continue

  if (d.type === 'attachment' && d.attachment?.type === 'queued_command') {
    const p = d.attachment.prompt
    const text = Array.isArray(p) ? p.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(p ?? '')
    pushUser(text, d.attachment.timestamp ?? d.timestamp, true)
    continue
  }

  if (d.type === 'user') {
    const c = d.message?.content
    if (typeof c === 'string') {
      pushUser(c, d.timestamp)
      continue
    }
    const texts = []
    for (const b of c ?? []) {
      if (b.type === 'text') texts.push(b.text)
      if (b.type === 'tool_result') {
        const idx = pendingTools.get(b.tool_use_id)
        if (idx !== undefined) {
          const r = resultText(b.content).trim()
          const status = b.is_error ? '❌ error' : '✅'
          out[idx] = out[idx].replace(
            '%%RESULT%%',
            r ? `\n**Result** ${status}\n\n${fence(truncate(r, PREVIEW_CHARS))}\n` : `\n**Result** ${status}\n`,
          )
        }
      }
    }
    if (texts.length) pushUser(texts.join('\n'), d.timestamp)
    continue
  }

  if (d.type === 'assistant') {
    for (const b of d.message?.content ?? []) {
      if (b.type === 'text' && b.text.trim()) {
        out.push(`\n### 🤖 Claude\n\n${b.text.trim()}\n`)
      } else if (b.type === 'tool_use') {
        const { label, body } = describeTool(b.name, b.input)
        out.push(`\n<details><summary>🔧 <b>${b.name}</b> — ${label.replace(/</g, '&lt;')}</summary>\n\n${body}\n%%RESULT%%\n</details>\n`)
        pendingTools.set(b.id, out.length - 1)
      }
    }
  }
}

const body = out.map((s) => s.replace('%%RESULT%%', '')).join('')
const header = [
  `# ${title}`,
  '',
  `- **Project:** khmer-menus (Khmer Menu Intelligence Challenge)`,
  `- **Session file:** \`${inPath.split('/').pop()}\``,
  `- **Started:** ${firstTs ?? 'n/a'}`,
  `- **Last activity:** ${lastTs ?? 'n/a'}`,
  `- **User turns:** ${turn}`,
  '',
  '> Exported from the Claude Code transcript. Hidden reasoning and system messages are omitted;',
  '> tool calls are collapsed (click to expand) with truncated results. API keys are redacted.',
  '',
].join('\n')

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, redact(header + body))
console.log(`wrote ${outPath} (${turn} user turns)`)
