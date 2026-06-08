import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises'
import { resolve, extname, join, dirname } from 'node:path'
import { cwd } from 'node:process'
import type { ResolvedSpoonOptions } from './options.js'
import { overlayScript } from './overlay/script.js'
import { detectTailwind } from './tailwind.js'
import { applyEditAtLocation, type EditOp } from './writeback.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

const SPOON_DIR = '.spoon'
const HISTORY_FILE = 'history.jsonl'
const MAX_HISTORY_RETURNED = 200

export function createMiddleware(opts: ResolvedSpoonOptions): Handler {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace('/__spoon', '') || '/'

    if (path === '/overlay.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      res.end(overlayScript(opts))
      return
    }

    if (path === '/read' && req.method === 'GET') {
      const file = url.searchParams.get('file')
      if (!file) return badRequest(res, 'missing file param')
      try {
        const abs = resolve(cwd(), file)
        const src = await readFile(abs, 'utf8')
        const lines = src.split('\n')
        const fromParam = url.searchParams.get('from')
        const toParam = url.searchParams.get('to')
        if (fromParam || toParam) {
          const from = Math.max(1, Number(fromParam) || 1)
          const to = Math.min(lines.length, Number(toParam) || lines.length)
          json(res, { lines: lines.slice(from - 1, to), from, to, totalLines: lines.length })
        } else {
          const line = Number(url.searchParams.get('line'))
          json(res, { line: lines[line - 1] ?? '', totalLines: lines.length })
        }
      } catch (e) {
        json(res, { error: String(e) }, 500)
      }
      return
    }

    if (path === '/write' && req.method === 'POST') {
      const body = await readBody(req)
      let payload: WritePayload
      try {
        payload = JSON.parse(body)
      } catch {
        return badRequest(res, 'invalid JSON')
      }

      const { file, loc, op, label } = payload
      if (!file || !loc || !op) return badRequest(res, 'invalid payload')

      const ext = extname(file)
      const allowed = ['.tsx', '.ts', '.jsx', '.js']
      if (!allowed.includes(ext)) return badRequest(res, 'file type not allowed')

      try {
        const abs = resolve(cwd(), file)
        const before = await readFile(abs, 'utf8')
        const result = applyEditAtLocation(before, loc.line, loc.column, op)
        if (!result.ok) {
          json(res, { error: result.error ?? 'edit failed' }, 422)
          return
        }
        const after = result.code ?? before
        if (after === before) {
          json(res, { ok: true, noop: true })
          return
        }
        await writeFile(abs, after, 'utf8')

        // Build the inverse op so this change can be undone/restored.
        const inverse: EditOp = {}
        if (op.className !== undefined) inverse.className = result.prevClassName ?? ''
        if (op.text !== undefined) inverse.text = result.prevText ?? ''
        if (op.style !== undefined) {
          inverse.style = { prop: op.style.prop, value: result.prevStyle?.value ?? '' }
        }

        const entry: HistoryEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          ts: Date.now(),
          file,
          loc,
          op,
          inverse,
          label: label ?? summariseLabel(op),
        }
        await appendHistory(entry)
        json(res, { ok: true, entry })
      } catch (e) {
        json(res, { error: String(e) }, 500)
      }
      return
    }

    if (path === '/tokens' && req.method === 'GET') {
      const tokens = await detectTailwind(opts)
      json(res, tokens)
      return
    }

    // History: list recent entries
    if (path === '/history' && req.method === 'GET') {
      try {
        const entries = await readHistory()
        json(res, { entries: entries.slice(-MAX_HISTORY_RETURNED).reverse() })
      } catch (e) {
        json(res, { entries: [], error: String(e) })
      }
      return
    }

    // History: append a non-write marker (e.g. checkpoint, comment)
    if (path === '/history' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const entry = JSON.parse(body) as Partial<HistoryEntry>
        const full: HistoryEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          ts: Date.now(),
          file: entry.file ?? '',
          label: entry.label ?? 'marker',
          marker: true,
        }
        await appendHistory(full)
        json(res, { ok: true, entry: full })
      } catch {
        badRequest(res, 'invalid JSON')
      }
      return
    }

    res.writeHead(404)
    res.end()
  }
}

// ── Types ───────────────────────────────────────────────────────────────

interface SourceLoc {
  /** 1-based line as reported by Babel */
  line: number
  /** 0-based column as reported by Babel */
  column: number
}

interface WritePayload {
  file: string
  loc: SourceLoc
  op: EditOp
  /** Optional human label for the history entry, e.g. "Add bg-primary" */
  label?: string
}

interface HistoryEntry {
  id: string
  ts: number
  file: string
  loc?: SourceLoc
  op?: EditOp
  /** The op that restores the pre-write state */
  inverse?: EditOp
  label: string
  /** True for entries that record a non-write event (checkpoints, comments) */
  marker?: boolean
}

function summariseLabel(op: EditOp): string {
  const parts: string[] = []
  if (op.className !== undefined) parts.push('classes')
  if (op.text !== undefined) parts.push('text')
  if (op.style !== undefined) parts.push('style.' + op.style.prop)
  return parts.length ? 'Edit ' + parts.join(' + ') : 'edit'
}

// ── History persistence ─────────────────────────────────────────────────

async function appendHistory(entry: HistoryEntry) {
  const dir = resolve(cwd(), SPOON_DIR)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, HISTORY_FILE), JSON.stringify(entry) + '\n', 'utf8')
}

async function readHistory(): Promise<HistoryEntry[]> {
  const file = resolve(cwd(), SPOON_DIR, HISTORY_FILE)
  try {
    await stat(file)
  } catch {
    return []
  }
  const raw = await readFile(file, 'utf8')
  const out: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip corrupted line
    }
  }
  return out
}

// ── Helpers ────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function badRequest(res: ServerResponse, msg: string) {
  json(res, { error: msg }, 400)
}
