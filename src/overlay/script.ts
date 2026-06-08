import type { ResolvedSpoonOptions } from '../options.js'

/**
 * Browser overlay for vite-plugin-spoon.
 *
 * Shipped as a single inline IIFE so it lands in one round trip with
 * zero client deps. The string is huge but each section is self-contained
 * — read it top-to-bottom.
 */
export function overlayScript(opts: ResolvedSpoonOptions): string {
  return `
;(function spoonOverlay() {
  const HOTKEY = ${JSON.stringify(opts.hotkey)};
  const API = '/__spoon';

  // ── Tailwind helpers ──────────────────────────────────────────────────
  // The default Tailwind v3 spacing scale — used by the spacing/size
  // pickers. Projects with custom scales still work; we just show these
  // as quick presets.
  const SPACING_SCALE = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 32];

  // ── State ─────────────────────────────────────────────────────────────
  const state = {
    active: false,
    panel: null,
    pin: null,
    currentEl: null,
    tab: 'properties',
    position: localStorage.getItem('__spoon_pos') || 'right',
    panelWidth: Number(localStorage.getItem('__spoon_w')) || 360,
    panelHeight: Number(localStorage.getItem('__spoon_h')) || 320,
    floatPos: JSON.parse(localStorage.getItem('__spoon_float') || '{"x":80,"y":80}'),
    tokens: { colors: [], spacing: [] },
    undoStack: [],
    redoStack: [],
    historyOpenCount: 0,
  };

  // ── Hotkey parsing — matches on physical e.code so macOS' Alt-letter
  // substitution doesn't break things ──────────────────────────────────
  const hk = parseHotkey(HOTKEY);
  function parseHotkey(str) {
    const mods = { alt: false, ctrl: false, shift: false, meta: false, code: 'KeyS' };
    for (const p of str.split('+').map((x) => x.trim())) {
      const low = p.toLowerCase();
      if (low === 'alt' || low === 'option') mods.alt = true;
      else if (low === 'ctrl' || low === 'control') mods.ctrl = true;
      else if (low === 'shift') mods.shift = true;
      else if (low === 'meta' || low === 'cmd' || low === 'command') mods.meta = true;
      else if (/^[a-z]$/i.test(p)) mods.code = 'Key' + p.toUpperCase();
      else if (/^[0-9]$/.test(p)) mods.code = 'Digit' + p;
      else mods.code = p;
    }
    return mods;
  }

  document.addEventListener('keydown', (e) => {
    // Toggle hotkey works regardless of mode
    if (
      !!e.altKey === hk.alt && !!e.ctrlKey === hk.ctrl &&
      !!e.shiftKey === hk.shift && !!e.metaKey === hk.meta &&
      e.code === hk.code
    ) {
      e.preventDefault();
      state.active ? deactivate() : activate();
      return;
    }
    if (!state.active) return;
    if (e.key === 'Escape') { deactivate(); return; }

    // Undo / Redo only while spoon is active so we don't shadow the app's own shortcuts.
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async function activate() {
    state.active = true;
    document.body.style.cursor = 'crosshair';
    mountPanel();
    hidePin();
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    try {
      state.tokens = await (await fetch(API + '/tokens')).json();
    } catch {}
    if (state.currentEl) renderTab(); // re-render now that tokens are in
  }

  function deactivate() {
    state.active = false;
    document.body.style.cursor = '';
    clearHighlight();
    unmountPanel();
    state.currentEl = null;
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    mountPin(); // pin stays as the way back in
  }

  // ── Edge-Pin (always visible when spoon is closed) ────────────────────

  function mountPin() {
    if (state.pin) return;
    const pin = document.createElement('button');
    Object.assign(pin.style, {
      position: 'fixed', top: '50%', right: '0',
      transform: 'translateY(-50%)',
      background: '#1e1e2e', color: '#6366f1',
      border: '1px solid #6366f1', borderRight: 'none',
      borderRadius: '6px 0 0 6px', padding: '8px 6px',
      cursor: 'pointer', zIndex: '2147483646',
      fontFamily: 'monospace', fontSize: '14px',
      writingMode: 'vertical-rl', letterSpacing: '.15em',
      boxShadow: '-2px 0 12px rgba(99,102,241,0.25)',
    });
    pin.textContent = '⟡ spoon';
    pin.title = 'Open spoon visual editor (' + HOTKEY + ')';
    pin.onclick = () => activate();
    document.body.appendChild(pin);
    state.pin = pin;
  }
  function hidePin() { state.pin?.remove(); state.pin = null; }

  // Mount the pin immediately on script load so the user always has an entry point
  mountPin();

  // ── Panel mounting + positioning ──────────────────────────────────────

  function mountPanel() {
    if (state.panel) return;
    const panel = document.createElement('div');
    panel.id = '__spoon-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      background: '#1e1e2e', color: '#cdd6f4',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '12px', zIndex: '2147483647',
      display: 'flex', flexDirection: 'column',
      border: '1px solid #313244',
    });
    panel.innerHTML =
      headerHtml() +
      tabBarHtml() +
      '<div id="__spoon-body" style="overflow:auto;flex:1;padding:12px 14px;display:flex;flex-direction:column;gap:14px;"></div>' +
      footerHtml();

    document.body.appendChild(panel);
    state.panel = panel;

    // Wire up controls that don't depend on a selection
    panel.querySelector('#__spoon-close').onclick = deactivate;
    panel.querySelector('#__spoon-apply').onclick = () => state.currentEl && commit(state.currentEl);
    panel.querySelector('#__spoon-undo').onclick = undo;
    panel.querySelector('#__spoon-redo').onclick = redo;
    panel.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => switchTab(b.getAttribute('data-tab'));
    });
    panel.querySelectorAll('[data-pos]').forEach((b) => {
      b.onclick = () => setPosition(b.getAttribute('data-pos'));
    });

    applyPosition(state.position);
    showEmptyState();
  }

  function unmountPanel() {
    state.panel?.remove();
    state.panel = null;
    document.body.style.marginRight = '';
    document.body.style.marginBottom = '';
  }

  function applyPosition(pos) {
    state.position = pos;
    localStorage.setItem('__spoon_pos', pos);
    const p = state.panel;
    if (!p) return;
    // reset
    Object.assign(p.style, {
      top: '', right: '', bottom: '', left: '',
      width: '', height: '', borderRadius: '0',
      transform: '',
    });
    document.body.style.marginRight = '';
    document.body.style.marginBottom = '';

    // remove old grip
    p.querySelector('#__spoon-grip')?.remove();

    if (pos === 'right') {
      Object.assign(p.style, { top: '0', right: '0', height: '100vh', width: state.panelWidth + 'px' });
      document.body.style.transition = 'margin 0.15s ease';
      document.body.style.marginRight = state.panelWidth + 'px';
      addGrip(p, 'ew');
    } else if (pos === 'bottom') {
      Object.assign(p.style, { bottom: '0', left: '0', width: '100vw', height: state.panelHeight + 'px' });
      document.body.style.transition = 'margin 0.15s ease';
      document.body.style.marginBottom = state.panelHeight + 'px';
      addGrip(p, 'ns');
    } else if (pos === 'floating') {
      Object.assign(p.style, {
        top: state.floatPos.y + 'px', left: state.floatPos.x + 'px',
        width: state.panelWidth + 'px', height: '60vh',
        borderRadius: '10px',
      });
      makeFloatable(p);
    }
    // highlight active position button
    p.querySelectorAll('[data-pos]').forEach((b) => {
      b.style.background = b.getAttribute('data-pos') === pos ? '#313244' : 'transparent';
    });
  }

  function setPosition(pos) { applyPosition(pos); }

  function addGrip(panel, axis) {
    const grip = document.createElement('div');
    grip.id = '__spoon-grip';
    Object.assign(grip.style, {
      position: 'absolute',
      cursor: axis === 'ew' ? 'ew-resize' : 'ns-resize',
      background: 'transparent',
      ...(axis === 'ew'
        ? { top: '0', left: '0', width: '4px', height: '100%' }
        : { top: '0', left: '0', height: '4px', width: '100%' }),
    });
    grip.addEventListener('mousedown', (e) => startResize(e, axis));
    panel.appendChild(grip);
  }

  function startResize(e, axis) {
    e.preventDefault();
    const start = axis === 'ew' ? e.clientX : e.clientY;
    const startW = state.panelWidth;
    const startH = state.panelHeight;
    const onMove = (ev) => {
      if (axis === 'ew') {
        const next = Math.max(280, Math.min(720, startW + (start - ev.clientX)));
        state.panelWidth = next;
        state.panel.style.width = next + 'px';
        document.body.style.marginRight = next + 'px';
      } else {
        const next = Math.max(180, Math.min(window.innerHeight - 100, startH + (start - ev.clientY)));
        state.panelHeight = next;
        state.panel.style.height = next + 'px';
        document.body.style.marginBottom = next + 'px';
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('__spoon_w', String(state.panelWidth));
      localStorage.setItem('__spoon_h', String(state.panelHeight));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function makeFloatable(panel) {
    const header = panel.querySelector('#__spoon-header');
    header.style.cursor = 'move';
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // don't drag from buttons
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = state.floatPos.x, startTop = state.floatPos.y;
      const onMove = (ev) => {
        const x = Math.max(0, Math.min(window.innerWidth - 200, startLeft + (ev.clientX - startX)));
        const y = Math.max(0, Math.min(window.innerHeight - 100, startTop + (ev.clientY - startY)));
        state.floatPos = { x, y };
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('__spoon_float', JSON.stringify(state.floatPos));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Header / tabs / footer markup ─────────────────────────────────────

  function headerHtml() {
    return \`<div id="__spoon-header" style="padding:9px 12px;background:#181825;display:flex;align-items:center;gap:6px;border-bottom:1px solid #313244;flex-shrink:0;">
      <span style="color:#6366f1;font-weight:700">⟡</span>
      <div id="__spoon-breadcrumb" style="flex:1;color:#585b70;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:2px;align-items:center"></div>
      <div style="display:flex;gap:1px;background:#11111b;border-radius:4px;padding:2px;margin-left:6px;">
        \${posButton('right',    \`<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="13" height="13" rx="1"/><line x1="10" y1="1.5" x2="10" y2="14.5"/></svg>\`, 'Dock right')}
        \${posButton('bottom',   \`<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="13" height="13" rx="1"/><line x1="1.5" y1="10" x2="14.5" y2="10"/></svg>\`, 'Dock bottom')}
        \${posButton('floating', \`<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>\`, 'Floating')}
      </div>
      <button id="__spoon-close" style="background:none;border:none;color:#585b70;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;margin-left:4px" title="Close (Esc)">×</button>
    </div>\`;
  }
  function posButton(pos, svg, title) {
    return \`<button data-pos="\${pos}" title="\${title}" style="background:transparent;border:none;border-radius:3px;padding:3px 5px;cursor:pointer;color:#a6adc8;display:flex;align-items:center;line-height:0">\${svg}</button>\`;
  }
  function tabBarHtml() {
    return \`<div style="display:flex;background:#11111b;border-bottom:1px solid #313244;flex-shrink:0;">
      \${tabBtn('properties', 'Properties')}
      \${tabBtn('raw',        'Raw')}
      \${tabBtn('history',    'History')}
    </div>\`;
  }
  function tabBtn(id, label) {
    return \`<button data-tab="\${id}" style="flex:1;background:transparent;border:none;color:#a6adc8;padding:7px 8px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid transparent">\${label}</button>\`;
  }
  function footerHtml() {
    return \`<div style="padding:8px 12px;background:#181825;border-top:1px solid #313244;display:flex;gap:6px;align-items:center;flex-shrink:0;">
      <button id="__spoon-undo" title="Undo (Cmd+Z)" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:5px 9px;cursor:pointer;font-size:13px">↶</button>
      <button id="__spoon-redo" title="Redo (Cmd+Shift+Z)" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:5px 9px;cursor:pointer;font-size:13px">↷</button>
      <div id="__spoon-status" style="flex:1;font-size:11px;color:#a6e3a1;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right"></div>
      <button id="__spoon-apply" title="Force-save now (changes auto-save on edit)" style="background:#6366f1;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:11px;font-weight:600">Save now</button>
    </div>\`;
  }

  function switchTab(tab) {
    state.tab = tab;
    state.panel.querySelectorAll('[data-tab]').forEach((b) => {
      const active = b.getAttribute('data-tab') === tab;
      b.style.color = active ? '#cdd6f4' : '#a6adc8';
      b.style.borderBottomColor = active ? '#6366f1' : 'transparent';
      b.style.background = active ? '#1e1e2e' : 'transparent';
    });
    renderTab();
  }

  // ── Selection & hover ─────────────────────────────────────────────────

  let highlightEl = null;
  function onHover(e) {
    if (state.panel?.contains(e.target)) return;
    if (e.target === highlightEl) return;
    clearHighlight();
    const el = e.target;
    if (!el.dataset || !el.dataset.spoonLoc) return;
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
  function onClick(e) {
    if (state.panel?.contains(e.target)) return;
    const el = e.target.closest('[data-spoon-loc]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(el);
  }
  function onDblClick(e) {
    if (state.panel?.contains(e.target)) return;
    const el = e.target.closest('[data-spoon-loc]');
    if (!el) return;
    // Only allow inline edit if element holds a single text node
    if (!(el.childNodes.length === 1 && el.firstChild.nodeType === 3)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(el);
    inlineEditText(el);
  }

  function inlineEditText(el) {
    const orig = el.firstChild.textContent;
    el.setAttribute('contenteditable', 'true');
    el._spoonOldOutline = el.style.outline;
    el.style.outline = '2px dashed #f9e2af';
    el.focus();
    document.getSelection()?.selectAllChildren(el);

    const finish = (save) => {
      el.removeAttribute('contenteditable');
      el.style.outline = el._spoonOldOutline || '';
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      const next = el.firstChild?.textContent ?? '';
      if (save && next !== orig) {
        // restore text temporarily so applyEdits sees the diff between orig and current
        // (panel.dataset.origText holds the baseline)
        if (state.currentEl === el) {
          state.panel.dataset.origText = orig;
          applyEdits(el);
        }
      } else if (!save) {
        el.firstChild.textContent = orig;
      }
    };
    const onBlur = () => finish(true);
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); el.blur(); }
    };
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
  }

  function selectElement(el) {
    if (!state.panel) mountPanel();
    if (state.currentEl === el) return;
    // Auto-apply mode: changes have already been written. Just rebase
    // origClass/origText to the current DOM state so the next applyEdits
    // diffs correctly.
    state.currentEl = el;
    state.panel.dataset.origClass = el.className || '';
    const initialText = el.childNodes.length === 1 && el.firstChild.nodeType === 3
      ? el.firstChild.textContent : null;
    if (initialText !== null) state.panel.dataset.origText = initialText;
    else delete state.panel.dataset.origText;

    renderBreadcrumb(el);
    setStatus('');
    renderTab();
  }

  // Auto-commit helpers — every UI action calls these instead of waiting
  // for an Apply button. commit() is fire-and-forget by design; errors
  // surface in the footer status line.
  function commit(el) {
    applyEdits(el).catch((err) => setStatus('Error: ' + err.message));
  }
  let debounceTimer = null;
  function commitDebounced(el, ms = 400) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => commit(el), ms);
  }

  function showEmptyState() {
    const body = state.panel.querySelector('#__spoon-body');
    body.innerHTML = '<div style="color:#585b70;text-align:center;padding:40px 0;font-size:12px">Click any element to start editing</div>';
    state.panel.querySelector('#__spoon-breadcrumb').textContent = '';
    switchTab(state.tab);
  }

  // ── Breadcrumb (climb parent chain) ───────────────────────────────────

  function renderBreadcrumb(el) {
    const chain = [];
    let cur = el;
    while (cur && cur !== document.body && chain.length < 6) {
      if (cur.dataset && cur.dataset.spoonLoc) chain.unshift(cur);
      cur = cur.parentElement;
    }
    const bc = state.panel.querySelector('#__spoon-breadcrumb');
    bc.innerHTML = '';
    chain.forEach((node, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.color = '#45475a';
        bc.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.textContent = node.tagName.toLowerCase();
      Object.assign(btn.style, {
        background: node === el ? '#313244' : 'transparent',
        color: node === el ? '#cdd6f4' : '#6c7086',
        border: 'none', borderRadius: '3px', padding: '1px 5px',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px',
      });
      btn.onmouseenter = () => previewHighlight(node, true);
      btn.onmouseleave = () => previewHighlight(node, false);
      btn.onclick = () => selectElement(node);
      bc.appendChild(btn);
    });
  }

  function previewHighlight(el, on) {
    if (on) {
      el._spoonPreviewOldOutline = el.style.outline;
      el.style.outline = '2px dashed #6366f1';
    } else {
      el.style.outline = el._spoonPreviewOldOutline || '';
    }
  }

  // ── Tab rendering ─────────────────────────────────────────────────────

  function renderTab() {
    if (!state.panel) return;
    const body = state.panel.querySelector('#__spoon-body');
    body.innerHTML = '';

    if (state.tab === 'history') {
      renderHistoryTab(body);
      return;
    }
    if (!state.currentEl) {
      body.innerHTML = '<div style="color:#585b70;text-align:center;padding:40px 0;font-size:12px">Click any element to start editing</div>';
      return;
    }
    if (state.tab === 'properties') renderPropertiesTab(body, state.currentEl);
    else if (state.tab === 'raw') renderRawTab(body, state.currentEl);
  }

  // ── Class taxonomy ────────────────────────────────────────────────────

  const GROUPS = [
    ['layout',     /^(flex|grid|block|inline|inline-block|inline-flex|inline-grid|hidden|table|contents|flow-root|isolate|isolation-|float-|clear-|object-|overflow-|overscroll-|position-|static|fixed|absolute|relative|sticky|inset-|top-|right-|bottom-|left-|z-|order-|col-|row-|grid-|gap-|items-|justify-|content-|self-|place-|basis-|grow|shrink|wrap|nowrap|flex-)/],
    ['spacing',   /^(p[trblxy]?-|-?m[trblxy]?-|space-[xy]-|gap-)/],
    ['sizing',    /^(w-|h-|min-w-|min-h-|max-w-|max-h-|size-|aspect-)/],
    ['color',     /^(bg-|text-|border-|ring-|fill-|stroke-|accent-|caret-|decoration-|divide-|outline-|placeholder-|from-|via-|to-|shadow-)/],
    ['typography',/^(font-|text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|left|center|right|justify|start|end)|leading-|tracking-|whitespace-|break-|truncate|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|overline|line-through|no-underline|antialiased|subpixel-antialiased)/],
    ['effects',   /^(rounded|border|shadow|opacity-|blur|brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia|backdrop-|transition|duration-|delay-|ease-|animate-|transform|translate|rotate|scale|skew|origin-|cursor-|select-|pointer-events-|user-select-)/],
  ];
  function classifyToken(cls) {
    const bareIdx = cls.lastIndexOf(':');
    const bare = bareIdx >= 0 ? cls.slice(bareIdx + 1) : cls;
    for (const [id, re] of GROUPS) if (re.test(bare)) return id;
    return 'other';
  }
  function parseClasses(str) {
    const tokens = (str || '').split(/\\s+/).filter(Boolean);
    const groups = { layout: [], spacing: [], sizing: [], color: [], typography: [], effects: [], other: [] };
    for (const tk of tokens) groups[classifyToken(tk)].push(tk);
    return groups;
  }

  // ── Class manipulation helpers ────────────────────────────────────────

  function classList(el) { return (el.className || '').split(/\\s+/).filter(Boolean); }
  function setClassList(el, arr) { el.className = arr.join(' '); }
  function removeClass(el, cls) { setClassList(el, classList(el).filter((c) => c !== cls)); }
  function addClass(el, cls) {
    const set = new Set(classList(el));
    set.add(cls);
    setClassList(el, Array.from(set));
  }
  /** Remove any class matching the prefix-regex, then optionally add a new one. */
  function replacePrefixed(el, prefixRe, nextClass) {
    const next = classList(el).filter((c) => !prefixRe.test(c));
    if (nextClass) next.push(nextClass);
    setClassList(el, next);
  }
  /** Find the first class matching a prefix-regex. */
  function findPrefixed(el, prefixRe) {
    return classList(el).find((c) => prefixRe.test(c)) || '';
  }

  // ── Properties tab ─────────────────────────────────────────────────────

  const GROUP_META = {
    layout:     { label: 'Layout',     color: '#89b4fa' },
    spacing:    { label: 'Spacing',    color: '#a6e3a1' },
    sizing:     { label: 'Sizing',     color: '#94e2d5' },
    color:      { label: 'Color',      color: '#f5c2e7' },
    typography: { label: 'Typography', color: '#fab387' },
    effects:    { label: 'Effects',    color: '#cba6f7' },
    other:      { label: 'Other',      color: '#bac2de' },
  };

  function renderPropertiesTab(body, el) {
    // Text editor at top, if element has a single text child
    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
      body.appendChild(textSection(el));
    }
    // Visual editors (Phase 3.1–3.3) — placeholders to be filled by next commit
    body.appendChild(layoutSection(el));
    body.appendChild(sizingSection(el));
    body.appendChild(spacingSection(el));

    // Existing class-chip sections per category
    const groups = parseClasses(el.className);
    for (const id of Object.keys(GROUP_META)) {
      if (id === 'spacing' || id === 'sizing' || id === 'layout') continue; // covered by visual editors above
      if (id === 'color') body.appendChild(colorSection(el));
      else body.appendChild(chipSection(el, id));
    }
  }

  function textSection(el) {
    const wrap = section('Text', '#f9e2af');
    const hint = document.createElement('div');
    hint.textContent = 'Tip: double-click text in the page to edit inline';
    Object.assign(hint.style, { fontSize: '10px', color: '#585b70', marginBottom: '4px' });
    wrap.appendChild(hint);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = el.firstChild?.textContent ?? '';
    Object.assign(input.style, inputStyle());
    input.dataset.role = 'text-input';
    input.addEventListener('input', () => {
      if (el.firstChild) el.firstChild.textContent = input.value;
      commitDebounced(el);
    });
    wrap.appendChild(input);
    return wrap;
  }

  // ── Layout section: Display + Alignment (Phase 3.2 — placeholder UI) ──

  function layoutSection(el) {
    const wrap = section('Layout', GROUP_META.layout.color);

    const displayRow = buttonRow('Display', [
      ['block',        'Block'],
      ['flex',         'Flex'],
      ['inline-flex',  'I-Flex'],
      ['grid',         'Grid'],
      ['inline-block', 'Inline'],
      ['hidden',       'Hidden'],
    ], (val) => {
      replacePrefixed(el, /^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|table|contents|flow-root)$/, val);
      commit(el);
      renderTab();
    }, (val) => classList(el).includes(val));
    wrap.appendChild(displayRow);

    const cur = classList(el);
    if (cur.includes('flex') || cur.includes('inline-flex')) {
      wrap.appendChild(buttonRow('Items', [
        ['items-start',    '⊤'],
        ['items-center',   '⊕'],
        ['items-end',      '⊥'],
        ['items-stretch',  '↔'],
        ['items-baseline', 'B'],
      ], (val) => { replacePrefixed(el, /^items-/, val); commit(el); renderTab(); }, (val) => cur.includes(val)));

      wrap.appendChild(buttonRow('Justify', [
        ['justify-start',   '⊢'],
        ['justify-center',  '═'],
        ['justify-end',     '⊣'],
        ['justify-between', '⇔'],
        ['justify-around',  '⊟'],
        ['justify-evenly',  '⊞'],
      ], (val) => { replacePrefixed(el, /^justify-/, val); commit(el); renderTab(); }, (val) => cur.includes(val)));

      wrap.appendChild(buttonRow('Direction', [
        ['flex-row',         '→'],
        ['flex-col',         '↓'],
        ['flex-row-reverse', '←'],
        ['flex-col-reverse', '↑'],
      ], (val) => { replacePrefixed(el, /^flex-(row|col)(-reverse)?$/, val); commit(el); renderTab(); }, (val) => cur.includes(val)));
    }

    return wrap;
  }

  // ── Sizing section (Phase 3.3 — placeholder UI) ───────────────────────

  function sizingSection(el) {
    const wrap = section('Size', GROUP_META.sizing.color);
    wrap.appendChild(sizeRow(el, 'w', 'Width'));
    wrap.appendChild(sizeRow(el, 'h', 'Height'));
    return wrap;
  }

  function sizeRow(el, dim, label) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });

    const lbl = document.createElement('span');
    lbl.textContent = label;
    Object.assign(lbl.style, { fontSize: '11px', color: '#a6adc8', width: '50px' });
    row.appendChild(lbl);

    const cur = findPrefixed(el, new RegExp('^' + dim + '-'));
    const mode = !cur ? 'auto' : /-(full|screen)$/.test(cur) ? 'fill' : /\\[/.test(cur) ? 'fixed' : 'preset';

    const modeSel = document.createElement('select');
    Object.assign(modeSel.style, selectStyle());
    for (const m of ['auto', 'preset', 'fixed', 'fill']) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (m === mode) opt.selected = true;
      modeSel.appendChild(opt);
    }
    row.appendChild(modeSel);

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = mode === 'fixed' ? '124px' : '4';
    if (mode === 'fixed' && cur) valueInput.value = cur.match(/\\[(.+)\\]/)?.[1] ?? '';
    else if (mode === 'preset' && cur) valueInput.value = cur.replace(dim + '-', '');
    Object.assign(valueInput.style, { ...inputStyle(), flex: '1' });
    row.appendChild(valueInput);

    const update = () => {
      const m = modeSel.value;
      const re = new RegExp('^' + dim + '-');
      let changed = true;
      if (m === 'auto') { replacePrefixed(el, re, dim + '-auto'); }
      else if (m === 'fill') { replacePrefixed(el, re, dim + '-full'); }
      else if (m === 'preset') {
        const v = valueInput.value.trim();
        if (v) replacePrefixed(el, re, dim + '-' + v);
        else changed = false;
      } else if (m === 'fixed') {
        const v = valueInput.value.trim();
        if (v) replacePrefixed(el, re, dim + '-[' + v + ']');
        else changed = false;
      }
      if (changed) commit(el);
    };
    modeSel.addEventListener('change', update);
    valueInput.addEventListener('change', update);
    valueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') update(); });

    return row;
  }

  // ── Spacing-Box (Phase 3.1 — placeholder, filled in next commit) ──────

  function spacingSection(el) {
    const wrap = section('Spacing', GROUP_META.spacing.color);
    const hint = document.createElement('div');
    hint.textContent = 'Visual margin/padding editor coming next';
    Object.assign(hint.style, { fontSize: '10px', color: '#585b70', fontStyle: 'italic' });
    wrap.appendChild(hint);

    const meta = GROUP_META.spacing;
    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    const refresh = () => {
      chipRow.innerHTML = '';
      const groups = parseClasses(el.className);
      for (const cls of groups.spacing) {
        chipRow.appendChild(chip(cls, meta.color, () => { removeClass(el, cls); commit(el); refresh(); }));
      }
      chipRow.appendChild(addInput(el, 'spacing', refresh));
    };
    refresh();
    wrap.appendChild(chipRow);
    return wrap;
  }

  function chipSection(el, groupId) {
    const meta = GROUP_META[groupId];
    const groups = parseClasses(el.className);
    const items = groups[groupId];
    // "Other" / custom is noise when empty — hide it entirely
    if (groupId === 'other' && items.length === 0) return document.createDocumentFragment();

    const wrap = section(groupId === 'other' ? 'Custom classes' : meta.label, meta.color);
    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    const refresh = () => {
      chipRow.innerHTML = '';
      const g = parseClasses(el.className);
      for (const cls of g[groupId]) {
        chipRow.appendChild(chip(cls, meta.color, () => { removeClass(el, cls); commit(el); refresh(); }));
      }
      chipRow.appendChild(addInput(el, groupId, refresh));
    };
    refresh();
    wrap.appendChild(chipRow);
    return wrap;
  }

  function colorSection(el) {
    const meta = GROUP_META.color;
    const wrap = section(meta.label, meta.color);
    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    const refresh = () => {
      chipRow.innerHTML = '';
      const groups = parseClasses(el.className);
      for (const cls of groups.color) {
        chipRow.appendChild(chip(cls, meta.color, () => { removeClass(el, cls); commit(el); refresh(); }));
      }
      chipRow.appendChild(addInput(el, 'color', refresh));
    };
    refresh();
    wrap.appendChild(chipRow);

    if (state.tokens.colors && state.tokens.colors.length > 0) {
      // Mode picker: which prefix gets the token? bg- / text- / border-
      const modeWrap = document.createElement('div');
      Object.assign(modeWrap.style, { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '8px' });
      const modeLbl = document.createElement('span');
      modeLbl.textContent = 'Apply to';
      Object.assign(modeLbl.style, { fontSize: '10px', color: '#585b70', width: '60px', textTransform: 'uppercase', letterSpacing: '.06em' });
      modeWrap.appendChild(modeLbl);
      const modes = ['bg', 'text', 'border', 'ring'];
      const btns = [];
      const updateModeBtns = (active) => {
        btns.forEach((b, i) => {
          const isActive = modes[i] === active;
          b.style.background = isActive ? '#6366f1' : 'transparent';
          b.style.color = isActive ? '#fff' : '#a6adc8';
        });
      };
      const grp = document.createElement('div');
      Object.assign(grp.style, { display: 'flex', gap: '2px', background: '#11111b', borderRadius: '4px', padding: '2px' });
      let activeMode = state._colorMode || 'bg';
      for (const m of modes) {
        const b = document.createElement('button');
        b.textContent = m.toUpperCase();
        Object.assign(b.style, {
          background: 'transparent', color: '#a6adc8', border: 'none',
          borderRadius: '3px', padding: '3px 7px', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: '10px', fontWeight: '600',
        });
        b.onclick = () => { activeMode = m; state._colorMode = m; updateModeBtns(m); };
        btns.push(b);
        grp.appendChild(b);
      }
      updateModeBtns(activeMode);
      modeWrap.appendChild(grp);
      wrap.appendChild(modeWrap);

      const lbl = document.createElement('div');
      lbl.textContent = 'Theme tokens — click to apply';
      Object.assign(lbl.style, { fontSize: '10px', color: '#585b70', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '.06em' });
      wrap.appendChild(lbl);
      const swatches = document.createElement('div');
      Object.assign(swatches.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
      for (const tk of state.tokens.colors) {
        swatches.appendChild(colorSwatch(tk, el, () => activeMode, refresh));
      }
      wrap.appendChild(swatches);
    }
    return wrap;
  }

  // ── Raw tab ───────────────────────────────────────────────────────────

  function renderRawTab(body, el) {
    const cls = section('Class names', '#585b70');
    const ta = document.createElement('textarea');
    ta.value = el.className;
    Object.assign(ta.style, { ...inputStyle(), minHeight: '80px', resize: 'vertical', fontFamily: 'inherit' });
    ta.addEventListener('input', () => { el.className = ta.value; commitDebounced(el); });
    cls.appendChild(ta);
    body.appendChild(cls);

    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
      const txt = section('Text', '#f9e2af');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = el.firstChild.textContent ?? '';
      input.dataset.role = 'text-input';
      Object.assign(input.style, inputStyle());
      input.addEventListener('input', () => { el.firstChild.textContent = input.value; commitDebounced(el); });
      txt.appendChild(input);
      body.appendChild(txt);
    }
  }

  // ── History tab ───────────────────────────────────────────────────────

  async function renderHistoryTab(body) {
    const wrap = section('History', '#bac2de');
    const stackInfo = document.createElement('div');
    Object.assign(stackInfo.style, { fontSize: '11px', color: '#585b70' });
    stackInfo.textContent = \`Undo stack: \${state.undoStack.length} · Redo stack: \${state.redoStack.length}\`;
    wrap.appendChild(stackInfo);
    body.appendChild(wrap);

    const list = section('Saved changes', '#585b70');
    body.appendChild(list);

    const loading = document.createElement('div');
    loading.textContent = 'Loading…';
    Object.assign(loading.style, { color: '#585b70', fontSize: '11px' });
    list.appendChild(loading);

    let entries = [];
    try {
      entries = (await (await fetch(API + '/history')).json()).entries || [];
    } catch {}
    loading.remove();

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No saved changes yet — apply something and it will show up here.';
      Object.assign(empty.style, { color: '#585b70', fontSize: '11px', fontStyle: 'italic' });
      list.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', flexDirection: 'column', gap: '2px',
        padding: '6px 8px', borderRadius: '5px', background: '#181825',
        cursor: 'pointer', border: '1px solid #313244',
      });
      const time = new Date(e.ts).toLocaleString();
      const fileShort = (e.file || '').split('/').slice(-2).join('/');
      row.innerHTML = \`
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline">
          <span style="color:#cdd6f4;font-size:11px;font-weight:600">\${esc(e.label)}</span>
          <span style="color:#45475a;font-size:10px">\${esc(time)}</span>
        </div>
        <div style="color:#6c7086;font-size:10px">\${esc(fileShort)}</div>
      \`;
      row.title = 'Click to restore the state before this change';
      row.onclick = () => restoreEntry(e);
      list.appendChild(row);
    }
  }

  async function restoreEntry(entry) {
    if (!entry.inverse || entry.inverse.length === 0) {
      setStatus('Marker entry — nothing to restore.');
      return;
    }
    setStatus('Restoring…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: entry.file, patches: entry.inverse, label: 'Restore @ ' + new Date(entry.ts).toLocaleTimeString() }),
      });
      const data = await res.json();
      if (data.ok) setStatus('✓ Restored');
      else setStatus('Error: ' + (data.error ?? 'unknown'));
      renderTab();
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  // ── Apply / Revert / Undo / Redo ──────────────────────────────────────

  async function applyEdits(el) {
    const loc = el.dataset.spoonLoc;
    const [file, lineStr] = loc.split(':');
    const line = Number(lineStr);
    const origClass = state.panel.dataset.origClass ?? '';
    const origText = state.panel.dataset.origText;

    const patches = [];
    if (el.className !== origClass) {
      patches.push({ type: 'class-replace', line, oldValue: origClass, newValue: el.className });
    }
    const textInput = state.panel.querySelector('[data-role="text-input"]');
    if (textInput && origText !== undefined && textInput.value !== origText) {
      patches.push({ type: 'text', line, oldValue: origText, newValue: textInput.value });
    }
    // Also catch inline-edited text changes (when no text-input is in the DOM)
    if (!textInput && origText !== undefined && el.firstChild?.nodeType === 3 && el.firstChild.textContent !== origText) {
      patches.push({ type: 'text', line, oldValue: origText, newValue: el.firstChild.textContent });
    }
    if (patches.length === 0) { setStatus('Nothing changed.'); return; }

    setStatus('Writing…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, patches }),
      });
      const data = await res.json();
      if (data.ok && data.entry) {
        setStatus('✓ Saved → ' + file);
        // Local undo stack mirrors the server entry — undo without round-trip noise
        state.undoStack.push({ el, file, line, entry: data.entry });
        state.redoStack = [];
        state.panel.dataset.origClass = el.className;
        if (textInput) state.panel.dataset.origText = textInput.value;
        else if (el.firstChild?.nodeType === 3) state.panel.dataset.origText = el.firstChild.textContent;
      } else if (data.ok) {
        setStatus('✓ Saved (no-op)');
      } else {
        setStatus('Error: ' + (data.error ?? 'unknown'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  function revert() {
    const el = state.currentEl;
    if (!el) return;
    el.className = state.panel.dataset.origClass ?? '';
    if (state.panel.dataset.origText !== undefined && el.firstChild) {
      el.firstChild.textContent = state.panel.dataset.origText;
    }
    renderTab();
    setStatus('Reverted unsaved changes.');
  }

  async function undo() {
    const item = state.undoStack.pop();
    if (!item) { setStatus('Nothing to undo.'); return; }
    setStatus('Undoing…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: item.file, patches: item.entry.inverse, label: 'Undo: ' + item.entry.label }),
      });
      const data = await res.json();
      if (data.ok) {
        state.redoStack.push(item);
        setStatus('↶ Undone');
        if (state.currentEl) {
          // Re-sync baseline from DOM so the next apply diffs correctly
          state.panel.dataset.origClass = state.currentEl.className;
          if (state.currentEl.firstChild?.nodeType === 3) {
            state.panel.dataset.origText = state.currentEl.firstChild.textContent;
          }
          renderTab();
        }
      } else {
        setStatus('Error: ' + (data.error ?? 'unknown'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  async function redo() {
    const item = state.redoStack.pop();
    if (!item) { setStatus('Nothing to redo.'); return; }
    setStatus('Redoing…');
    try {
      const res = await fetch(API + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: item.file, patches: item.entry.patches, label: 'Redo: ' + item.entry.label }),
      });
      const data = await res.json();
      if (data.ok) {
        state.undoStack.push(item);
        setStatus('↷ Redone');
        if (state.currentEl) {
          state.panel.dataset.origClass = state.currentEl.className;
          if (state.currentEl.firstChild?.nodeType === 3) {
            state.panel.dataset.origText = state.currentEl.firstChild.textContent;
          }
          renderTab();
        }
      } else {
        setStatus('Error: ' + (data.error ?? 'unknown'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  function setStatus(msg) {
    const s = state.panel?.querySelector('#__spoon-status');
    if (s) s.textContent = msg;
  }

  // ── UI atoms ──────────────────────────────────────────────────────────

  function section(title, accent) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '6px' });
    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, {
      fontSize: '10px', color: accent, fontWeight: '700',
      textTransform: 'uppercase', letterSpacing: '.08em',
    });
    wrap.appendChild(h);
    return wrap;
  }

  function buttonRow(label, options, onSelect, isActive) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    const lbl = document.createElement('span');
    lbl.textContent = label;
    Object.assign(lbl.style, { fontSize: '11px', color: '#a6adc8', width: '50px' });
    row.appendChild(lbl);
    const grp = document.createElement('div');
    Object.assign(grp.style, { display: 'flex', gap: '2px', background: '#11111b', borderRadius: '4px', padding: '2px', flexWrap: 'wrap' });
    for (const [val, text] of options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = val;
      const active = isActive(val);
      Object.assign(b.style, {
        background: active ? '#6366f1' : 'transparent',
        color: active ? '#fff' : '#a6adc8',
        border: 'none', borderRadius: '3px', padding: '3px 7px',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', minWidth: '24px',
      });
      b.onclick = () => onSelect(val);
      grp.appendChild(b);
    }
    row.appendChild(grp);
    return row;
  }

  function chip(text, accent, onRemove) {
    const c = document.createElement('span');
    Object.assign(c.style, {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      background: '#313244', color: '#cdd6f4',
      borderRadius: '4px', padding: '2px 6px', fontSize: '11px',
      borderLeft: \`2px solid \${accent}\`,
    });
    c.textContent = text;
    const x = document.createElement('button');
    x.textContent = '×';
    Object.assign(x.style, {
      background: 'none', border: 'none', color: '#585b70',
      cursor: 'pointer', padding: '0 0 0 2px', fontSize: '13px', lineHeight: '1',
    });
    x.onmouseenter = () => (x.style.color = '#f38ba8');
    x.onmouseleave = () => (x.style.color = '#585b70');
    x.onclick = onRemove;
    c.appendChild(x);
    return c;
  }

  // Common Tailwind classes per group — drives the +Add datalist
  // autocomplete. Not exhaustive; the input accepts any value including
  // arbitrary syntax like shadow-[20px_20px_20px_rgba(0,0,0,0.4)].
  const SUGGEST = {
    layout:     ['flex', 'grid', 'block', 'hidden', 'inline-flex', 'absolute', 'relative', 'fixed', 'sticky', 'items-center', 'items-start', 'items-end', 'justify-center', 'justify-between', 'justify-start', 'justify-end', 'flex-col', 'flex-row', 'gap-1', 'gap-2', 'gap-3', 'gap-4', 'gap-6', 'gap-8', 'z-10', 'z-50'],
    spacing:    ['p-1', 'p-2', 'p-3', 'p-4', 'p-6', 'p-8', 'px-2', 'px-4', 'px-6', 'py-1', 'py-2', 'py-3', 'py-4', 'm-2', 'm-4', 'mx-auto', 'mt-2', 'mt-4', 'mb-2', 'mb-4', 'space-y-2', 'space-y-4', 'space-x-2'],
    sizing:     ['w-full', 'w-auto', 'w-1/2', 'w-1/3', 'w-2/3', 'w-1/4', 'h-full', 'h-auto', 'h-screen', 'min-h-screen', 'max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-xl', 'max-w-2xl', 'aspect-square', 'aspect-video'],
    color:      ['bg-white', 'bg-black', 'bg-transparent', 'bg-primary', 'bg-secondary', 'bg-muted', 'bg-accent', 'text-white', 'text-black', 'text-primary', 'text-muted-foreground', 'border-border', 'border-primary'],
    typography: ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'font-light', 'font-normal', 'font-medium', 'font-semibold', 'font-bold', 'text-center', 'text-left', 'text-right', 'leading-tight', 'leading-relaxed', 'tracking-tight', 'tracking-wide', 'truncate', 'italic', 'uppercase'],
    effects:    ['rounded', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-full', 'shadow', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-2xl', 'shadow-none', 'opacity-0', 'opacity-50', 'opacity-75', 'cursor-pointer', 'transition', 'transition-all', 'duration-150', 'duration-300', 'hover:opacity-90', 'animate-pulse', 'animate-spin', 'border', 'border-2'],
    other:      [],
  };

  function addInput(el, groupId, refresh) {
    const wrap = document.createElement('span');
    Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center' });
    const w = document.createElement('input');
    w.type = 'text';
    w.placeholder = '+ add class';
    w.title = 'Enter a Tailwind class. Arbitrary values work too, e.g. shadow-[0_2px_10px_rgba(0,0,0,0.3)]';
    Object.assign(w.style, {
      background: 'transparent', border: '1px dashed #45475a',
      color: '#cdd6f4', borderRadius: '4px', padding: '2px 6px',
      fontSize: '11px', width: '110px', outline: 'none', fontFamily: 'inherit',
    });
    // Native datalist autocomplete — no extra deps, keyboard-friendly
    const listId = '__spoon-sug-' + groupId;
    w.setAttribute('list', listId);
    let dl = document.getElementById(listId);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = listId;
      for (const s of (SUGGEST[groupId] || [])) {
        const o = document.createElement('option');
        o.value = s;
        dl.appendChild(o);
      }
      document.body.appendChild(dl);
    }
    w.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && w.value.trim()) {
        addClass(el, w.value.trim());
        w.value = '';
        commit(el);
        refresh();
      }
    });
    wrap.appendChild(w);
    return wrap;
  }

  function colorSwatch(token, el, getMode, refresh) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      width: '26px', height: '26px', borderRadius: '5px',
      border: '1px solid #45475a', cursor: 'pointer', padding: '0',
      background: token.preview,
    });
    btn.title = \`\${token.name} → \${token.preview} (click to apply with current prefix)\`;
    btn.onclick = () => {
      const mode = typeof getMode === 'function' ? getMode() : 'bg';
      replacePrefixed(el, new RegExp('^' + mode + '-'), mode + '-' + token.name);
      commit(el);
      refresh();
    };
    return btn;
  }

  function inputStyle() {
    return {
      background: '#313244', border: '1px solid #45475a',
      color: '#cdd6f4', borderRadius: '5px', padding: '5px 8px',
      fontFamily: 'inherit', fontSize: '12px', outline: 'none',
      width: '100%', boxSizing: 'border-box',
    };
  }
  function selectStyle() {
    return {
      background: '#313244', border: '1px solid #45475a',
      color: '#cdd6f4', borderRadius: '5px', padding: '4px 6px',
      fontFamily: 'inherit', fontSize: '11px', outline: 'none',
    };
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  console.log('[spoon] loaded — press ' + HOTKEY + ' or click the ⟡ pin');
})();
`
}
