import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse

export interface EditOp {
  /** Set/replace the className string literal. */
  className?: string
  /** Set/replace the single text child of the element. */
  text?: string
  /**
   * Set/replace a single inline style property, e.g. { prop: 'background',
   * value: '#fff' }. value:'' removes the property. Only works on static
   * object-literal style props (style={{ ... }}); dynamic expressions are
   * rejected with a helpful error.
   */
  style?: { prop: string; value: string }
}

export interface WriteResult {
  ok: boolean
  code?: string
  error?: string
  /** What the className was before, so the caller can build an inverse op. */
  prevClassName?: string
  prevText?: string
  /** Previous value of the edited style prop (for inverse ops). */
  prevStyle?: { prop: string; value: string }
}

/**
 * Apply an edit to the JSX element at the given 0-based opening-tag
 * position. Works directly on the AST node ranges and splices the
 * original source by character offset, so all other formatting is
 * preserved and multi-line elements work correctly.
 */
export function applyEditAtLocation(
  source: string,
  line: number,
  column: number,
  op: EditOp,
): WriteResult {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
  } catch (e) {
    return { ok: false, error: 'parse error: ' + String(e) }
  }

  let openingNode: t.JSXOpeningElement | null = null
  let elementNode: t.JSXElement | null = null

  traverse(ast, {
    JSXOpeningElement(path) {
      const loc = path.node.loc
      if (!loc) return
      // data-spoon-loc carries 0-based column from Babel; match exactly
      if (loc.start.line === line && loc.start.column === column) {
        openingNode = path.node
        if (path.parentPath.isJSXElement()) {
          elementNode = path.parentPath.node
        }
        path.stop()
      }
    },
  })

  if (!openingNode) {
    return { ok: false, error: `no JSX element at ${line}:${column}` }
  }

  // Collect edits as {start, end, replacement} then apply right-to-left
  // so earlier offsets stay valid.
  const edits: { start: number; end: number; replacement: string }[] = []
  let prevClassName: string | undefined
  let prevText: string | undefined
  let prevStyle: { prop: string; value: string } | undefined

  if (op.className !== undefined) {
    const r = classNameEdit(openingNode, op.className)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevClassName = r.prev
  }

  if (op.text !== undefined && elementNode) {
    const r = textEdit(elementNode, op.text)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevText = r.prev
  }

  if (op.style !== undefined) {
    const r = styleEdit(openingNode, op.style.prop, op.style.value)
    if (r.error) return { ok: false, error: r.error }
    if (r.edit) edits.push(r.edit)
    prevStyle = { prop: op.style.prop, value: r.prev ?? '' }
  }

  if (edits.length === 0) {
    return { ok: true, code: source, prevClassName, prevText, prevStyle }
  }

  edits.sort((a, b) => b.start - a.start)
  let code = source
  for (const e of edits) {
    code = code.slice(0, e.start) + e.replacement + code.slice(e.end)
  }

  return { ok: true, code, prevClassName, prevText, prevStyle }
}

/**
 * Edit a single property inside a static style={{ ... }} object literal.
 * Handles three cases: property exists (replace its value), property absent
 * (insert it), or no style prop at all (add style={{ prop: 'value' }}).
 * Dynamic style values (style={expr} or a conditional property value) are
 * rejected — we won't guess what a ternary should become.
 */
function styleEdit(
  opening: t.JSXOpeningElement,
  prop: string,
  value: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
  )

  // No style prop yet — add style={{ prop: "value" }} after the tag name.
  if (!attr) {
    if (value === '') return { prev: '' }
    const nameEnd = opening.name.end
    if (nameEnd == null) return { error: 'cannot locate tag name end' }
    return {
      edit: { start: nameEnd, end: nameEnd, replacement: ` style={{ ${camel}: ${JSON.stringify(value)} }}` },
      prev: '',
    }
  }

  // style must be style={{ ...objectLiteral }}
  if (!t.isJSXExpressionContainer(attr.value) || !t.isObjectExpression(attr.value.expression)) {
    return { error: 'style is not a static object literal — edit it in source' }
  }
  const obj = attr.value.expression

  // Find the matching property (by camelCase identifier or string key)
  const existing = obj.properties.find((p): p is t.ObjectProperty => {
    if (!t.isObjectProperty(p)) return false
    if (t.isIdentifier(p.key)) return p.key.name === camel
    if (t.isStringLiteral(p.key)) return p.key.value === prop || p.key.value === camel
    return false
  })

  if (existing) {
    const v = existing.value
    if (t.isStringLiteral(v)) {
      if (v.start == null || v.end == null) return { error: 'no range on style value' }
      return { edit: { start: v.start, end: v.end, replacement: JSON.stringify(value) }, prev: v.value }
    }
    // Dynamic value (ternary, template, member) — don't clobber app logic.
    return { error: `${prop} is set by a dynamic expression — edit it in source` }
  }

  // Property not present — insert it at the start of the object.
  if (value === '') return { prev: '' }
  if (obj.start == null) return { error: 'no range on style object' }
  const insertAt = obj.start + 1 // just after the opening {
  return {
    edit: { start: insertAt, end: insertAt, replacement: ` ${camel}: ${JSON.stringify(value)},` },
    prev: '',
  }
}

function classNameEdit(
  opening: t.JSXOpeningElement,
  next: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute =>
      t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'className',
  )

  // No className attribute yet — insert one right after the tag name.
  if (!attr) {
    if (next.trim() === '') return { prev: '' }
    const nameEnd = opening.name.end
    if (nameEnd == null) return { error: 'cannot locate tag name end' }
    return {
      edit: { start: nameEnd, end: nameEnd, replacement: ` className="${next}"` },
      prev: '',
    }
  }

  const value = attr.value

  // className="..."
  if (t.isStringLiteral(value)) {
    if (value.start == null || value.end == null) return { error: 'no range on string' }
    return {
      edit: { start: value.start, end: value.end, replacement: JSON.stringify(next) },
      prev: value.value,
    }
  }

  // className={"..."} or className={`...`} (simple cases)
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression
    if (t.isStringLiteral(expr)) {
      if (expr.start == null || expr.end == null) return { error: 'no range on expr string' }
      return {
        edit: { start: expr.start, end: expr.end, replacement: JSON.stringify(next) },
        prev: expr.value,
      }
    }
    if (t.isTemplateLiteral(expr) && expr.quasis.length === 1) {
      const q = expr.quasis[0]
      if (q.start == null || q.end == null) return { error: 'no range on template' }
      return {
        edit: { start: q.start, end: q.end, replacement: '`' + next + '`' },
        prev: q.value.cooked ?? q.value.raw,
      }
    }
    // Dynamic className (cn(), conditionals, etc.) — too risky to rewrite blindly
    return { error: 'dynamic className expression — edit it in the Raw tab or source' }
  }

  return { error: 'unsupported className form' }
}

function textEdit(
  element: t.JSXElement,
  next: string,
): { edit?: { start: number; end: number; replacement: string }; prev?: string; error?: string } {
  // Find JSXText children (ignore whitespace-only ones).
  const textChildren = element.children.filter(
    (c): c is t.JSXText => t.isJSXText(c) && c.value.trim() !== '',
  )

  if (textChildren.length === 1) {
    const node = textChildren[0]
    if (node.start == null || node.end == null) return { error: 'no range on text' }
    // Preserve surrounding whitespace of the original JSXText token.
    const raw = node.value
    const leading = raw.match(/^\s*/)?.[0] ?? ''
    const trailing = raw.match(/\s*$/)?.[0] ?? ''
    return {
      edit: { start: node.start, end: node.end, replacement: leading + next + trailing },
      prev: raw.trim(),
    }
  }

  if (textChildren.length === 0) {
    return { error: 'no editable text child (it may be a {variable} or nested element)' }
  }

  return { error: 'multiple text children — edit in source' }
}
