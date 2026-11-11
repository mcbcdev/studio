/*
 * Bedrock Script API IntelliSense for .js files (CodeMirror 5).
 *
 * The heavy work (TypeScript language service + the official @minecraft/* declaration files) runs in a
 * Web Worker: js/script-api/ts-worker.js. This file connects it to the editor:
 *
 *   - autocomplete (auto popup + ctrl/cmd+space), with documentation next to the list and auto-imports
 *   - hover documentation, parameter hints while typing a call (ctrl/cmd+shift+space to force)
 *   - diagnostics through CodeMirror's lint addon (merged with the existing JSHint warnings)
 *   - a small "Script API" pill (bottom right of every .js editor) to switch between Stable and Beta definitions
 *
 * Only .js files are touched. If the worker cannot start (offline on first visit, blocked workers, ...) the
 * editor keeps working exactly like before: JSHint only.
 */
(function (window) {
  'use strict';

  const CHANNEL_KEY = 'studio_script_api_channel_v1';
  const SCRIPT_BASE = (function () {
    const current = document.currentScript && document.currentScript.src;
    return new URL('script-api/', current || new URL('./js/', document.baseURI).href).href;
  })();
  const JSHINT_OPTIONS = { esversion: 11, asi: true, undef: false, unused: false };

  const attached = new Map(); // cm -> state
  const KIND_LETTERS = {
    method: 'm', function: 'f', 'local function': 'f', property: 'p', getter: 'p', setter: 'p', class: 'C', interface: 'I',
    enum: 'E', 'enum member': 'e', var: 'v', let: 'v', const: 'v', 'local var': 'v', parameter: 'a', module: 'M',
    'external module name': 'M', alias: 'A', type: 'T', 'type parameter': 'T', keyword: 'k', string: 's', directory: 'd',
    script: 'j', 'primitive type': 'T', constructor: 'c', 'call': 'f', 'index': 'i', 'warning': '!'
  };

  // ------------------------------------------------------------------ small helpers

  const isScriptFile = name => /\.(?:js|mjs)$/i.test(String(name || ''));
  const esc = text => String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function markdown(text) {
    text = String(text || '')
      .replace(/\{@link\s+([^}|]+?)\s*\|\s*([^}]+?)\s*\}/g, '`$2`')
      .replace(/\{@link\s+([^}]+?)\s*\}/g, (m, name) => '`' + name.replace(/^minecraft[a-z]*\./, '') + '`');
    let html;
    try {
      html = window.marked && typeof window.marked.parse === 'function' ? window.marked.parse(text, { mangle: false, headerIds: false }) : esc(text).replace(/\n/g, '<br>');
    } catch (_) { html = esc(text).replace(/\n/g, '<br>'); }
    if (window.DOMPurify) html = window.DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p', 'br', 'code', 'pre', 'em', 'strong', 'ul', 'ol', 'li', 'a', 'span', 'blockquote', 'h1', 'h2', 'h3', 'h4'], ALLOWED_ATTR: ['href', 'class'] });
    else html = esc(text).replace(/\n/g, '<br>');
    return html;
  }

  function quoteStyle(text) {
    const m = /\bfrom\s*(['"])/.exec(text) || /\brequire\(\s*(['"])/.exec(text);
    if (m) return m[1];
    const sample = text.slice(0, 6000);
    const singles = (sample.match(/'/g) || []).length;
    const doubles = (sample.match(/"/g) || []).length;
    return singles > doubles ? "'" : '"';
  }

  // ------------------------------------------------------------------ worker client

  const client = {
    worker: null,
    nextId: 1,
    pending: new Map(),
    status: 'idle',      // idle | loading | ready | error
    error: '',
    info: null,
    readyPromise: null,
    listeners: new Set(),

    emit() { this.listeners.forEach(fn => { try { fn(); } catch (_) { /* a broken listener must not break others */ } }); },
    setStatus(status, error) { this.status = status; this.error = error || ''; this.emit(); },

    start() {
      if (this.readyPromise) return this.readyPromise;
      this.setStatus('loading');
      this.readyPromise = new Promise((resolve, reject) => {
        try {
          this.worker = new Worker(SCRIPT_BASE + 'ts-worker.js');
        } catch (error) { reject(error); return; }
        this.worker.onmessage = event => {
          const msg = event.data || {};
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.ok) entry.resolve(msg.result); else entry.reject(new Error(msg.error));
        };
        this.worker.onerror = event => {
          const message = (event && event.message) || 'The Script API worker failed to start';
          this.pending.forEach(entry => entry.reject(new Error(message)));
          this.pending.clear();
          reject(new Error(message));
        };
        this.send('init', { base: SCRIPT_BASE, tsUrl: SCRIPT_BASE + 'typescript.min.js' }).then(resolve, reject);
      }).then(async info => {
        let wanted = null;
        try { wanted = localStorage.getItem(CHANNEL_KEY); } catch (_) { wanted = null; }
        if (wanted && wanted !== info.channel && info.channels.some(c => c.id === wanted)) info = await this.send('setChannel', { channel: wanted });
        this.info = info;
        this.setStatus('ready');
        return info;
      }).catch(error => {
        this.setStatus('error', String((error && error.message) || error));
        throw error;
      });
      this.readyPromise.catch(() => { /* reported through status */ });
      return this.readyPromise;
    },

    send(type, args) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, type, args });
      });
    },

    async call(type, args) {
      await this.start();
      return this.send(type, args);
    },

    async setChannel(channel) {
      const info = await this.call('setChannel', { channel });
      this.info = info;
      try { localStorage.setItem(CHANNEL_KEY, channel); } catch (_) { /* private mode */ }
      this.emit();
      return info;
    }
  };

  // ------------------------------------------------------------------ keeping the worker's file list in sync

  let syncChain = Promise.resolve();
  const syncedFiles = new Map(); // editor id -> { path, generation }

  function activeEditors() {
    const list = [];
    let table = null;
    try { table = typeof editors !== 'undefined' ? editors : null; } catch (_) { table = null; }
    attached.forEach((st, cm) => {
      const entry = table && table[st.id];
      if (!table || (entry && entry.cm === cm)) list.push({ st, cm });
    });
    return list;
  }

  function assignPaths(list) {
    const counts = {};
    list.forEach(({ st }) => { counts[st.filename] = (counts[st.filename] || 0) + 1; });
    list.forEach(({ st }) => { st.path = counts[st.filename] > 1 ? `/project/${st.id}/${st.filename}` : `/project/${st.filename}`; });
  }

  function syncProject() {
    syncChain = syncChain.then(async () => {
      pruneDetached();
      const list = activeEditors();
      assignPaths(list);
      const updates = [];
      const removes = [];
      const live = new Set();
      list.forEach(({ st, cm }) => {
        live.add(st.id);
        const known = syncedFiles.get(st.id);
        const generation = cm.changeGeneration();
        if (!known || known.path !== st.path || known.generation !== generation) {
          if (known && known.path !== st.path) removes.push(known.path);
          updates.push({ path: st.path, text: cm.getValue() });
          syncedFiles.set(st.id, { path: st.path, generation });
        }
      });
      syncedFiles.forEach((known, id) => {
        if (!live.has(id)) { removes.push(known.path); syncedFiles.delete(id); }
      });
      if (updates.length || removes.length) await client.call('setFiles', { updates, removes });
    }).catch(() => { /* retried on the next request */ });
    return syncChain;
  }

  function pruneDetached() {
    let table = null;
    try { table = typeof editors !== 'undefined' ? editors : null; } catch (_) { table = null; }
    if (!table) return;
    attached.forEach((st, cm) => {
      const entry = table[st.id];
      if (!entry || entry.cm !== cm) detach(cm);
    });
  }

  // ------------------------------------------------------------------ lint (diagnostics)

  function jshintAnnotations(text) {
    try {
      if (window.CodeMirror && CodeMirror.lint && typeof CodeMirror.lint.javascript === 'function') {
        return CodeMirror.lint.javascript(text, Object.assign({}, JSHINT_OPTIONS)) || [];
      }
    } catch (_) { /* JSHint missing or crashed */ }
    return [];
  }

  async function lintScript(st, cm, text) {
    const hint = jshintAnnotations(text);
    if (client.status !== 'ready') return hint;
    try {
      await syncProject();
      if (cm.getValue() !== text) return hint;
      const result = await client.call('diagnostics', { file: st.path });
      if (cm.getValue() !== text) return hint;
      const range = d => {
        const from = cm.posFromIndex(d.start);
        const to = cm.posFromIndex(d.start + Math.max(1, d.length));
        return { from, to };
      };
      const out = [];
      // TypeScript's parser knows modern syntax (??=, #private, top-level await...), JSHint's does not,
      // so JSHint contributes warnings only and real syntax errors come from TypeScript.
      // JSHint also misreads newer syntax (??=, ||=, &&=, #private) as "expected an assignment", so skip warnings on those lines.
      hint.forEach(a => {
        if (a.severity === 'error') return;
        const line = cm.getLine(a.from.line) || '';
        if (/\?\?=|\|\|=|&&=|#[A-Za-z_$]/.test(line)) return;
        out.push(a);
      });
      result.syntax.forEach(d => out.push(Object.assign(range(d), { message: d.message, severity: 'error' })));
      result.api.forEach(d => out.push(Object.assign(range(d), {
        message: d.message,
        severity: d.severity === 'beta' || d.severity === 'deprecated' ? d.severity : (d.severity === 'warning' ? 'warning' : 'error')
      })));
      return out;
    } catch (_) {
      return hint;
    }
  }

  function lintOptionsFor(st, cm) {
    return {
      async: true,
      getAnnotations(text, done) {
        lintScript(st, cm, text).then(done, () => done(jshintAnnotations(text)));
      }
    };
  }

  // ------------------------------------------------------------------ rendering documentation

  function renderCard(info, extra) {
    const card = el('div', 'sapi-card');
    const sig = el('pre', 'sapi-sig');
    sig.textContent = info.display || '';
    card.appendChild(sig);

    const av = info.availability;
    if (av) {
      const row = el('div', 'sapi-avail');
      const badge = el('span', 'sapi-badge ' + (av.beta ? 'beta' : 'stable'), av.beta ? (av.betaWholeModule ? 'Beta module' : 'Beta API') : (av.channel === 'beta' ? 'In stable too' : 'Stable'));
      row.appendChild(badge);
      row.appendChild(el('span', 'sapi-avail-text', `${av.module}${av.version ? ' ' + av.version : ''}`));
      card.appendChild(row);
      if (av.beta) card.appendChild(el('div', 'sapi-warn', 'Beta API - not available in stable releases and may change. Needs a "-beta" module version in manifest.json and Beta APIs enabled on the world.'));
    }
    if (info.deprecated) card.appendChild(el('div', 'sapi-warn', 'Deprecated'));

    const tags = info.tags || [];
    const tag = name => tags.filter(t => t.name === name);
    const description = [info.documentation, ...tag('remarks').map(t => t.text)].filter(Boolean).join('\n\n');
    if (description) { const d = el('div', 'sapi-doc'); d.innerHTML = markdown(description); card.appendChild(d); }

    const params = tag('param');
    if (params.length) {
      const list = el('div', 'sapi-params');
      params.forEach(t => {
        const m = /^(\S+)\s*([\s\S]*)$/.exec(t.text || '');
        if (!m) return;
        const row = el('div', 'sapi-param');
        row.appendChild(el('code', '', m[1]));
        const d = el('span', 'sapi-param-doc'); d.innerHTML = markdown(m[2].replace(/^-\s*/, '')).replace(/^<p>|<\/p>\s*$/g, '');
        row.appendChild(d);
        list.appendChild(row);
      });
      card.appendChild(list);
    }
    [['returns', 'Returns'], ['throws', 'Throws'], ['privilege', 'Privilege']].forEach(([name, title]) => {
      tag(name).forEach(t => {
        const sec = el('div', 'sapi-sec');
        sec.appendChild(el('div', 'sapi-sec-title', title));
        const body = el('div', 'sapi-doc'); body.innerHTML = markdown(t.text);
        sec.appendChild(body); card.appendChild(sec);
      });
    });
    const examples = tag('example');
    if (examples.length && !(extra && extra.compact)) {
      const sec = el('div', 'sapi-sec');
      sec.appendChild(el('div', 'sapi-sec-title', 'Example'));
      const body = el('div', 'sapi-doc sapi-example'); body.innerHTML = markdown(examples[0].text);
      sec.appendChild(body); card.appendChild(sec);
    }
    if (av && av.url && !(extra && extra.compact)) {
      const link = el('a', 'sapi-link', 'Open in Microsoft docs');
      link.href = av.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.appendChild(link);
    }
    return card;
  }

  // ------------------------------------------------------------------ tooltips (hover + signature help)

  const hoverTip = { node: null, timer: null, token: 0 };
  function hideHover() {
    clearTimeout(hoverTip.timer);
    hoverTip.token++;
    if (hoverTip.node) { hoverTip.node.remove(); hoverTip.node = null; }
  }
  function placeFloating(node, x, y, preferAbove) {
    document.body.appendChild(node);
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let left = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    let top = preferAbove ? y - h - 6 : y + 18;
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 8);
    if (top < 8) top = 8;
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  }

  async function showHover(st, cm, x, y) {
    const token = ++hoverTip.token;
    const coords = cm.coordsChar({ left: x, top: y }, 'window');
    if (!coords || coords.outside) { hideHover(); return; }
    const text = cm.getValue();
    const offset = cm.indexFromPos(coords);
    try {
      await syncProject();
      const info = await client.call('quickInfo', { file: st.path, offset });
      if (token !== hoverTip.token || cm.getValue() !== text) return;
      if (!info) { hideHover(); return; }
      const node = el('div', 'sapi-tooltip');
      node.appendChild(renderCard(info));
      node.addEventListener('mouseleave', hideHover);
      if (hoverTip.node) hoverTip.node.remove();
      hoverTip.node = node;
      placeFloating(node, x, y, false);
    } catch (_) { /* no hover when the worker is unavailable */ }
  }

  function hideSignature(st) {
    if (st.sigNode) { st.sigNode.remove(); st.sigNode = null; }
  }
  async function showSignature(st, cm, triggerCharacter) {
    if (client.status !== 'ready') return;
    const token = ++st.sigToken;
    const offset = cm.indexFromPos(cm.getCursor());
    try {
      await syncProject();
      const help = await client.call('signatureHelp', { file: st.path, offset, triggerCharacter: triggerCharacter || undefined });
      if (token !== st.sigToken) return;
      if (!help || !help.items.length) { hideSignature(st); return; }
      const item = help.items[Math.min(help.selected, help.items.length - 1)];
      const node = el('div', 'sapi-tooltip sapi-signature');
      const line = el('div', 'sapi-sig-line');
      line.appendChild(document.createTextNode(item.prefix));
      item.params.forEach((p, i) => {
        const span = el('span', i === help.argument ? 'sapi-sig-param active' : 'sapi-sig-param', p.display);
        line.appendChild(span);
        if (i < item.params.length - 1) line.appendChild(document.createTextNode(item.separator));
      });
      line.appendChild(document.createTextNode(item.suffix));
      node.appendChild(line);
      const active = item.params[help.argument] || item.params[item.params.length - 1];
      const tagDoc = (item.tags.find(t => t.name === 'param' && active && new RegExp('^' + (active.display.split(/[?:]/)[0] || '').replace(/[^\w$]/g, '') + '\\b').test(t.text)) || {}).text || '';
      const paramDoc = active && (active.documentation || tagDoc.replace(/^\S+\s*/, ''));
      if (paramDoc) { const d = el('div', 'sapi-doc sapi-sig-doc'); d.innerHTML = markdown(paramDoc); node.appendChild(d); }
      if (help.items.length > 1) node.appendChild(el('div', 'sapi-sig-count', `${help.items.length} overloads`));
      hideSignature(st);
      st.sigNode = node;
      const c = cm.cursorCoords(true, 'window');
      placeFloating(node, c.left, c.top, true);
    } catch (_) { hideSignature(st); }
  }

  // ------------------------------------------------------------------ completion

  const docPanel = { node: null };
  function hideDocPanel() { if (docPanel.node) { docPanel.node.remove(); docPanel.node = null; } }

  async function completionDetails(st, cm, item) {
    const key = `${item.name}|${item.source}`;
    if (st.detailCache.key === key && st.detailCache.offset === item.requestOffset && st.detailCache.text === item.requestText) return st.detailCache.promise;
    const promise = client.call('completionDetails', { file: st.path, offset: item.requestOffset, name: item.name, source: item.source, data: item.data, quote: quoteStyle(item.requestText) });
    st.detailCache = { key, offset: item.requestOffset, text: item.requestText, promise };
    return promise;
  }

  function showDocPanel(st, cm, item, listElement) {
    hideDocPanel();
    if (!item || !listElement || !listElement.parentNode) return;
    const myToken = ++st.docToken;
    completionDetails(st, cm, item).then(details => {
      if (myToken !== st.docToken || !details || !listElement.parentNode) return;
      const rect = listElement.parentNode.getBoundingClientRect();
      const node = el('div', 'sapi-tooltip sapi-docpanel');
      node.appendChild(renderCard({ display: details.display, documentation: details.documentation, tags: details.tags, availability: null, deprecated: (item.modifiers || '').includes('deprecated') }, { compact: true }));
      if (item.betaOnly) node.appendChild(el('div', 'sapi-warn', 'Beta-only module. Switch the Script API channel to Beta to use it.'));
      if (details.sourceText) node.appendChild(el('div', 'sapi-avail-text', 'Auto-import from ' + details.sourceText));
      docPanel.node = node;
      document.body.appendChild(node);
      const w = node.offsetWidth;
      let left = rect.right + 6;
      if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 6);
      node.style.left = left + 'px';
      node.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - node.offsetHeight - 8)) + 'px';
    }).catch(() => { /* documentation is optional */ });
  }

  async function pickCompletion(cm, st, item) {
    const fromIndex = item.from;
    const toIndex = Math.max(item.to, fromIndex);
    const sameDoc = cm.getValue() === item.requestText;
    let imports = [];
    if (item.hasAction && sameDoc) {
      try {
        const details = await completionDetails(st, cm, item);
        if (cm.getValue() === item.requestText && details) imports = (details.codeActions[0] || { changes: [] }).changes;
      } catch (_) { imports = []; }
    }
    if (cm.getValue() !== item.requestText) {
      // the document moved on while we waited; fall back to a plain replace of what is under the cursor
      const cursor = cm.getCursor();
      cm.replaceRange(item.insertText, cm.posFromIndex(Math.max(0, cm.indexFromPos(cursor) - (item.requestOffset - item.from))), cursor, 'complete');
      return;
    }
    const edits = [{ start: fromIndex, length: toIndex - fromIndex, newText: item.insertText }].concat(imports.map(c => ({ start: c.start, length: c.length, newText: c.newText })));
    edits.sort((a, b) => b.start - a.start);
    let caret = fromIndex + item.insertText.length;
    edits.forEach(e => { if (e.start < fromIndex) caret += e.newText.length - e.length; });
    cm.operation(() => {
      edits.forEach(e => cm.replaceRange(e.newText, cm.posFromIndex(e.start), cm.posFromIndex(e.start + e.length), 'complete'));
      cm.setCursor(cm.posFromIndex(caret));
    });
  }

  function buildCompletion(cm, st, raw, requestText, requestOffset) {
    const item = Object.assign({}, raw, { requestText, requestOffset });
    const letter = KIND_LETTERS[raw.kind] || '.';
    return {
      text: raw.insertText,
      displayText: raw.name,
      item,
      render(node) {
        node.classList.add('sapi-hint');
        const k = el('span', 'sapi-kind sapi-k-' + String(raw.kind || 'x').replace(/\s+/g, '-'), letter);
        const name = el('span', 'sapi-name', raw.name);
        if ((raw.modifiers || '').includes('deprecated')) name.classList.add('deprecated');
        node.appendChild(k);
        node.appendChild(name);
        const detail = raw.betaOnly ? 'beta only' : (raw.source ? raw.source : '');
        if (detail) node.appendChild(el('span', 'sapi-hint-source' + (raw.betaOnly ? ' beta' : ''), detail));
      },
      hint() { pickCompletion(cm, st, item); }
    };
  }

  function makeHintFunction(st) {
    const fn = function (cm, callback) {
      const token = ++st.hintToken;
      const text = cm.getValue();
      const offset = cm.indexFromPos(cm.getCursor());
      syncProject().then(() => client.call('complete', { file: st.path, offset, quote: quoteStyle(text) })).then(result => {
        if (token !== st.hintToken || cm.getValue() !== text) { callback(); return; }
        const items = (result && result.items) || [];
        if (!items.length) { callback(null); return; }
        const data = {
          list: items.map(raw => buildCompletion(cm, st, raw, text, offset)),
          from: cm.posFromIndex(items[0].from),
          to: cm.getCursor()
        };
        CodeMirror.on(data, 'select', (completion, node) => showDocPanel(st, cm, completion && completion.item, node));
        CodeMirror.on(data, 'close', hideDocPanel);
        CodeMirror.on(data, 'pick', hideDocPanel);
        callback(data);
      }).catch(() => callback(null));
    };
    fn.async = true;
    return fn;
  }

  function triggerCompletion(cm, st) {
    if (!isReadyForEditing(cm) || typeof cm.showHint !== 'function') return;
    cm.showHint({ hint: st.hintFunction, completeSingle: false, closeOnUnfocus: true, alignWithWord: true });
  }
  function isReadyForEditing(cm) {
    const panel = cm.getWrapperElement().closest('.code-panel');
    return !panel || panel.classList.contains('active');
  }

  // ------------------------------------------------------------------ channel pill + menu

  const menu = { node: null, owner: null };
  function closeMenu() { if (menu.node) { menu.node.remove(); menu.node = null; } menu.owner = null; }
  function openMenu(anchor) {
    if (menu.node) { closeMenu(); return; }
    const node = el('div', 'sapi-menu');
    const title = el('div', 'sapi-menu-title', 'Bedrock Script API');
    node.appendChild(title);
    if (client.status === 'error') {
      node.appendChild(el('div', 'sapi-menu-note', 'IntelliSense could not start, so Studio is using the basic JavaScript checks. ' + client.error));
      const retry = el('button', 'sapi-menu-item', 'Try again');
      retry.addEventListener('click', () => { closeMenu(); retryStart(); });
      node.appendChild(retry);
    } else if (client.status === 'loading' || !client.info) {
      node.appendChild(el('div', 'sapi-menu-note', 'Loading TypeScript and the official @minecraft definitions...'));
    } else {
      client.info.channels.forEach(channel => {
        const item = el('button', 'sapi-menu-item' + (channel.id === client.info.channel ? ' active' : ''));
        item.appendChild(el('span', 'sapi-menu-label', channel.label));
        const desc = channel.id === 'stable'
          ? 'Released APIs only'
          : 'Includes beta APIs (marked as beta)';
        item.appendChild(el('span', 'sapi-menu-desc', desc));
        item.addEventListener('click', async () => {
          closeMenu();
          try { await client.setChannel(channel.id); refreshAllLint(); } catch (_) { /* status shows the error */ }
        });
        node.appendChild(item);
      });
      const versions = Object.entries(client.info.packages).map(([n, v]) => `${n.replace('@minecraft/', '')} ${v}`).join(' | ');
      node.appendChild(el('div', 'sapi-menu-note', versions));
      if (client.info.unavailable.length) node.appendChild(el('div', 'sapi-menu-note', 'Not in this channel: ' + client.info.unavailable.map(n => n.replace('@minecraft/', '')).join(', ')));
      node.appendChild(el('div', 'sapi-menu-note', `Definitions from ${String(client.info.generatedAt).slice(0, 10)} - TypeScript ${client.info.tsVersion}`));
    }
    document.body.appendChild(node);
    const rect = anchor.getBoundingClientRect();
    node.style.left = Math.max(8, Math.min(rect.right - node.offsetWidth, window.innerWidth - node.offsetWidth - 8)) + 'px';
    node.style.top = Math.max(8, rect.top - node.offsetHeight - 6) + 'px';
    menu.node = node;
    menu.owner = anchor;
  }
  document.addEventListener('mousedown', event => {
    if (menu.node && !menu.node.contains(event.target) && !(event.target.closest && event.target.closest('.sapi-pill'))) closeMenu();
  }, true);

  function pillLabel() {
    if (client.status === 'error') return 'Script API unavailable';
    if (client.status !== 'ready' || !client.info) return 'Script API loading...';
    const channel = client.info.channels.find(c => c.id === client.info.channel);
    return 'Script API: ' + (channel ? channel.label : client.info.channel);
  }
  function updatePills() {
    attached.forEach(st => {
      if (!st.pill) return;
      st.pill.className = 'sapi-pill ' + client.status;
      st.pill.querySelector('.sapi-pill-text').textContent = pillLabel();
      st.pill.title = client.status === 'ready' ? 'Bedrock Script API definitions - click to switch Stable / Beta' : (client.status === 'error' ? client.error : 'Loading Bedrock Script API IntelliSense');
    });
  }
  client.listeners.add(updatePills);
  client.listeners.add(() => { if (client.status === 'ready') refreshAllLint(); });

  function refreshAllLint() {
    attached.forEach((st, cm) => { try { if (typeof cm.performLint === 'function') cm.performLint(); } catch (_) { /* editor gone */ } });
    hideHover();
  }
  function retryStart() {
    client.worker && client.worker.terminate();
    client.worker = null; client.readyPromise = null; client.pending.clear();
    client.start();
  }

  // ------------------------------------------------------------------ attach / detach

  function attach(id, cm, filename) {
    const st = {
      id, filename, path: '/project/' + filename, hintToken: 0, docToken: 0, sigToken: 0, sigNode: null,
      detailCache: {}, handlers: {}, keyMap: null, pill: null, hintFunction: null
    };
    st.hintFunction = makeHintFunction(st);
    attached.set(cm, st);

    st.keyMap = {
      'Ctrl-Space': () => triggerCompletion(cm, st),
      'Cmd-Space': () => triggerCompletion(cm, st),
      'Shift-Ctrl-Space': () => showSignature(st, cm),
      'Shift-Cmd-Space': () => showSignature(st, cm)
    };
    cm.addKeyMap(st.keyMap);

    let autoTimer = null;
    st.handlers.inputRead = (editor, change) => {
      if (change.origin !== '+input') return;
      const typed = (change.text || []).join('\n');
      if (typed === '(' || typed === ',') {
        clearTimeout(st.sigTimer);
        st.sigTimer = setTimeout(() => showSignature(st, cm, typed), 60);
      } else if (typed === ')') {
        hideSignature(st);
      }
      if (!/^[\w$.'"\/@-]$/.test(typed)) return;
      if (editor.state.completionActive && typed !== '.') return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => { if (client.status === 'ready') triggerCompletion(cm, st); }, typed === '.' ? 20 : 70);
    };
    cm.on('inputRead', st.handlers.inputRead);

    st.handlers.cursor = () => {
      if (st.sigNode) {
        clearTimeout(st.sigTimer);
        st.sigTimer = setTimeout(() => showSignature(st, cm), 120);
      }
    };
    cm.on('cursorActivity', st.handlers.cursor);
    st.handlers.blur = () => { hideSignature(st); hideHover(); };
    cm.on('blur', st.handlers.blur);
    st.handlers.scroll = () => { hideHover(); hideSignature(st); };
    cm.on('scroll', st.handlers.scroll);
    st.handlers.keydown = (editor, event) => { if (event.key === 'Escape') { hideSignature(st); hideHover(); } };
    cm.on('keydown', st.handlers.keydown);

    const wrapper = cm.getWrapperElement();
    st.handlers.mousemove = event => {
      if (event.buttons) return;
      clearTimeout(hoverTip.timer);
      if (client.status !== 'ready') return;
      const x = event.clientX;
      const y = event.clientY;
      hoverTip.timer = setTimeout(() => showHover(st, cm, x, y), 380);
    };
    st.handlers.mouseleave = event => {
      clearTimeout(hoverTip.timer);
      if (hoverTip.node && event.relatedTarget && hoverTip.node.contains(event.relatedTarget)) return;
      hideHover();
    };
    wrapper.addEventListener('mousemove', st.handlers.mousemove);
    wrapper.addEventListener('mouseleave', st.handlers.mouseleave);

    // channel pill
    const host = wrapper.parentNode;
    if (host) {
      const pill = el('button', 'sapi-pill ' + client.status);
      pill.type = 'button';
      pill.appendChild(el('span', 'sapi-pill-dot'));
      pill.appendChild(el('span', 'sapi-pill-text', pillLabel()));
      pill.addEventListener('click', () => openMenu(pill));
      host.appendChild(pill);
      st.pill = pill;
    }
    client.start();
    updatePills();
    return st;
  }

  function detach(cm) {
    const st = attached.get(cm);
    if (!st) return;
    attached.delete(cm);
    try {
      cm.removeKeyMap(st.keyMap);
      cm.off('inputRead', st.handlers.inputRead);
      cm.off('cursorActivity', st.handlers.cursor);
      cm.off('blur', st.handlers.blur);
      cm.off('scroll', st.handlers.scroll);
      cm.off('keydown', st.handlers.keydown);
      const wrapper = cm.getWrapperElement();
      wrapper.removeEventListener('mousemove', st.handlers.mousemove);
      wrapper.removeEventListener('mouseleave', st.handlers.mouseleave);
      if (cm.state.completionActive) cm.state.completionActive.close();
    } catch (_) { /* editor already torn down */ }
    hideSignature(st);
    if (st.pill) st.pill.remove();
    syncedFiles.delete(st.id);
  }

  function ready(id, cm, filename) {
    if (!cm) return false;
    if (!isScriptFile(filename)) { detach(cm); return false; }
    let st = attached.get(cm);
    if (!st) st = attach(id, cm, filename);
    st.id = id;
    st.filename = filename;
    // editor.js resets the lint option whenever a file is opened or renamed, so we set ours again each time
    if (typeof cm.setOption === 'function' && window.CodeMirror && CodeMirror.lint) cm.setOption('lint', lintOptionsFor(st, cm));
    return true;
  }

  window.studioScriptApiEditorReady = ready;
  window.studioScriptApi = {
    status: () => ({ status: client.status, error: client.error, info: client.info }),
    setChannel: channel => client.setChannel(channel).then(info => { refreshAllLint(); return info; }),
    ready: () => client.start(),
    attachedCount: () => attached.size
  };

  // command palette entries
  function register() {
    if (typeof window.studioRegisterCommand !== 'function') return;
    window.studioRegisterCommand({
      label: 'Script API: Use Stable definitions',
      description: 'Autocomplete and checks for released Bedrock Script API modules only',
      aliases: ['bedrock script api stable intellisense'],
      run: () => window.studioScriptApi.setChannel('stable')
    });
    window.studioRegisterCommand({
      label: 'Script API: Use Beta definitions',
      description: 'Include beta Bedrock Script API modules and members (they are marked as beta)',
      aliases: ['bedrock script api beta experimental intellisense'],
      run: () => window.studioScriptApi.setChannel('beta')
    });
  }
  register();
})(window);
