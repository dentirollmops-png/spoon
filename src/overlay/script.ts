import type { ResolvedSpoonOptions } from '../options.js'

/**
 * Returns the self-contained browser JS that powers the spoon overlay.
 * Injected as an inline <script type="module"> by transformIndexHtml.
 */
export function overlayScript(opts: ResolvedSpoonOptions): string {
  return `
// vite-plugin-spoon overlay — injected in dev mode only
;(function spoonOverlay() {
  const HOTKEY = ${JSON.stringify(opts.hotkey)};
  const API = '/__spoon';

  let active = false;
  let hovered = null;
  let panel = null;
  let tokens = null;

  // ── Activation ──────────────────────────────────────────────────────────────

  // Parse the configured hotkey into { alt, ctrl, shift, meta, code } once.
  // We match on e.code (physical key) so macOS' Alt-character substitution
  // (Alt+S → "ß") doesn't break detection.
  const hk = parseHotkey(HOTKEY);

  document.addEventListener('keydown', (e) => {
    if (active && e.key === 'Escape') { deactivate(); return; }
    if (
      !!e.altKey === hk.alt &&
      !!e.ctrlKey === hk.ctrl &&
      !!e.shiftKey === hk.shift &&
      !!e.metaKey === hk.meta &&
      e.code === hk.code
    ) {
      e.preventDefault();
      active ? deactivate() : activate();
    }
  });

  function parseHotkey(str) {
    const parts = str.split('+').map((p) => p.trim());
    const mods = { alt: false, ctrl: false, shift: false, meta: false, code: 'KeyS' };
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === 'alt' || low === 'option') mods.alt = true;
      else if (low === 'ctrl' || low === 'control') mods.ctrl = true;
      else if (low === 'shift') mods.shift = true;
      else if (low === 'meta' || low === 'cmd' || low === 'command') mods.meta = true;
      else if (/^[a-z]$/i.test(p)) mods.code = 'Key' + p.toUpperCase();
      else if (/^[0-9]$/.test(p)) mods.code = 'Digit' + p;
      else mods.code = p; // already a KeyboardEvent.code like 'Slash'
    }
    return mods;
  }

  function activate() {
    active = true;
    document.body.style.cursor = 'crosshair';
    showToolbar();
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    fetch(API + '/tokens').then(r => r.json()).then(t => { tokens = t; });
  }

  function deactivate() {
    active = false;
    document.body.style.cursor = '';
    clearHighlight();
    hidePanel();
    hideToolbar();
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
  }

  // ── Hover highlight ──────────────────────────────────────────────────────────

  let highlightEl = null;
  function onHover(e) {
    if (e.target === highlightEl) return;
    clearHighlight();
    const el = e.target;
    if (!el.dataset || !el.dataset.spoonLoc) return;
    hovered = el;
    highlightEl = el;
    el._spoonOldOutline = el.style.outline;
    el._spoonOldOutlineOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '2px';
  }

  function clearHighlight() {
    if (highlightEl) {
      highlightEl.style.outline = highlightEl._spoonOldOutline || '';
      highlightEl.style.outlineOffset = highlightEl._spoonOldOutlineOffset || '';
      highlightEl = null;
    }
  }

  // ── Click → open panel ───────────────────────────────────────────────────────

  function onClick(e) {
    const el = e.target.closest('[data-spoon-loc]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openPanel(el);
  }

  // ── Edit panel ───────────────────────────────────────────────────────────────

  function openPanel(el) {
    hidePanel();
    const loc = el.dataset.spoonLoc; // "src/App.tsx:14:4"
    const [file, lineStr] = loc.split(':');
    const line = Number(lineStr);

    const rect = el.getBoundingClientRect();
    panel = document.createElement('div');
    panel.id = '__spoon-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      top: Math.min(rect.bottom + 8, window.innerHeight - 320) + 'px',
      left: Math.max(Math.min(rect.left, window.innerWidth - 340), 8) + 'px',
      width: '320px',
      background: '#1e1e2e',
      color: '#cdd6f4',
      borderRadius: '10px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      fontFamily: 'monospace',
      fontSize: '13px',
      zIndex: '2147483647',
      overflow: 'hidden',
      border: '1px solid #313244',
    });

    const classes = el.className || '';
    const textContent = el.childNodes.length === 1 && el.firstChild.nodeType === 3
      ? el.firstChild.textContent : null;

    panel.innerHTML = \`
      <div style="padding:10px 14px;background:#181825;display:flex;align-items:center;gap:8px;border-bottom:1px solid #313244;">
        <span style="color:#6366f1;font-weight:bold">⟡ spoon</span>
        <span style="flex:1;color:#585b70;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${loc}</span>
        <button id="__spoon-close" style="background:none;border:none;color:#585b70;cursor:pointer;font-size:16px;padding:0;line-height:1">×</button>
      </div>
      <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
        \${textContent !== null ? \`
          <label style="display:flex;flex-direction:column;gap:4px;">
            <span style="color:#a6adc8;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Text</span>
            <input id="__spoon-text" value="\${escHtml(textContent)}" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:6px;padding:6px 8px;font-family:monospace;font-size:13px;outline:none;"/>
          </label>
        \` : ''}
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span style="color:#a6adc8;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Classes</span>
          <input id="__spoon-classes" value="\${escHtml(classes)}" style="background:#313244;border:1px solid #45475a;color:#cdd6f4;border-radius:6px;padding:6px 8px;font-family:monospace;font-size:13px;outline:none;"/>
        </label>
        <div style="display:flex;gap:8px;">
          <button id="__spoon-apply" style="flex:1;background:#6366f1;color:#fff;border:none;border-radius:6px;padding:7px;cursor:pointer;font-size:13px;font-weight:600;">Apply →</button>
          <button id="__spoon-cancel" style="background:#313244;color:#cdd6f4;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px;">Cancel</button>
        </div>
        <div id="__spoon-status" style="font-size:11px;color:#a6e3a1;min-height:16px;"></div>
      </div>
    \`;

    document.body.appendChild(panel);

    panel.querySelector('#__spoon-close').onclick = hidePanel;
    panel.querySelector('#__spoon-cancel').onclick = hidePanel;
    panel.querySelector('#__spoon-apply').onclick = () => applyEdits(el, file, line);

    // Live class preview (no write-back until Apply)
    panel.querySelector('#__spoon-classes').addEventListener('input', (e) => {
      el.className = e.target.value;
    });
    if (textContent !== null) {
      panel.querySelector('#__spoon-text').addEventListener('input', (e) => {
        el.firstChild.textContent = e.target.value;
      });
    }
  }

  async function applyEdits(el, file, line) {
    const patches = [];

    const classInput = panel.querySelector('#__spoon-classes');
    const oldClasses = el.dataset.spoonOrigClass ?? el.className;
    if (classInput && classInput.value !== oldClasses) {
      patches.push({
        type: 'class-replace',
        line,
        oldValue: oldClasses,
        newValue: classInput.value,
      });
    }

    const textInput = panel.querySelector('#__spoon-text');
    if (textInput) {
      const origText = el.dataset.spoonOrigText ?? el.firstChild?.textContent ?? '';
      if (textInput.value !== origText) {
        patches.push({ type: 'text', line, oldValue: origText, newValue: textInput.value });
      }
    }

    if (patches.length === 0) {
      setStatus('Nothing changed.');
      return;
    }

    setStatus('Writing…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, patches }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus('✓ Saved — HMR will reload');
        el.dataset.spoonOrigClass = classInput?.value ?? el.className;
        if (textInput) el.dataset.spoonOrigText = textInput.value;
      } else {
        setStatus('Error: ' + (data.error ?? 'unknown'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  function setStatus(msg) {
    const s = panel?.querySelector('#__spoon-status');
    if (s) s.textContent = msg;
  }

  function hidePanel() {
    panel?.remove();
    panel = null;
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────────

  let toolbar = null;
  function showToolbar() {
    if (toolbar) return;
    toolbar = document.createElement('div');
    toolbar.id = '__spoon-toolbar';
    Object.assign(toolbar.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      background: '#1e1e2e',
      border: '1px solid #6366f1',
      borderRadius: '8px',
      padding: '6px 12px',
      color: '#6366f1',
      fontFamily: 'monospace',
      fontSize: '12px',
      fontWeight: '600',
      zIndex: '2147483647',
      boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    toolbar.textContent = '⟡ spoon active — click any element';
    document.body.appendChild(toolbar);
  }
  function hideToolbar() { toolbar?.remove(); toolbar = null; }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  console.log('[spoon] loaded — press ' + HOTKEY + ' to activate visual editor');
})();
`
}
