// ================= mini menus + editor actions =================
// 1) small vscode-style right click menus for the explorer (files + folders),
//    the open-files list, and the editor itself.
// 2) extra editor features: go to line, word wrap, duplicate / move line,
//    toggle comment, trim whitespace, format json, zoom, close all tabs.
// this file must load BEFORE context-menu.js so it can intercept the right click first.
(() => {
  const style = document.createElement('style');
  style.textContent = `
    #studio-mini-menu {
      position: fixed;
      z-index: 2147483100;
      display: none;
      min-width: 170px;
      max-width: 260px;
      padding: 4px 0;
      background: var(--bg-4, #252526);
      border: 1px solid var(--border-strong, rgba(255,255,255,.18));
      box-shadow: 0 4px 12px rgba(0,0,0,.45);
      font: 12px/1.4 var(--font-mono, Consolas, monospace);
      color: var(--text-1, #ddd);
    }
    #studio-mini-menu[data-open="true"] { display: block; }
    #studio-mini-menu button {
      display: flex;
      width: 100%;
      justify-content: space-between;
      gap: 24px;
      padding: 5px 14px;
      background: none;
      border: 0;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    #studio-mini-menu button:hover:not(:disabled),
    #studio-mini-menu button:focus-visible { background: var(--bg-6, #37373d); color: var(--accent, #78a9ff); outline: 0; }
    #studio-mini-menu button:disabled { opacity: .4; cursor: default; }
    #studio-mini-menu .mini-key { opacity: .55; }
    #studio-mini-menu .mini-sep { height: 1px; margin: 4px 0; background: var(--border, rgba(255,255,255,.12)); }
  `;
  document.head.appendChild(style);

  const menu = document.createElement('div');
  menu.id = 'studio-mini-menu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  // ---------- helpers ----------
  const isMac = /mac/i.test(navigator.platform || '');
  const mod = isMac ? 'Cmd' : 'Ctrl';

  function activeTabId() {
    return document.querySelector('#tab-bar .tab.active')?.dataset.tab || null;
  }
  function activeCm() {
    const id = activeTabId();
    return id ? window.studioGetEditor?.(id) || null : null;
  }
  function activeFileName() {
    return document.querySelector('#tab-bar .tab.active .tab-label')?.textContent || '';
  }
  function copyText(text) {
    try { navigator.clipboard.writeText(text); } catch (e) { console.warn('copy failed', e); }
  }

  function hide() {
    menu.dataset.open = 'false';
    menu.replaceChildren();
  }

  function show(event, items) {
    menu.replaceChildren();
    items.forEach(item => {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'mini-sep';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.disabled = !!item.disabled;
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.key) {
        const key = document.createElement('span');
        key.className = 'mini-key';
        key.textContent = item.key;
        btn.appendChild(key);
      }
      btn.addEventListener('click', () => {
        hide();
        try { item.run(); } catch (err) { console.error(err); }
      });
      menu.appendChild(btn);
    });
    menu.dataset.open = 'true';
    const rect = menu.getBoundingClientRect();
    const x = Math.max(6, Math.min(event.clientX, window.innerWidth - rect.width - 6));
    const y = Math.max(6, Math.min(event.clientY, window.innerHeight - rect.height - 6));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  // ---------- explorer helpers ----------
  function pathOf(file) {
    const parts = [file.name];
    let parent = file.parent_id ?? null;
    while (parent !== null && currentProject) {
      const p = currentProject.files.find(x => x.id === parent);
      if (!p) break;
      parts.unshift(p.name);
      parent = p.parent_id ?? null;
    }
    return parts.join('/');
  }

  async function renameTreeItem(file) {
    if (!currentProject) return;
    const name = (prompt('rename to:', file.name) || '').trim();
    if (!name || name === file.name) return;
    if (/[\\/]/.test(name)) { alert('names cant contain slashes'); return; }
    const oldName = file.name;

    // local archive projects live only in the browser, so rename locally
    if (currentProject.localArchive) {
      file.name = name;
      renderSidebarTree();
      return;
    }

    try {
      let content;
      const tabId = file.save_id ? 'cloud_' + file.save_id : null;
      if (file.type === 'file') {
        if (!file.save_id) { alert('this kind of file cant be renamed from here yet'); return; }
        const entry = tabId ? editors[tabId] : null;
        content = entry ? entry.cm.getValue() : ((await loadCloudFile(file.save_id)).content || '');
      }
      await api('/project/file', {
        method: 'POST',
        body: JSON.stringify({
          project_code: currentProject.code,
          file_id: file.id,
          name,
          type: file.type,
          content
        })
      });
      file.name = name;
      if (file.type === 'file' && file.save_id) updateCloudFileCache(file.save_id, content);
      // keep an open tab for this file in sync
      if (tabId) {
        const label = document.querySelector(`#tab-bar .tab[data-tab="${CSS.escape(tabId)}"] .tab-label`);
        if (label) label.textContent = name;
        if (editors[tabId]) applyFilenameToEditor(tabId, editors[tabId].cm, name);
      }
      renderSidebarTree();
    } catch (err) {
      file.name = oldName;
      alert("Couldn't rename that: " + err.message);
    }
  }

  function renameActiveTab() {
    const label = document.querySelector('#tab-bar .tab.active .tab-label');
    if (label) label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }

  // ---------- editor actions ----------
  const actions = {
    goToLine() {
      const cm = activeCm();
      if (!cm) return;
      const total = cm.lineCount();
      const answer = prompt(`go to line (1 - ${total}):`, String(cm.getCursor().line + 1));
      const n = parseInt(answer, 10);
      if (!Number.isFinite(n)) return;
      const line = Math.max(1, Math.min(total, n)) - 1;
      cm.setCursor({ line, ch: 0 });
      cm.scrollIntoView({ line, ch: 0 }, 120);
      cm.focus();
    },
    toggleWrap() {
      const cm = activeCm();
      if (!cm) return;
      cm.setOption('lineWrapping', !cm.getOption('lineWrapping'));
      cm.focus();
    },
    duplicateLine() {
      const cm = activeCm();
      if (!cm) return;
      const from = cm.getCursor('from');
      const to = cm.getCursor('to');
      const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
      const lines = [];
      for (let i = from.line; i <= last; i++) lines.push(cm.getLine(i));
      cm.replaceRange('\n' + lines.join('\n'), { line: last, ch: cm.getLine(last).length });
    },
    moveLineUp() { const cm = activeCm(); if (cm && CodeMirror.commands.swapLineUp) cm.execCommand('swapLineUp'); },
    moveLineDown() { const cm = activeCm(); if (cm && CodeMirror.commands.swapLineDown) cm.execCommand('swapLineDown'); },
    toggleComment() {
      const cm = activeCm();
      if (!cm) return;
      const name = activeFileName().toLowerCase();
      const prefix = name.endsWith('.mcfunction') ? '#' : (name.endsWith('.lang') ? '##' : '//');
      const from = cm.getCursor('from');
      const to = cm.getCursor('to');
      const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
      const rows = [];
      for (let i = from.line; i <= last; i++) rows.push(i);
      const filled = rows.filter(i => cm.getLine(i).trim() !== '');
      const allCommented = filled.length > 0 && filled.every(i => cm.getLine(i).trimStart().startsWith(prefix));
      cm.operation(() => {
        filled.forEach(i => {
          const text = cm.getLine(i);
          const indent = text.length - text.trimStart().length;
          if (allCommented) {
            const rest = text.slice(indent + prefix.length);
            cm.replaceRange(rest.startsWith(' ') ? rest.slice(1) : rest, { line: i, ch: indent }, { line: i, ch: text.length });
          } else {
            cm.replaceRange(prefix + ' ', { line: i, ch: indent });
          }
        });
      });
    },
    trimWhitespace() {
      const cm = activeCm();
      if (!cm) return;
      const cursor = cm.getCursor();
      const before = cm.getValue();
      const after = before.replace(/[ \t]+$/gm, '');
      if (after !== before) { cm.setValue(after); cm.setCursor(cursor); }
    },
    formatJson() {
      const cm = activeCm();
      if (!cm) return;
      try {
        cm.setValue(JSON.stringify(JSON.parse(cm.getValue()), null, 2) + '\n');
      } catch (err) {
        // bedrock json often has // comments, which JSON.parse cant read
        alert("Couldn't format: " + err.message + "\n(files with // comments cant be auto formatted)");
      }
    },
    zoom(delta) {
      const cm = activeCm();
      if (!cm) return;
      const el = cm.getWrapperElement();
      const current = parseFloat(el.style.fontSize) || 14;
      const next = delta === 0 ? 14 : Math.max(8, Math.min(32, current + delta));
      el.style.fontSize = next + 'px';
      cm.refresh();
    },
    closeAllTabs() {
      document.querySelectorAll('#tab-bar .tab .close-btn').forEach(btn => btn.click());
    }
  };

  // ---------- command palette entries ----------
  function registerCommands() {
    const reg = window.studioRegisterCommand;
    if (typeof reg !== 'function') return;
    reg({ label: 'Go to Line', description: `${mod}+G`, aliases: 'goto jump line', run: actions.goToLine });
    reg({ label: 'Toggle Word Wrap', description: 'Alt+Z', aliases: 'wrap', run: actions.toggleWrap });
    reg({ label: 'Duplicate Line', description: 'Shift+Alt+Down', aliases: 'copy line', run: actions.duplicateLine });
    reg({ label: 'Move Line Up', description: 'Alt+Up', run: actions.moveLineUp });
    reg({ label: 'Move Line Down', description: 'Alt+Down', run: actions.moveLineDown });
    reg({ label: 'Toggle Line Comment', description: `${mod}+/`, aliases: 'comment uncomment', run: actions.toggleComment });
    reg({ label: 'Trim Trailing Whitespace', description: 'Clean up line endings', aliases: 'whitespace', run: actions.trimWhitespace });
    reg({ label: 'Format Document (JSON)', description: 'Pretty print the active .json file', aliases: 'prettify indent', run: actions.formatJson });
    reg({ label: 'Zoom In Editor', description: `${mod}+=`, aliases: 'font bigger', run: () => actions.zoom(1) });
    reg({ label: 'Zoom Out Editor', description: `${mod}+-`, aliases: 'font smaller', run: () => actions.zoom(-1) });
    reg({ label: 'Reset Editor Zoom', description: `${mod}+0`, run: () => actions.zoom(0) });
    reg({ label: 'Rename Active Tab / File', description: 'F2', aliases: 'rename file', run: renameActiveTab });
  }
  registerCommands();

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', event => {
    const inEditor = !!event.target.closest?.('.CodeMirror');
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) && !inEditor;
    if (typing || event.target.isContentEditable) return;
    const ctrl = isMac ? event.metaKey : event.ctrlKey;
    let handled = true;

    if (event.key === 'F2') renameActiveTab();
    else if (!inEditor) handled = false;
    else if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'g') actions.goToLine();
    else if (event.altKey && !ctrl && !event.shiftKey && event.key.toLowerCase() === 'z') actions.toggleWrap();
    else if (event.altKey && !ctrl && !event.shiftKey && event.key === 'ArrowUp') actions.moveLineUp();
    else if (event.altKey && !ctrl && !event.shiftKey && event.key === 'ArrowDown') actions.moveLineDown();
    else if (event.altKey && !ctrl && event.shiftKey && event.key === 'ArrowDown') actions.duplicateLine();
    else if (ctrl && !event.altKey && event.key === '/') actions.toggleComment();
    else if (ctrl && !event.altKey && (event.key === '=' || event.key === '+')) actions.zoom(1);
    else if (ctrl && !event.altKey && event.key === '-') actions.zoom(-1);
    else if (ctrl && !event.altKey && event.key === '0') actions.zoom(0);
    else handled = false;

    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  // ---------- right click routing ----------
  document.addEventListener('contextmenu', event => {
    if (menu.contains(event.target)) { event.preventDefault(); return; }
    const target = event.target;
    let items = null;

    const treeRow = target.closest?.('#sidebar-content .tree-row');
    const openFileRow = target.closest?.('#sidebar-content .file-item');
    const cmEl = target.closest?.('.CodeMirror');

    if (treeRow && currentProject && treeRow.id !== 'sidebar-back-row') {
      const fileId = treeRow.dataset.fileId || treeRow.dataset.folderId;
      const file = currentProject.files.find(x => String(x.id) === String(fileId));
      if (file && file.type === 'folder') {
        items = [
          { label: collapsedFolders.has(file.id) ? 'expand' : 'collapse', run: () => treeRow.click() },
          'sep',
          { label: 'rename', key: 'F2', run: () => renameTreeItem(file) },
          'sep',
          { label: 'copy name', run: () => copyText(file.name) },
          { label: 'copy path', run: () => copyText(pathOf(file)) }
        ];
      } else if (file) {
        items = [
          { label: 'open', run: () => treeRow.click() },
          'sep',
          { label: 'rename', key: 'F2', run: () => renameTreeItem(file) },
          'sep',
          { label: 'copy name', run: () => copyText(file.name) },
          { label: 'copy path', run: () => copyText(pathOf(file)) }
        ];
      }
    } else if (openFileRow) {
      const id = openFileRow.dataset.file;
      items = [
        { label: 'open', run: () => window.activateTab?.(id) },
        { label: 'rename', key: 'F2', run: () => { window.activateTab?.(id); setTimeout(renameActiveTab, 0); } },
        'sep',
        { label: 'copy name', run: () => copyText(openFileRow.dataset.label || openFileRow.textContent) }
      ];
    } else if (cmEl) {
      const cm = cmEl.CodeMirror;
      if (cm) {
        const hasSel = cm.somethingSelected();
        const isJson = activeFileName().toLowerCase().endsWith('.json');
        items = [
          { label: 'undo', key: `${mod}+Z`, run: () => cm.undo() },
          { label: 'redo', key: `${mod}+Y`, run: () => cm.redo() },
          'sep',
          { label: 'cut', key: `${mod}+X`, disabled: !hasSel, run: () => { copyText(cm.getSelection()); cm.replaceSelection(''); } },
          { label: 'copy', key: `${mod}+C`, run: () => copyText(hasSel ? cm.getSelection() : cm.getLine(cm.getCursor().line) + '\n') },
          { label: 'paste', key: `${mod}+V`, run: async () => { try { cm.replaceSelection(await navigator.clipboard.readText()); } catch (e) { alert('allow clipboard access in your browser to paste from this menu'); } cm.focus(); } },
          { label: 'select all', key: `${mod}+A`, run: () => { cm.execCommand('selectAll'); cm.focus(); } },
          'sep',
          { label: 'go to line', key: `${mod}+G`, run: actions.goToLine },
          { label: 'toggle comment', key: `${mod}+/`, run: actions.toggleComment },
          { label: 'duplicate line', key: 'Shift+Alt+Down', run: actions.duplicateLine },
          { label: 'format json', disabled: !isJson, run: actions.formatJson }
        ];
      }
    }

    if (!items) { hide(); return; } // fall through to the normal studio menu
    event.preventDefault();
    event.stopImmediatePropagation();
    show(event, items);
  }, true);

  // ---------- dismiss ----------
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hide(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', hide, true);
})();
