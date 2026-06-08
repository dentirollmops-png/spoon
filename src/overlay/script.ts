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
    root: null,
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

  // ── Spoon root & body-squeeze ─────────────────────────────────────────
  // Spoon's own UI lives in a container on <html>, NOT <body>. This keeps
  // it above everything (including the app's fixed modals) and immune to
  // the squeeze we apply to <body>.
  function ensureRoot() {
    if (state.root && document.documentElement.contains(state.root)) return state.root;
    const root = document.createElement('div');
    root.id = '__spoon-root';
    // The container itself is inert; children opt back into pointer events.
    Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none' });
    document.documentElement.appendChild(root);
    state.root = root;
    return root;
  }

  // Squeeze the app to make room for the panel. Applying a transform to
  // <body> turns it into the containing block for ALL its fixed-positioned
  // descendants — so the app's own fixed buttons/modals now resolve their
  // top/right/inset against the squeezed body box instead of the viewport.
  // That's what keeps them out from under the panel.
  function squeezeBody(pos, size, animate = true) {
    const b = document.body.style;
    b.transition = animate ? 'width 0.15s ease, height 0.15s ease' : 'none';
    b.transform = 'translateZ(0)';
    b.transformOrigin = 'top left';
    if (pos === 'right') {
      b.width = 'calc(100% - ' + size + 'px)';
      b.height = '';
      b.minHeight = '100vh';
      b.overflowX = 'hidden';
    } else if (pos === 'bottom') {
      b.width = '';
      b.height = 'calc(100vh - ' + size + 'px)';
      b.minHeight = '0';
      b.overflowY = 'auto';
    } else {
      unsqueezeBody();
    }
  }
  function unsqueezeBody() {
    const b = document.body.style;
    b.width = ''; b.height = ''; b.minHeight = '';
    b.transform = ''; b.transformOrigin = '';
    b.overflowX = ''; b.overflowY = '';
  }

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
    pin.style.pointerEvents = 'auto';
    pin.onclick = () => activate();
    ensureRoot().appendChild(pin);
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
      pointerEvents: 'auto',
      overflow: 'hidden', // body scrolls internally; panel clips to its box
      boxSizing: 'border-box',
    });
    panel.innerHTML =
      headerHtml() +
      tabBarHtml() +
      '<div id="__spoon-body" style="overflow-y:auto;overflow-x:hidden;flex:1 1 0;min-height:0;padding:12px 14px;display:flex;flex-direction:column;gap:14px;"></div>' +
      footerHtml();

    ensureRoot().appendChild(panel);
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
    unsqueezeBody();
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

    // remove old grip
    p.querySelector('#__spoon-grip')?.remove();

    if (pos === 'right') {
      Object.assign(p.style, { top: '0', right: '0', height: '100vh', width: state.panelWidth + 'px' });
      squeezeBody('right', state.panelWidth);
      addGrip(p, 'ew');
    } else if (pos === 'bottom') {
      Object.assign(p.style, { bottom: '0', left: '0', width: '100vw', height: state.panelHeight + 'px' });
      squeezeBody('bottom', state.panelHeight);
      addGrip(p, 'ns');
    } else if (pos === 'floating') {
      Object.assign(p.style, {
        top: state.floatPos.y + 'px', left: state.floatPos.x + 'px',
        width: state.panelWidth + 'px', height: '60vh',
        borderRadius: '10px',
      });
      // Floating doesn't squeeze — it overlaps; user positions it freely.
      unsqueezeBody();
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
        squeezeBody('right', next, false); // no transition while dragging
      } else {
        const next = Math.max(180, Math.min(window.innerHeight - 100, startH + (start - ev.clientY)));
        state.panelHeight = next;
        state.panel.style.height = next + 'px';
        squeezeBody('bottom', next, false);
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
    return \`<div style="flex-shrink:0;">
      <div id="__spoon-status" style="display:none;padding:8px 12px;background:#181825;border-top:1px solid #313244;font-size:11px;line-height:1.4;color:#a6e3a1;white-space:normal;word-break:break-word;"></div>
      <div style="padding:8px 12px;background:#181825;border-top:1px solid #313244;display:flex;gap:6px;align-items:center;">
        <button id="__spoon-undo" title="Undo (Cmd+Z)" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:5px 9px;cursor:pointer;font-size:13px">↶</button>
        <button id="__spoon-redo" title="Redo (Cmd+Shift+Z)" style="background:#313244;color:#cdd6f4;border:none;border-radius:4px;padding:5px 9px;cursor:pointer;font-size:13px">↷</button>
        <div style="flex:1"></div>
        <button id="__spoon-apply" title="Force-save now (changes auto-save on edit)" style="background:#6366f1;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:11px;font-weight:600">Save now</button>
      </div>
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
    // Editable if there's any direct text node (covers <button><Icon/>Label</button>)
    if (!getTextNode(el)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(el);
    inlineEditText(el);
  }

  function inlineEditText(el) {
    const textNode = getTextNode(el);
    if (!textNode) return;
    const orig = textNode.textContent;

    // contenteditable on the whole element keeps icons/children intact;
    // we read back only the text node afterwards.
    el.setAttribute('contenteditable', 'true');
    el._spoonOldOutline = el.style.outline;
    el.style.outline = '2px dashed #f9e2af';
    el.focus();
    // Select just the text node so the user types over the label, not the icon
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const finish = (save) => {
      el.removeAttribute('contenteditable');
      el.style.outline = el._spoonOldOutline || '';
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      const liveNode = getTextNode(el);
      const next = liveNode?.textContent ?? '';
      if (save && next !== orig) {
        state.panel.dataset.origText = orig;
        writeText(el, next);
      } else if (!save && liveNode) {
        liveNode.textContent = orig;
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
    const tn = getTextNode(el);
    if (tn) state.panel.dataset.origText = tn.textContent;
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
    // Disambiguate text-: size/alignment → typography, otherwise → color
    if (bare.startsWith('text-')) {
      return TEXT_NON_COLOR.test(bare) || /^text-(opacity|wrap|nowrap)/.test(bare) ? 'typography' : 'color';
    }
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

  // text- size/alignment/leading tokens that are NOT colors
  const TEXT_NON_COLOR = /^text-(xs|sm|base|lg|xl|\\dxl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
  // A text- class is a color if it's text- but not one of the above
  const TEXT_COLOR_RE = /^text-(?!xs$|sm$|base$|lg$|xl$|\\dxl$|left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$)/;

  // Returns the first non-empty direct text node, or null. Works for
  // <button><Icon/>Label</button> where the text isn't the only child.
  function getTextNode(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim() !== '') return n;
    }
    return null;
  }

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
    // Text editor at top, if element has any editable direct text node
    if (getTextNode(el)) {
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
    const tn = getTextNode(el);
    input.value = tn?.textContent ?? '';
    Object.assign(input.style, inputStyle());
    input.dataset.role = 'text-input';
    input.addEventListener('input', () => {
      const live = getTextNode(el);
      if (live) live.textContent = input.value;
      writeTextDebounced(el, input.value);
    });
    wrap.appendChild(input);
    return wrap;
  }

  let textDebounceTimer = null;
  function writeTextDebounced(el, text, ms = 500) {
    clearTimeout(textDebounceTimer);
    textDebounceTimer = setTimeout(() => writeText(el, text), ms);
  }

  // ── Layout section: Display + Alignment (Phase 3.2 — placeholder UI) ──

  function layoutSection(el) {
    const wrap = section('Layout', GROUP_META.layout.color);

    // Show the *effective* display: explicit class wins, else computed style.
    const computedDisplay = getComputedStyle(el).display;
    const displayClassMap = { block: 'block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-block': 'inline-block', none: 'hidden' };
    const explicitDisplay = classList(el).find((c) => /^(block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|table|contents|flow-root)$/.test(c));
    const effectiveDisplay = explicitDisplay || displayClassMap[computedDisplay] || computedDisplay;

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
    }, (val) => val === effectiveDisplay);
    wrap.appendChild(displayRow);
    // Hint when the active display is inherited rather than set by a class
    if (!explicitDisplay) {
      const hint = document.createElement('div');
      hint.textContent = 'current: ' + computedDisplay + ' (from CSS, not a class)';
      Object.assign(hint.style, { fontSize: '10px', color: '#585b70', fontStyle: 'italic' });
      wrap.appendChild(hint);
    }

    const cur = classList(el);
    const isFlex = cur.includes('flex') || cur.includes('inline-flex') || computedDisplay === 'flex';
    if (isFlex) {
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
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });

    const lbl = document.createElement('span');
    lbl.textContent = label;
    Object.assign(lbl.style, { fontSize: '11px', color: '#a6adc8', width: '50px' });
    row.appendChild(lbl);

    // Parse the existing class (w-full / w-1/2 / w-[124px] / w-64 / none)
    const cur = findPrefixed(el, new RegExp('^' + dim + '-'));
    let mode = 'auto';
    if (cur) {
      if (/-(full|screen|min|max|fit)$/.test(cur)) mode = 'fill';
      else if (/\\[.+\\]/.test(cur)) mode = 'fixed';
      else if (cur !== dim + '-auto') mode = 'preset';
    }

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
    // Pre-fill from the current class so the user sees the real value
    if (mode === 'fixed' && cur) valueInput.value = cur.match(/\\[(.+)\\]/)?.[1] ?? '';
    else if (mode === 'preset' && cur) valueInput.value = cur.replace(dim + '-', '');
    else if (mode === 'fill' && cur) valueInput.value = cur.replace(dim + '-', '');
    Object.assign(valueInput.style, { ...inputStyle(), flex: '1', minWidth: '70px' });

    // Live computed pixel value so the user always knows the actual size + unit
    const computed = document.createElement('span');
    const px = getComputedStyle(el)[dim === 'w' ? 'width' : 'height'];
    computed.textContent = '= ' + px;
    Object.assign(computed.style, { fontSize: '10px', color: '#6c7086', width: '100%', paddingLeft: '56px' });

    const syncPlaceholder = () => {
      const m = modeSel.value;
      valueInput.placeholder =
        m === 'fixed' ? 'e.g. 124px, 20rem, 50%' :
        m === 'preset' ? 'e.g. 64, 1/2, full' :
        m === 'fill' ? 'full / screen / fit' : '—';
      valueInput.style.display = m === 'auto' ? 'none' : '';
    };
    syncPlaceholder();

    const update = () => {
      const m = modeSel.value;
      const re = new RegExp('^' + dim + '-');
      let changed = true;
      if (m === 'auto') { replacePrefixed(el, re, dim + '-auto'); }
      else if (m === 'fill') { replacePrefixed(el, re, dim + '-' + (valueInput.value.trim() || 'full')); }
      else if (m === 'preset') {
        const v = valueInput.value.trim();
        if (v) replacePrefixed(el, re, dim + '-' + v); else changed = false;
      } else if (m === 'fixed') {
        const v = valueInput.value.trim();
        // Tailwind arbitrary value: spaces must be underscores
        if (v) replacePrefixed(el, re, dim + '-[' + v.replace(/\\s+/g, '_') + ']'); else changed = false;
      }
      if (changed) { commit(el); setTimeout(renderTab, 150); }
    };
    modeSel.addEventListener('change', () => { syncPlaceholder(); if (modeSel.value === 'auto') update(); });
    valueInput.addEventListener('change', update);
    valueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') update(); });

    row.appendChild(valueInput);
    row.appendChild(computed);
    return row;
  }

  // ── Spacing-Box (Phase 3.1 — placeholder, filled in next commit) ──────

  // Read the current Tailwind value for a spacing side, checking specific
  // side → axis → all, e.g. for padding-top: pt-* then py-* then p-*.
  function readSpacing(el, prop, side) {
    const cls = classList(el);
    const p = prop; // 'p' or 'm'
    const axisOf = { t: 'y', b: 'y', l: 'x', r: 'x' };
    const specific = cls.find((c) => new RegExp('^-?' + p + side + '-').test(c));
    if (specific) return specific.replace(new RegExp('^(-?' + p + side + '-)'), '');
    const axis = cls.find((c) => new RegExp('^-?' + p + axisOf[side] + '-').test(c));
    if (axis) return axis.replace(new RegExp('^(-?' + p + axisOf[side] + '-)'), '');
    const all = cls.find((c) => new RegExp('^-?' + p + '-').test(c));
    if (all) return all.replace(new RegExp('^(-?' + p + '-)'), '');
    return '';
  }

  function writeSpacing(el, prop, side, value) {
    // Remove any class affecting this side (specific, axis, all) then set specific.
    const axisOf = { t: 'y', b: 'y', l: 'x', r: 'x' };
    const re = new RegExp('^-?' + prop + '(' + side + '|' + axisOf[side] + '|)-');
    const next = classList(el).filter((c) => !re.test(c));
    if (value !== '') next.push(prop + side + '-' + value);
    setClassList(el, next);
    commit(el);
  }

  function spacingSection(el) {
    const wrap = section('Spacing — margin / padding', GROUP_META.spacing.color);

    // Nested box: outer = margin, inner = padding, like Webflow/Figma.
    const outer = document.createElement('div');
    Object.assign(outer.style, {
      position: 'relative', background: '#181825', border: '1px solid #313244',
      borderRadius: '6px', padding: '26px', textAlign: 'center',
    });
    tag(outer, 'MARGIN', '4px', '6px', '#585b70');

    const inner = document.createElement('div');
    Object.assign(inner.style, {
      position: 'relative', background: '#11111b', border: '1px solid #45475a',
      borderRadius: '4px', padding: '26px',
    });
    tag(inner, 'PADDING', '3px', '5px', '#585b70');
    const center = document.createElement('div');
    Object.assign(center.style, { height: '14px', background: '#313244', borderRadius: '3px' });
    inner.appendChild(center);

    // margin inputs on the outer box (4 sides)
    spacingField(outer, el, 'm', 't', 'top');
    spacingField(outer, el, 'm', 'b', 'bottom');
    spacingField(outer, el, 'm', 'l', 'left');
    spacingField(outer, el, 'm', 'r', 'right');
    // padding inputs on the inner box
    spacingField(inner, el, 'p', 't', 'top');
    spacingField(inner, el, 'p', 'b', 'bottom');
    spacingField(inner, el, 'p', 'l', 'left');
    spacingField(inner, el, 'p', 'r', 'right');

    outer.appendChild(inner);
    wrap.appendChild(outer);

    const hint = document.createElement('div');
    hint.textContent = 'Tailwind scale (0–16…) or arbitrary like 12px. Empty = none.';
    Object.assign(hint.style, { fontSize: '10px', color: '#585b70' });
    wrap.appendChild(hint);
    return wrap;
  }

  function tag(box, text, top, left, color) {
    const t = document.createElement('span');
    t.textContent = text;
    Object.assign(t.style, { position: 'absolute', top, left, fontSize: '8px', letterSpacing: '.08em', color });
    box.appendChild(t);
  }

  function spacingField(box, el, prop, side, sideName) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = readSpacing(el, prop, side);
    inp.title = prop === 'm' ? 'margin-' + sideName : 'padding-' + sideName;
    const pos = {
      t: { top: '4px', left: '50%', transform: 'translateX(-50%)' },
      b: { bottom: '4px', left: '50%', transform: 'translateX(-50%)' },
      l: { left: '4px', top: '50%', transform: 'translateY(-50%)' },
      r: { right: '4px', top: '50%', transform: 'translateY(-50%)' },
    }[side];
    Object.assign(inp.style, {
      position: 'absolute', width: '30px', textAlign: 'center',
      background: '#1e1e2e', border: '1px solid #45475a', color: '#cdd6f4',
      borderRadius: '3px', padding: '2px 0', fontSize: '11px', fontFamily: 'inherit',
      outline: 'none', ...pos,
    });
    const apply = () => writeSpacing(el, prop, side, inp.value.trim());
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    box.appendChild(inp);
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

  // Which CSS property does each color mode read/affect?
  const COLOR_MODE_CSS = { bg: 'backgroundColor', text: 'color', border: 'borderColor', ring: 'outlineColor' };

  // Tailwind-shaped class? (rough: known prefixes or arbitrary [..] values)
  const TW_SHAPE = /^(-?(p|m|w|h|gap|space|text|bg|border|ring|rounded|flex|grid|items|justify|font|leading|tracking|shadow|opacity|z|inset|top|right|bottom|left|col|row|order|object|overflow|cursor|transition|duration|ease|animate|translate|rotate|scale|min|max|aspect|self|place|basis|grow|shrink|divide|from|via|to|fill|stroke|backdrop|blur|brightness)([-\\[]|$))|^(block|inline|inline-block|inline-flex|hidden|absolute|relative|fixed|sticky|static|truncate|italic|uppercase|lowercase|capitalize|underline|container|antialiased)$/;

  // Find a custom (non-Tailwind) class that actually contributes the element's
  // background color or gradient — by temporarily removing each candidate and
  // checking whether the computed background changes.
  // IMPORTANT: classList.remove/add reorders the class string (moves the class
  // to the end), which would corrupt later className diffs. We snapshot the
  // exact className and restore it verbatim afterwards.
  function findCustomBgClass(el) {
    const original = el.getAttribute('class');
    const before = getComputedStyle(el);
    const beforeKey = before.backgroundColor + '|' + before.backgroundImage;
    const candidates = classList(el).filter((c) => !TW_SHAPE.test(c));
    let found = null;
    for (const c of candidates) {
      el.classList.remove(c);
      const after = getComputedStyle(el);
      const afterKey = after.backgroundColor + '|' + after.backgroundImage;
      el.classList.add(c);
      if (afterKey !== beforeKey) { found = c; break; }
    }
    // Restore the exact original class string (order included)
    if (original !== null && el.getAttribute('class') !== original) {
      el.setAttribute('class', original);
    }
    return found;
  }

  function colorSection(el) {
    const meta = GROUP_META.color;
    const wrap = section(meta.label, meta.color);

    let activeMode = state._colorMode || 'bg';

    // ── Mode picker: BG / TEXT / BORDER / RING ──
    const modeWrap = document.createElement('div');
    Object.assign(modeWrap.style, { display: 'flex', gap: '4px', alignItems: 'center' });
    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'Edit';
    Object.assign(modeLbl.style, { fontSize: '10px', color: '#585b70', width: '40px', textTransform: 'uppercase', letterSpacing: '.06em' });
    modeWrap.appendChild(modeLbl);
    const modes = ['bg', 'text', 'border', 'ring'];
    const modeBtns = [];
    const grp = document.createElement('div');
    Object.assign(grp.style, { display: 'flex', gap: '2px', background: '#11111b', borderRadius: '4px', padding: '2px' });
    for (const m of modes) {
      const b = document.createElement('button');
      b.textContent = m.toUpperCase();
      Object.assign(b.style, {
        background: 'transparent', color: '#a6adc8', border: 'none',
        borderRadius: '3px', padding: '3px 8px', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: '10px', fontWeight: '600',
      });
      b.onclick = () => { activeMode = m; state._colorMode = m; rerender(); };
      modeBtns.push(b);
      grp.appendChild(b);
    }
    modeWrap.appendChild(grp);
    wrap.appendChild(modeWrap);

    // ── Current-color readout: swatch + value + source ──
    const readout = document.createElement('div');
    Object.assign(readout.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px', background: '#181825', borderRadius: '6px',
      border: '1px solid #313244',
    });
    wrap.appendChild(readout);

    // ── Native color picker for arbitrary values ──
    const pickerRow = document.createElement('div');
    Object.assign(pickerRow.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    wrap.appendChild(pickerRow);

    // ── Theme token swatches ──
    const tokWrap = document.createElement('div');
    wrap.appendChild(tokWrap);

    // ── Raw color-class chips ──
    const chipRow = document.createElement('div');
    Object.assign(chipRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
    wrap.appendChild(chipRow);

    const rerender = () => {
      // highlight active mode
      modeBtns.forEach((b, i) => {
        const on = modes[i] === activeMode;
        b.style.background = on ? '#6366f1' : 'transparent';
        b.style.color = on ? '#fff' : '#a6adc8';
      });

      const cssProp = COLOR_MODE_CSS[activeMode];
      const cs = getComputedStyle(el);
      const computed = cs[cssProp];
      // Gradients/images live in background-image, not background-color.
      const bgImage = cs.backgroundImage;
      const hasGradient = activeMode === 'bg' && bgImage && bgImage !== 'none' && /gradient/.test(bgImage);

      // Detect the source of the current color
      const colorRe = activeMode === 'text' ? TEXT_COLOR_RE : new RegExp('^' + activeMode + '-');
      const activeClass = classList(el).find((c) => colorRe.test(c));
      const inlineStyleProp = { bg: 'background', text: 'color', border: 'borderColor', ring: 'outlineColor' };
      const inlineVal = el.style[inlineStyleProp[activeMode]] || (activeMode === 'bg' && el.style.backgroundColor);

      // Find a non-Tailwind (custom) class that owns this background — e.g.
      // .btn-primary setting a gradient.
      const customColorClass = activeMode === 'bg' ? findCustomBgClass(el) : null;

      let source;
      if (activeClass) source = 'class: ' + activeClass;
      else if (hasGradient && customColorClass) source = 'gradient via .' + customColorClass;
      else if (hasGradient) source = 'gradient (CSS)';
      else if (inlineVal) source = 'inline style';
      else if (customColorClass) source = 'CSS class .' + customColorClass;
      else source = 'inherited / CSS';

      // readout
      readout.innerHTML = '';
      const sw = document.createElement('div');
      Object.assign(sw.style, {
        width: '28px', height: '28px', borderRadius: '5px',
        border: '1px solid #45475a', flexShrink: '0',
        background: hasGradient ? bgImage : computed,
      });
      readout.appendChild(sw);
      const info = document.createElement('div');
      Object.assign(info.style, { display: 'flex', flexDirection: 'column', gap: '1px', overflow: 'hidden', flex: '1' });
      info.innerHTML =
        '<span style="color:#cdd6f4;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(hasGradient ? 'gradient' : computed) + '</span>' +
        '<span style="color:#6c7086;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(source) + '</span>';
      readout.appendChild(info);

      // When the color comes from a custom CSS class or gradient, a Tailwind
      // bg- class can't override it. Offer to edit the source class instead.
      // When the color is owned by an inline style, a gradient, or a custom
      // CSS class, a Tailwind utility can't override it — so we write the
      // inline style prop instead. The CSS property name for each mode:
      const styleProp = { bg: 'background', text: 'color', border: 'border-color', ring: 'outline-color' }[activeMode];
      const needsInline = !!(inlineVal || hasGradient || (customColorClass && activeMode === 'bg'));

      if (needsInline) {
        const badge = document.createElement('div');
        badge.textContent = '⚠ inline';
        badge.title = 'This color comes from ' + (hasGradient ? 'a gradient' : inlineVal ? 'an inline style' : 'a custom CSS class .' + customColorClass) + ', which Tailwind classes can\\'t override. The picker below writes the inline style prop directly.';
        Object.assign(badge.style, { marginLeft: 'auto', color: '#f9e2af', fontSize: '10px', cursor: 'help', flexShrink: '0' });
        readout.appendChild(badge);
      }

      // picker
      pickerRow.innerHTML = '';
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = rgbToHex(computed);
      Object.assign(picker.style, { width: '36px', height: '28px', border: '1px solid #45475a', borderRadius: '5px', background: '#181825', cursor: 'pointer', padding: '2px' });
      picker.addEventListener('change', () => {
        if (needsInline) {
          // Overrides gradient/inline/custom-class by writing the style prop.
          writeStyleProp(el, styleProp, picker.value);
        } else {
          replacePrefixed(el, colorRe, activeMode + '-[' + picker.value + ']');
          commit(el);
        }
        setTimeout(rerender, 150);
      });
      pickerRow.appendChild(picker);
      const pickerLbl = document.createElement('span');
      pickerLbl.textContent = needsInline ? 'Set ' + activeMode + ' (inline)' : 'Custom ' + activeMode + ' color';
      Object.assign(pickerLbl.style, { fontSize: '11px', color: '#a6adc8' });
      pickerRow.appendChild(pickerLbl);
      if (activeClass) {
        const clr = document.createElement('button');
        clr.textContent = 'clear';
        Object.assign(clr.style, { marginLeft: 'auto', background: '#313244', color: '#cdd6f4', border: 'none', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit' });
        clr.onclick = () => { replacePrefixed(el, colorRe, ''); commit(el); setTimeout(rerender, 120); };
        pickerRow.appendChild(clr);
      } else if (inlineVal) {
        const clr = document.createElement('button');
        clr.textContent = 'clear inline';
        clr.title = 'Remove the inline ' + styleProp + ' so Tailwind classes can take effect again';
        Object.assign(clr.style, { marginLeft: 'auto', background: '#313244', color: '#cdd6f4', border: 'none', borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit' });
        clr.onclick = () => { writeStyleProp(el, styleProp, ''); setTimeout(rerender, 150); };
        pickerRow.appendChild(clr);
      }

      // theme tokens
      tokWrap.innerHTML = '';
      if (state.tokens.colors && state.tokens.colors.length > 0) {
        const lbl = document.createElement('div');
        lbl.textContent = 'Theme tokens';
        Object.assign(lbl.style, { fontSize: '10px', color: '#585b70', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '.06em' });
        tokWrap.appendChild(lbl);
        const swatches = document.createElement('div');
        Object.assign(swatches.style, { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))', gap: '4px' });
        for (const tk of state.tokens.colors) {
          const tokenClass = activeMode + '-' + tk.name;
          const isActive = activeClass === tokenClass;
          swatches.appendChild(colorSwatch(tk, isActive, () => {
            if (needsInline) {
              // Use the CSS-var so it tracks theme/dark-mode, not the resolved hex.
              writeStyleProp(el, styleProp, 'hsl(var(--' + tk.varName + '))');
            } else {
              replacePrefixed(el, colorRe, tokenClass);
              commit(el);
            }
            setTimeout(rerender, 150);
          }));
        }
        tokWrap.appendChild(swatches);
      }

      // raw chips
      chipRow.innerHTML = '';
      const groups = parseClasses(el.className);
      for (const cls of groups.color) {
        chipRow.appendChild(chip(cls, meta.color, () => { removeClass(el, cls); commit(el); rerender(); }));
      }
      chipRow.appendChild(addInput(el, 'color', rerender));
    };

    rerender();
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

    if (getTextNode(el)) {
      const txt = section('Text', '#f9e2af');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = getTextNode(el)?.textContent ?? '';
      input.dataset.role = 'text-input';
      Object.assign(input.style, inputStyle());
      input.addEventListener('input', () => { const n = getTextNode(el); if (n) n.textContent = input.value; writeTextDebounced(el, input.value); });
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
    if (entry.marker || !entry.inverse || !entry.loc) {
      setStatus('Marker entry — nothing to restore.');
      return;
    }
    setStatus('Restoring…');
    try {
      const data = await writeOp(entry.file, entry.loc, entry.inverse, 'Restore @ ' + new Date(entry.ts).toLocaleTimeString());
      if (data.ok) setStatus('✓ Restored to before "' + entry.label + '"');
      else setStatus('⚠ ' + (data.error ?? 'restore failed'));
      renderTab();
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  // ── Apply / Revert / Undo / Redo ──────────────────────────────────────

  // Parse "src/App.tsx:42:6" → { file, loc:{line,column} }
  function parseLoc(spoonLoc) {
    const parts = spoonLoc.split(':');
    const column = Number(parts.pop());
    const line = Number(parts.pop());
    const file = parts.join(':');
    return { file, loc: { line, column } };
  }

  async function writeOp(file, loc, op, label) {
    const res = await fetch(API + '/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, loc, op, label }),
    });
    return res.json();
  }

  // Write a single inline style property straight to the JSX style={{...}}.
  // Used when a color comes from an inline style/gradient that no class can
  // override. Applies optimistically to the DOM, then persists.
  async function writeStyleProp(el, prop, value) {
    const { file, loc } = parseLoc(el.dataset.spoonLoc);
    // Snapshot the inline style so we can roll back if the write doesn't stick.
    const prevInline = el.style.getPropertyValue(prop);
    // optimistic DOM update so the preview reflects immediately
    if (value === '') el.style.removeProperty(prop);
    else el.style.setProperty(prop, value);
    setStatus('Saving…');
    try {
      const data = await writeOp(file, loc, { style: { prop, value } });
      if (data.ok && data.entry) {
        setStatus('✓ Saved style.' + prop);
        state.undoStack.push(data.entry);
        state.redoStack = [];
        return true;
      }
      // Write failed or was a no-op → the source did NOT change. Revert the
      // optimistic DOM edit so the preview matches what's actually on disk
      // and the user isn't misled into thinking it saved.
      if (prevInline) el.style.setProperty(prop, prevInline);
      else el.style.removeProperty(prop);
      if (data.ok) {
        setStatus('No change written (source unchanged).');
      } else {
        const dyn = /dynamic expression/.test(data.error || '');
        setStatus('⚠ ' + (data.error ?? 'could not edit style') + (dyn ? ' — use a Claude task to rewrite it.' : ''));
      }
      return false;
    } catch (err) {
      if (prevInline) el.style.setProperty(prop, prevInline);
      else el.style.removeProperty(prop);
      setStatus('Network error: ' + err.message);
      return false;
    }
  }

  // Dedicated text-only write. Kept separate from className edits because for
  // components the DOM className is the *merged* class list (e.g. SheetTitle
  // renders "text-lg font-semibold text-foreground"), which must never be
  // written back over the source's "text-lg". Text has no such ambiguity.
  async function writeText(el, text) {
    const { file, loc } = parseLoc(el.dataset.spoonLoc);
    const origText = state.panel.dataset.origText;
    if (origText !== undefined && text === origText) { setStatus('Nothing changed.'); return; }
    setStatus('Saving…');
    try {
      const data = await writeOp(file, loc, { text });
      if (data.ok && data.entry) {
        setStatus('✓ Saved text → ' + file.split('/').slice(-1));
        state.undoStack.push(data.entry);
        state.redoStack = [];
        state.panel.dataset.origText = text;
      } else if (data.ok) {
        setStatus('No change needed.');
      } else {
        setStatus('⚠ ' + (data.error ?? 'could not edit text'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  async function applyEdits(el) {
    const { file, loc } = parseLoc(el.dataset.spoonLoc);
    const origClass = state.panel.dataset.origClass ?? '';
    const origText = state.panel.dataset.origText;

    const op = {};
    if (el.className !== origClass) op.className = el.className;

    // Text can come from the panel input or from an inline contenteditable edit
    const textInput = state.panel.querySelector('[data-role="text-input"]');
    const tn = getTextNode(el);
    const domText = tn ? tn.textContent : undefined;
    const newText = textInput ? textInput.value : domText;
    if (origText !== undefined && newText !== undefined && newText !== origText) {
      op.text = newText;
    }

    if (Object.keys(op).length === 0) { setStatus('Nothing changed.'); return; }

    setStatus('Saving…');
    try {
      const data = await writeOp(file, loc, op);
      if (data.ok && data.entry) {
        setStatus('✓ Saved → ' + file.split('/').slice(-1));
        state.undoStack.push(data.entry);
        state.redoStack = [];
        // Rebase baselines to the just-saved state
        state.panel.dataset.origClass = el.className;
        if (op.text !== undefined) state.panel.dataset.origText = op.text;
      } else if (data.ok) {
        setStatus('No change needed.');
      } else {
        // 422 = AST couldn't safely edit (dynamic className etc.)
        setStatus('⚠ ' + (data.error ?? 'could not edit'));
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  async function undo() {
    const entry = state.undoStack.pop();
    if (!entry) { setStatus('Nothing to undo.'); return; }
    setStatus('Undoing…');
    try {
      const data = await writeOp(entry.file, entry.loc, entry.inverse, 'Undo: ' + entry.label);
      if (data.ok) {
        state.redoStack.push(entry);
        setStatus('↶ Undone — reloading…');
        resyncBaseline();
      } else {
        setStatus('⚠ ' + (data.error ?? 'undo failed'));
        state.undoStack.push(entry); // put it back
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  async function redo() {
    const entry = state.redoStack.pop();
    if (!entry) { setStatus('Nothing to redo.'); return; }
    setStatus('Redoing…');
    try {
      const data = await writeOp(entry.file, entry.loc, entry.op, 'Redo: ' + entry.label);
      if (data.ok) {
        state.undoStack.push(entry);
        setStatus('↷ Redone — reloading…');
        resyncBaseline();
      } else {
        setStatus('⚠ ' + (data.error ?? 'redo failed'));
        state.redoStack.push(entry);
      }
    } catch (err) {
      setStatus('Network error: ' + err.message);
    }
  }

  // After undo/redo the file changed on disk; HMR will reload the module.
  // We can't reliably re-find the same DOM node post-reload, so just refresh
  // the panel baselines from whatever is currently selected.
  function resyncBaseline() {
    if (!state.currentEl) return;
    state.panel.dataset.origClass = state.currentEl.className;
    const tn = getTextNode(state.currentEl);
    if (tn) state.panel.dataset.origText = tn.textContent;
    renderTab();
  }

  let statusTimer = null;
  function setStatus(msg) {
    const s = state.panel?.querySelector('#__spoon-status');
    if (!s) return;
    clearTimeout(statusTimer);
    if (!msg) { s.style.display = 'none'; s.textContent = ''; return; }
    s.textContent = msg;
    s.style.display = 'block';
    // Warnings/errors stay; transient success messages auto-hide.
    const isWarn = /^[⚠✗]|error|could not|dynamic|unchanged/i.test(msg);
    s.style.color = isWarn ? '#f9e2af' : '#a6e3a1';
    if (!isWarn) {
      statusTimer = setTimeout(() => { s.style.display = 'none'; s.textContent = ''; }, 4000);
    }
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
      ensureRoot().appendChild(dl);
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

  function colorSwatch(token, isActive, onClick) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      width: '100%', aspectRatio: '1', borderRadius: '5px',
      border: isActive ? '2px solid #6366f1' : '1px solid #45475a',
      cursor: 'pointer', padding: '0', background: token.preview,
      boxShadow: isActive ? '0 0 0 2px rgba(99,102,241,0.3)' : 'none',
    });
    btn.title = \`\${token.name} → \${token.preview}\`;
    btn.onclick = onClick;
    return btn;
  }

  // Normalise any computed color (rgb/rgba) to #rrggbb for <input type=color>.
  function rgbToHex(color) {
    if (!color) return '#000000';
    if (color[0] === '#') return color.length === 4
      ? '#' + color.slice(1).split('').map((c) => c + c).join('')
      : color.slice(0, 7);
    const m = color.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return '#000000';
    const [r, g, b] = m[1].split(',').map((x) => parseInt(x.trim(), 10));
    const hex = (n) => Math.max(0, Math.min(255, n || 0)).toString(16).padStart(2, '0');
    return '#' + hex(r) + hex(g) + hex(b);
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
