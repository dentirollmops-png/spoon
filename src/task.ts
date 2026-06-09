import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import type { ServerResponse } from 'node:http'

export interface TaskRequest {
  /** Natural-language instruction from the user */
  instruction: string
  /** Source file the selected element lives in (relative path) */
  file: string
  /** 1-based line of the element's opening tag */
  line: number
  /** Outer HTML of the selected element, for context */
  html?: string
  /** The element's source location string "file:line:col" */
  loc?: string
  /** Model alias: 'sonnet' | 'opus' | 'haiku' */
  model?: string
}

/**
 * Build the prompt handed to `claude -p`. We point Claude precisely at the
 * element via @file reference + line, include the rendered HTML for grounding,
 * and constrain the scope so it edits surgically.
 */
function buildPrompt(req: TaskRequest): string {
  const lines: string[] = []
  lines.push(
    'You are editing a single UI element in a Vite + React + Tailwind project, on behalf of a visual editor (vite-plugin-spoon). The user clicked an element in the browser and gave an instruction.',
  )
  lines.push('')
  lines.push(`Target file: @${req.file}`)
  lines.push(`The element's opening tag is around line ${req.line}.`)
  if (req.loc) lines.push(`Spoon location id: ${req.loc}`)
  if (req.html) {
    lines.push('')
    lines.push('Rendered element (for identification only):')
    lines.push('```html')
    lines.push(req.html.slice(0, 1500))
    lines.push('```')
  }
  lines.push('')
  lines.push('User instruction:')
  lines.push(`"""${req.instruction}"""`)
  lines.push('')
  lines.push('Rules:')
  lines.push('- Make the smallest change that satisfies the instruction.')
  lines.push('- Prefer editing this element and its styles; do not refactor unrelated code.')
  lines.push('- Preserve existing dynamic logic (ternaries, props) unless the instruction is explicitly about changing it.')
  lines.push('- If the color/style lives in a CSS file or a token, edit it there.')
  lines.push('- After editing, briefly state what you changed in one sentence.')
  return lines.join('\n')
}

/**
 * Run a Claude task and stream its output to the client as Server-Sent Events.
 * Each event is one JSON line from claude's stream-json output, re-emitted as
 * an SSE `data:` frame so the browser can render progress live.
 */
export function runTask(req: TaskRequest, res: ServerResponse): void {
  const prompt = buildPrompt(req)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy/middleware buffering so frames reach the browser live.
    'X-Accel-Buffering': 'no',
  })
  // Flush headers immediately so the browser opens the stream right away.
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
    // Force a flush if the platform buffers writes.
    if (typeof (res as any).flush === 'function') (res as any).flush()
  }

  // acceptEdits lets Claude apply file edits without interactive prompts, but
  // it still can't run arbitrary destructive shell unless we allow it.
  // One JSON object per message (system init, each assistant turn, tool
  // results, final result). We render each as it arrives — no need for
  // --include-partial-messages (char-by-char deltas), which only adds noise.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ]
  if (req.model) args.push('--model', req.model)

  // The dev server may itself have been started from inside a Claude Code
  // session (very common during development), which sets CLAUDECODE et al.
  // The CLI refuses to launch nested sessions, so strip those markers.
  const childEnv = { ...process.env }
  delete childEnv.CLAUDECODE
  delete childEnv.CLAUDE_CODE_SSE_PORT
  delete childEnv.CLAUDE_CODE_ENTRYPOINT

  // Binary is overridable for testing / non-standard installs.
  const bin = process.env.SPOON_CLAUDE_BIN || 'claude'

  let child
  try {
    child = spawn(bin, args, {
      cwd: cwd(),
      env: childEnv,
      // CRITICAL: stdin must be closed. With an open (inherited/pipe) stdin,
      // the claude CLI blocks waiting for input/EOF and never starts working —
      // it just sits there emitting nothing. 'ignore' gives it /dev/null so it
      // sees no stdin and proceeds immediately. (stdout/stderr stay piped.)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    send('error', { message: 'Failed to start claude: ' + String(e) })
    res.end()
    return
  }

  send('start', { pid: child.pid, file: req.file })

  // Safety net: if claude produces nothing for too long, surface it instead of
  // hanging forever. (Generous — large repos can take a while to load.)
  const STALL_MS = 90_000
  let lastOutput = Date.now()
  const stallCheck = setInterval(() => {
    if (Date.now() - lastOutput > STALL_MS) {
      send('error', { message: 'No output for 90s — claude may be stuck. Stopping.' })
      clearInterval(stallCheck)
      if (!child.killed) child.kill('SIGTERM')
    }
  }, 5000)
  const bump = () => { lastOutput = Date.now() }

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    bump()
    buffer += chunk.toString()
    // stream-json emits one JSON object per line
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        send('message', JSON.parse(trimmed))
      } catch {
        send('raw', { text: trimmed })
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    bump()
    send('stderr', { text: chunk.toString() })
  })

  child.on('close', (code) => {
    clearInterval(stallCheck)
    if (buffer.trim()) {
      try {
        send('message', JSON.parse(buffer.trim()))
      } catch {
        send('raw', { text: buffer.trim() })
      }
    }
    send('done', { code })
    res.end()
  })

  child.on('error', (err) => {
    clearInterval(stallCheck)
    send('error', { message: String(err) })
    res.end()
  })

  // If the client disconnects, kill the child so we don't leak processes.
  res.on('close', () => {
    clearInterval(stallCheck)
    if (!child.killed) child.kill('SIGTERM')
  })
}

/**
 * Create a lightweight git checkpoint before a task runs, so the user can
 * revert the whole task in one click. Returns a label or null if git is
 * unavailable / not a repo.
 */
export async function createCheckpoint(label: string): Promise<{ ok: boolean; ref?: string; error?: string }> {
  return new Promise((resolvePromise) => {
    // Use `git stash create` to snapshot WITHOUT touching the working tree —
    // it returns a commit sha we can later `git stash apply` or diff against.
    const child = spawn('git', ['stash', 'create', label], { cwd: cwd() })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (err += c.toString()))
    child.on('close', (code) => {
      if (code === 0) {
        const ref = out.trim()
        // Empty output means there was nothing to snapshot (clean tree)
        resolvePromise({ ok: true, ref: ref || undefined })
      } else {
        resolvePromise({ ok: false, error: err || 'git stash create failed' })
      }
    })
    child.on('error', (e) => resolvePromise({ ok: false, error: String(e) }))
  })
}

/**
 * Restore a checkpoint captured by createCheckpoint. `git stash apply <sha>`
 * re-applies the snapshotted working-tree state without dropping anything.
 */
export async function restoreCheckpoint(ref: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['stash', 'apply', ref], { cwd: cwd() })
    let err = ''
    child.stderr.on('data', (c) => (err += c.toString()))
    child.on('close', (code) => {
      resolvePromise(code === 0 ? { ok: true } : { ok: false, error: err || 'git stash apply failed' })
    })
    child.on('error', (e) => resolvePromise({ ok: false, error: String(e) }))
  })
}

// Keep resolve import used (path safety for future file validation)
void resolve
