(() => {
  const contextMenuStyles = document.createElement('style');
  contextMenuStyles.id = 'studio-context-menu-styles';
  contextMenuStyles.textContent = `
    #studio-context-menu {
      position: fixed;
      z-index: 4000;
      display: none;
      width: 236px;
      max-width: calc(100vw - 12px);
      max-height: calc(100vh - 12px);
      overflow: auto;
      box-sizing: border-box;
      padding: 6px;
      border: 1px solid var(--border-strong, #47505c);
      border-radius: 6px;
      color: var(--text-body, #e6e6e6);
      background: var(--bg-4, #23262b);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.48);
      font: 12px var(--font-mono, monospace);
    }
    #studio-context-menu[data-open="true"] { display: block; }
    #studio-context-menu[hidden] { display: none !important; }
    #studio-context-menu [role="group"] { display: flex; flex-direction: column; gap: 2px; }
    #studio-context-menu [hidden] { display: none; }
    #studio-context-menu .context-divider { height: 1px; margin: 5px 3px; background: var(--border, #3a4048); }
    #studio-context-menu .context-heading { padding: 5px 8px 3px; color: var(--text-muted, #9aa4af); font-size: 10px; }
    #studio-context-menu button {
      display: flex;
      width: 100%;
      min-height: 30px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 8px;
      border: 0;
      border-radius: 0;
      color: var(--text-body, #e6e6e6);
      background: transparent;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    #studio-context-menu button:hover,
    #studio-context-menu button:focus-visible,
    #studio-context-menu .context-submenu:focus-within > button {
      color: var(--text-main, #fff);
      background: var(--bg-6, #343941);
    }
    #studio-context-menu button:disabled { color: var(--text-muted, #888); cursor: not-allowed; }
    #studio-context-menu .context-submenu { position: relative; }
    #studio-context-menu .context-submenu-panel {
      position: fixed;
      top: 0;
      left: 0;
      display: none;
      width: 190px;
      padding: 6px;
      border: 1px solid var(--border-strong, #47505c);
      border-radius: 6px;
      background: var(--bg-4, #23262b);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.48);
    }
    #studio-context-menu .context-submenu:hover .context-submenu-panel,
    #studio-context-menu .context-submenu:focus-within .context-submenu-panel,
    #studio-context-menu .context-submenu[data-expanded="true"] .context-submenu-panel { display: block; }
    #studio-context-menu .context-shortcut { color: var(--text-muted, #9aa4af); font-size: 10px; }
  `;
  document.head.appendChild(contextMenuStyles);

  const menu = document.createElement('div');
  menu.id = 'studio-context-menu';
  menu.className = 'studio-context-menu';
  menu.dataset.open = 'false';
  menu.hidden = true;
  menu.style.display = 'none';
  menu.setAttribute('aria-hidden', 'true');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'studio actions');
  menu.tabIndex = -1;
  menu.innerHTML = `
    <div class="context-heading" data-context-title>studio actions</div>
    <div role="group">
      <div class="context-submenu">
        <button type="button" role="menuitem" data-submenu-toggle aria-haspopup="menu" aria-expanded="false">
          <span>open new tab</span><span aria-hidden="true">›</span>
        </button>
        <div class="context-submenu-panel" role="menu" aria-label="open new tab">
          <button type="button" role="menuitem" data-context-action="upload">upload from your device</button>
          <button type="button" role="menuitem" data-context-action="scratch">start from scratch</button>
          <button type="button" role="menuitem" data-context-action="open-file">open file options</button>
        </div>
      </div>
      <button type="button" role="menuitem" data-context-action="open-cloud">open mcbCode project</button>
    </div>
    <div class="context-divider" role="separator"></div>
    <div role="group">
      <button type="button" role="menuitem" data-context-action="command-palette">command palette<span class="context-shortcut">ctrl+shift+p</span></button>
      <button type="button" role="menuitem" data-context-action="quick-open">quick open<span class="context-shortcut">ctrl+p</span></button>
      <button type="button" role="menuitem" data-context-action="find">find in active tab<span class="context-shortcut">ctrl+f</span></button>
      <button type="button" role="menuitem" data-context-action="undo">undo</button>
      <button type="button" role="menuitem" data-context-action="redo">redo</button>
      <button type="button" role="menuitem" data-context-action="copy">copy</button>
      <button type="button" role="menuitem" data-context-action="cut">cut</button>
      <button type="button" role="menuitem" data-context-action="paste">paste</button>
      <button type="button" role="menuitem" data-context-action="select-all">select all</button>
    </div>
    <div class="context-divider" role="separator"></div>
    <div role="group">
      <button type="button" role="menuitem" data-context-action="save">save active file<span class="context-shortcut">ctrl+s</span></button>
      <button type="button" role="menuitem" data-context-action="download">download active file</button>
      <button type="button" role="menuitem" data-context-action="toggle-sidebar">toggle sidebar</button>
      <button type="button" role="menuitem" data-context-action="wiki">toggle bedrock wiki</button>
      <button type="button" role="menuitem" data-context-action="extensions">manage extensions</button>
      <button type="button" role="menuitem" data-context-action="theme">custom theme</button>
      <button type="button" role="menuitem" data-context-action="close-active">close active tab</button>
      <button type="button" role="menuitem" data-context-action="exit-split">exit split view</button>
    </div>
    <div class="context-divider" role="separator" data-tab-divider></div>
    <div role="group" data-tab-actions>
      <button type="button" role="menuitem" data-context-action="split">split screen with this tab</button>
      <button type="button" role="menuitem" data-context-action="close-tab">close this tab</button>
    </div>
  `;
  document.body.appendChild(menu);

  let context = { scope: 'page', tabId: null, returnFocus: null };
  let draggedTab = null;

  function activeTabId() {
    return document.querySelector('#tab-bar .tab.active')?.dataset.tab || null;
  }

  function hideMenu(restoreFocus = false) {
    if (menu.dataset.open !== 'true') return;
    menu.dataset.open = 'false';
    menu.style.display = 'none';
    menu.hidden = true;
    menu.setAttribute('aria-hidden', 'true');
    menu.querySelector('.context-submenu')?.removeAttribute('data-expanded');
    menu.querySelector('[data-submenu-toggle]')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && context.returnFocus?.isConnected) context.returnFocus.focus();
  }

  function showMenu(event, scope, tabId = null) {
    context = { scope, tabId, returnFocus: document.activeElement };
    menu.dataset.scope = scope;
    menu.dataset.open = 'true';
    menu.hidden = false;
    menu.style.display = 'block';
    menu.setAttribute('aria-hidden', 'false');
    menu.querySelector('[data-context-title]').textContent = scope === 'tab'
      ? (document.querySelector(`.tab[data-tab="${CSS.escape(tabId)}"] .tab-label`)?.textContent || 'tab actions')
      : scope === 'tabbar' ? 'tab bar actions' : 'studio actions';
    menu.querySelectorAll('[data-tab-actions], [data-tab-divider]').forEach(el => {
      el.hidden = scope !== 'tab';
    });

    const splitAction = menu.querySelector('[data-context-action="split"]');
    const openTabs = [...document.querySelectorAll('#tab-bar .tab')];
    const splitTabs = window.studioGetSplitTabs?.() || [];
    splitAction.disabled = scope !== 'tab' || (openTabs.length < 2 && !splitTabs.length) ||
      (splitTabs.length >= 3 && !splitTabs.includes(tabId));
    menu.querySelector('[data-context-action="exit-split"]').disabled = splitTabs.length < 2;

    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.maxHeight = 'calc(100vh - 12px)';
    const isKeyboard = event.clientX === 0 && event.clientY === 0;
    const targetRect = event.target instanceof Element ? event.target.getBoundingClientRect() : null;
    const requestedX = isKeyboard && targetRect ? targetRect.left : event.clientX;
    const requestedY = isKeyboard && targetRect ? targetRect.bottom : event.clientY;
    const initialRect = menu.getBoundingClientRect();
    const spaceBelow = Math.max(0, window.innerHeight - requestedY - 6);
    const spaceAbove = Math.max(0, requestedY - 6);
    const openAbove = spaceBelow < initialRect.height && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(window.innerHeight - 12, openAbove ? spaceAbove : spaceBelow));
    menu.style.maxHeight = `${maxHeight}px`;
    const menuRect = menu.getBoundingClientRect();
    const x = Math.max(6, Math.min(requestedX, window.innerWidth - menuRect.width - 6));
    const requestedTop = openAbove ? requestedY - menuRect.height : requestedY;
    const y = Math.max(6, Math.min(requestedTop, window.innerHeight - menuRect.height - 6));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    if (isKeyboard) menu.querySelector('button:not(:disabled)')?.focus();
  }

  function positionSubmenu() {
    const submenu = menu.querySelector('.context-submenu');
    const toggle = submenu?.querySelector('[data-submenu-toggle]');
    const panel = submenu?.querySelector('.context-submenu-panel');
    if (!submenu || !toggle || !panel) return;
    submenu.dataset.expanded = 'true';
    toggle.setAttribute('aria-expanded', 'true');
    const anchor = toggle.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const openLeft = anchor.right + size.width + 6 > window.innerWidth && anchor.left - size.width - 6 >= 6;
    submenu.dataset.side = openLeft ? 'left' : 'right';
    const left = openLeft ? anchor.left - size.width - 6 : anchor.right + 6;
    const top = Math.max(6, Math.min(anchor.top, window.innerHeight - size.height - 6));
    panel.style.left = `${Math.max(6, Math.min(left, window.innerWidth - size.width - 6))}px`;
    panel.style.top = `${top}px`;
  }

  const contextSubmenu = menu.querySelector('.context-submenu');
  contextSubmenu.addEventListener('pointerenter', positionSubmenu);
  contextSubmenu.addEventListener('focusin', positionSubmenu);
  contextSubmenu.addEventListener('pointerleave', event => {
    if (!contextSubmenu.contains(document.activeElement) && !event.relatedTarget?.closest?.('.context-submenu-panel')) {
      contextSubmenu.removeAttribute('data-expanded');
      contextSubmenu.querySelector('[data-submenu-toggle]')?.setAttribute('aria-expanded', 'false');
    }
  });
  contextSubmenu.addEventListener('focusout', event => {
    if (!contextSubmenu.contains(event.relatedTarget)) {
      contextSubmenu.removeAttribute('data-expanded');
      contextSubmenu.querySelector('[data-submenu-toggle]')?.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (menu.contains(event.target)) return;
    const tab = event.target.closest?.('#tab-bar .tab');
    if (tab) {
      showMenu(event, 'tab', tab.dataset.tab);
    } else if (event.target.closest?.('#tab-bar')) {
      showMenu(event, 'tabbar');
    } else {
      showMenu(event, 'page');
    }
  }, true);

  menu.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  menu.addEventListener('click', event => {
    const toggle = event.target.closest('[data-submenu-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'true');
      positionSubmenu();
      return;
    }

    const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
    if (!action || event.target.closest('button')?.disabled) return;
    const tabId = context.tabId;
    hideMenu();
    runAction(action, tabId);
  });

  async function runAction(action, tabId) {
    const targetTabId = tabId || activeTabId();
    const editor = targetTabId ? window.studioGetEditor?.(targetTabId) : null;
    switch (action) {
      case 'upload':
        document.getElementById('local-file-input')?.click();
        break;
      case 'scratch': {
        const id = window.nextDynamicId?.() || `scratch_${Date.now()}`;
        window.openTab?.(id, 'untitled', '');
        break;
      }
      case 'open-file':
        document.getElementById('openfile-overlay')?.classList.add('show');
        break;
      case 'open-cloud':
        window.openCloudBrowser?.();
        break;
      case 'command-palette':
        window.studioOpenCommandPalette?.();
        break;
      case 'quick-open':
        window.studioOpenQuickOpen?.();
        break;
      case 'find':
        window.studioOpenActiveFind?.(targetTabId);
        break;
      case 'undo':
      case 'redo':
        window.studioRunEditorCommand?.(action, targetTabId);
        break;
      case 'copy':
        if (editor?.somethingSelected?.()) {
          if (navigator.clipboard?.writeText) {
            try { await navigator.clipboard.writeText(editor.getSelection()); }
            catch (_) { document.execCommand('copy'); }
          } else document.execCommand('copy');
        } else document.execCommand('copy');
        break;
      case 'cut':
        if (editor?.somethingSelected?.()) {
          const selected = editor.getSelection();
          if (navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(selected);
              editor.replaceSelection('');
            } catch (_) { document.execCommand('cut'); }
          } else document.execCommand('cut');
        } else document.execCommand('cut');
        break;
      case 'paste':
        if (editor && navigator.clipboard?.readText) {
          try {
            const text = await navigator.clipboard.readText();
            editor.replaceSelection(text, 'paste', 'paste');
            editor.focus();
          } catch (_) { document.execCommand('paste'); }
        } else document.execCommand('paste');
        break;
      case 'select-all':
        if (editor) editor.execCommand('selectAll');
        else document.execCommand('selectAll');
        break;
      case 'save':
        if (targetTabId) window.studioSaveTab?.(targetTabId);
        else window.saveActiveTab?.();
        break;
      case 'download':
        window.downloadActiveStudioFile?.(targetTabId);
        break;
      case 'toggle-sidebar':
        document.getElementById('sidebar-wrap')?.classList.toggle('collapsed');
        break;
      case 'wiki':
        window.toggleWikiPanel?.();
        break;
      case 'extensions':
        window.openExtManager?.('installed');
        break;
      case 'theme':
        window.openThemeModal?.();
        break;
      case 'close-active':
      case 'close-tab':
        document.querySelector(`.tab[data-tab="${CSS.escape(targetTabId || '')}"] .close-btn`)?.click();
        break;
      case 'split':
        if (!window.studioSplitTab?.(tabId)) alert('open another tab first to use split screen.');
        break;
      case 'exit-split':
        window.studioExitSplitView?.();
        break;
    }
  }

  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideMenu(true);
      return;
    }
    if (event.key === 'ArrowRight' && event.target.matches('[data-submenu-toggle]')) {
      event.preventDefault();
      const submenu = event.target.closest('.context-submenu');
      event.target.setAttribute('aria-expanded', 'true');
      positionSubmenu();
      submenu.querySelector('.context-submenu-panel button')?.focus();
      return;
    }
    if (event.key === 'ArrowLeft' && event.target.closest('.context-submenu-panel')) {
      event.preventDefault();
      const submenu = event.target.closest('.context-submenu');
      submenu.dataset.expanded = 'false';
      submenu.querySelector('[data-submenu-toggle]')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...menu.querySelectorAll('button:not(:disabled)')].filter(item => item.getClientRects().length);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });

  document.addEventListener('pointerdown', event => {
    if (menu.dataset.open === 'true' && !menu.contains(event.target)) hideMenu();

    const wiki = document.getElementById('wiki-panel-wrap');
    if (wiki?.classList.contains('show') && !wiki.contains(event.target) &&
        !event.target.closest?.('#activity-wiki-icon, [data-action="toggle-wiki"]')) {
      window.closeWikiPanel?.();
    }

    const sidebar = document.getElementById('sidebar-wrap');
    const sidebarHasTransientView = !document.getElementById('search-panel')?.hidden ||
      !document.getElementById('settings-panel')?.hidden;
    if (sidebarHasTransientView && sidebar && !sidebar.contains(event.target) &&
        !event.target.closest?.('[data-sidebar-view]')) {
      sidebar.classList.add('collapsed');
    }
  }, true);

  const overlayIds = [
    'ext-detail-overlay', 'ext-perms-overlay', 'ext-manager-overlay', 'theme-guide-overlay',
    'theme-overlay', 'cloudfile-overlay', 'openfile-overlay', 'shortcuts-overlay'
  ];
  overlayIds.forEach(id => {
    const overlay = document.getElementById(id);
    overlay?.addEventListener('mousedown', event => {
      if (event.target === overlay) overlay.classList.remove('show');
    });
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (menu.dataset.open === 'true') {
      hideMenu(true);
      return;
    }
    const overlay = overlayIds.map(id => document.getElementById(id))
      .find(item => item?.classList.contains('show'));
    if (overlay) {
      overlay.classList.remove('show');
      return;
    }
    const account = document.getElementById('account-popup');
    if (account?.classList.contains('show')) {
      account.classList.remove('show');
      return;
    }
    const wiki = document.getElementById('wiki-panel-wrap');
    if (wiki?.classList.contains('show')) {
      window.closeWikiPanel?.();
      return;
    }
    const sidebar = document.getElementById('sidebar-wrap');
    if (!document.getElementById('search-panel')?.hidden || !document.getElementById('settings-panel')?.hidden) {
      sidebar?.classList.add('collapsed');
    }
  });

  const tabBar = document.getElementById('tab-bar');
  tabBar?.addEventListener('dragstart', event => {
    const tab = event.target.closest?.('.tab');
    if (!tab || event.target.closest('.close-btn') || event.target.isContentEditable) {
      event.preventDefault();
      return;
    }
    draggedTab = tab;
    tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tab.dataset.tab);
  });
  tabBar?.addEventListener('dragover', event => {
    const target = event.target.closest?.('.tab');
    if (!draggedTab || !target || target === draggedTab) return;
    event.preventDefault();
    document.querySelectorAll('.tab.drag-over').forEach(tab => tab.classList.remove('drag-over'));
    target.classList.add('drag-over');
    const bounds = target.getBoundingClientRect();
    const insertAfter = event.clientX > bounds.left + bounds.width / 2;
    tabBar.insertBefore(draggedTab, insertAfter ? target.nextSibling : target);
  });
  tabBar?.addEventListener('drop', event => {
    if (!draggedTab) return;
    event.preventDefault();
    document.querySelectorAll('.tab.drag-over').forEach(tab => tab.classList.remove('drag-over'));
    window.renderStudioExplorer?.();
  });
  tabBar?.addEventListener('dragend', () => {
    draggedTab?.classList.remove('dragging');
    draggedTab = null;
    document.querySelectorAll('.tab.drag-over').forEach(tab => tab.classList.remove('drag-over'));
  });
})();
