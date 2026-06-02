import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises'
import { resolve, extname, join, dirname } from 'node:path'
import { cwd } from 'node:process'
import type { ResolvedSpoonOptions } from './options.js'
import { overlayScript } from './overlay/script.js'
import { detectTailwind } from './tailwind.js'

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

      const { file, patches, label } = payload
      if (!file || !Array.isArray(patches)) return badRequest(res, 'invalid payload')

      const ext = extname(file)
      const allowed = ['.tsx', '.ts', '.jsx', '.js', '.css']
      if (!allowed.includes(ext)) return badRequest(res, 'file type not allowed')

      try {
        const abs = resolve(cwd(), file)
        const before = await readFile(abs, 'utf8')
        const after = applyPatches(before, patches)
        if (after === before) {
          json(res, { ok: true, noop: true })
          return
        }
        await writeFile(abs, after, 'utf8')

        // Record the change so it can be undone or audited
        const entry: HistoryEntry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          ts: Date.now(),
          file,
          label: label ?? summariseLabel(patches),
          patches,
          // Inverse patches let us replay the file back to its pre-edit state
          inverse: patches.map(invertPatch).reverse(),
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
          patches: [],
          inverse: [],
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

interface Patch {
  type: 'class-replace' | 'class-add' | 'class-remove' | 'text' | 'style-prop'
  /** 1-based line number in the source file */
  line: number
  column?: number
  /** For class patches: the old class string to find */
  oldValue?: string
  /** Replacement / new value */
  newValue: string
}

interface WritePayload {
  file: string
  patches: Patch[]
  /** Optional human label for the history entry, e.g. "Add bg-primary" */
  label?: string
}

interface HistoryEntry {
  id: string
  ts: number
  file: string
  label: string
  patches: Patch[]
  /** Patches that, when applied to the post-write file, restore the pre-write state */
  inverse: Patch[]
  /** True for entries that record a non-write event (checkpoints, comments) */
  marker?: boolean
}

// ── Patch logic ─────────────────────────────────────────────────────────

function applyPatches(src: string, patches: Patch[]): string {
  const lines = src.split('\n')

  for (const patch of patches) {
    const idx = patch.line - 1
    if (idx < 0 || idx >= lines.length) continue
    const line = lines[idx]

    if (patch.type === 'class-replace' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(patch.oldValue, patch.newValue)
    } else if (patch.type === 'class-add') {
      lines[idx] = line.replace(
        /(className=["'`])([^"'`]*)(["'`])/,
        (_, open, existing, close) => `${open}${existing} ${patch.newValue}`.trimStart() + close,
      )
    } else if (patch.type === 'class-remove' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(
        new RegExp(`\\b${escapeRe(patch.oldValue)}\\b\\s?`, 'g'),
        '',
      )
    } else if (patch.type === 'text') {
      lines[idx] = line.replace(patch.oldValue ?? />[^<]*</, `>${patch.newValue}<`)
    } else if (patch.type === 'style-prop' && patch.oldValue !== undefined) {
      lines[idx] = line.replace(patch.oldValue, patch.newValue)
    }
  }

  return lines.join('\n')
}

/** Compute the patch that undoes a given patch. */
function invertPatch(p: Patch): Patch {
  switch (p.type) {
    case 'class-replace':
    case 'style-prop':
    case 'text':
      return { ...p, oldValue: p.newValue, newValue: p.oldValue ?? '' }
    case 'class-add':
      return { type: 'class-remove', line: p.line, oldValue: p.newValue, newValue: '' }
    case 'class-remove':
      return { type: 'class-add', line: p.line, newValue: p.oldValue ?? '' }
    default:
      return p
  }
}

function summariseLabel(patches: Patch[]): string {
  if (patches.length === 0) return 'no-op'
  const p = patches[0]
  if (p.type === 'class-replace') return 'Replace classes'
  if (p.type === 'class-add') return `+ ${p.newValue}`
  if (p.type === 'class-remove') return `- ${p.oldValue ?? ''}`
  if (p.type === 'text') return 'Edit text'
  if (p.type === 'style-prop') return 'Edit style'
  return p.type
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

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function badRequest(res: ServerResponse, msg: string) {
  json(res, { error: msg }, 400)
}
