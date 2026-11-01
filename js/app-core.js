  // ================= backend config =================
  // the actual API worker this studio talks to. every request needs
  // credentials:'include' so the mcb_session cookie (Domain=.mcbcode.com) gets sent.
  const API_BASE = 'https://auth.mcbcode.com';

  async function api(path, options = {}) {
    const res = await fetch(API_BASE + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // ================= menu bar dropdowns =================
  const menuItems = document.querySelectorAll('.menu-item:has(.menu-dropdown)');

  function openMenu(item) {
    menuItems.forEach(menu => {
      const isOpen = menu === item;
      menu.classList.toggle('open', isOpen);
      menu.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  function closeMenu(item) {
    item.classList.remove('open');
    item.setAttribute('aria-expanded', 'false');
  }

  menuItems.forEach(item => {
    item.tabIndex = 0;
    item.setAttribute('aria-haspopup', 'true');
    item.setAttribute('aria-expanded', 'false');
    item.addEventListener('mouseenter', () => openMenu(item));
    item.addEventListener('mouseleave', () => closeMenu(item));
    item.addEventListener('focusin', () => openMenu(item));
    item.addEventListener('focusout', event => {
      if (!item.contains(event.relatedTarget)) closeMenu(item);
    });
  });

  // close hover menus after choosing an action or clicking away
  document.addEventListener('click', event => {
    if (event.target.closest?.('.menu-item')) return;
    menuItems.forEach(closeMenu);
  });

  // File, editor, and view commands route to their active workspace actions.
  document.querySelectorAll('[data-action="undo"]').forEach(el => {
    el.addEventListener('click', () => window.studioRunEditorCommand?.('undo'));
  });
  document.querySelectorAll('[data-action="redo"]').forEach(el => {
    el.addEventListener('click', () => window.studioRunEditorCommand?.('redo'));
  });
  document.querySelectorAll('[data-action="find-active"]').forEach(el => {
    el.addEventListener('click', () => window.studioOpenActiveFind?.());
  });
  document.querySelectorAll('[data-action="toggle-sidebar"]').forEach(el => {
    el.addEventListener('click', () => document.getElementById('sidebar-wrap')?.classList.toggle('collapsed'));
  });
  document.querySelectorAll('[data-action="open-command-palette"]').forEach(el => {
    el.addEventListener('click', () => window.studioOpenCommandPalette?.());
  });
  document.querySelectorAll('[data-action="open-quick-open"]').forEach(el => {
    el.addEventListener('click', () => window.studioOpenQuickOpen?.());
  });
  document.querySelectorAll('[data-action="toggle-geometry-preview"]').forEach(el => {
    el.addEventListener('click', () => window.toggleBedrockGeometryPreview?.());
  });
  document.querySelector('[data-action="new-file"]').addEventListener('click', () => {
    const id = nextDynamicId();
    openTab(id, 'untitled', '');
  });
  document.querySelector('[data-action="open-file"]').addEventListener('click', () => {
    document.getElementById('openfile-overlay').classList.add('show');
  });
  document.querySelector('[data-action="save-file"]').addEventListener('click', () => {
    saveActiveTab();
  });
  document.querySelector('[data-action="download-active-file"]').addEventListener('click', () => {
    window.downloadActiveStudioFile?.();
  });

  // extensions top-level menu item now opens the manager instead of the placeholder
  document.querySelector('[data-action="open-extensions"]').addEventListener('click', () => openExtManager('installed'));
  document.querySelector('[data-action="open-marketplace"]').addEventListener('click', () => openExtManager('marketplace'));
  document.querySelector('[data-action="open-theme"]').addEventListener('click', () => openThemeModal());
  document.getElementById('activity-extensions-icon').addEventListener('click', () => openExtManager('installed'));

  // ================= keyboard shortcuts modal =================
  document.getElementById('shortcuts-btn').addEventListener('click', () => {
    document.getElementById('shortcuts-overlay').classList.add('show');
  });
  document.getElementById('shortcuts-close').addEventListener('click', () => {
    document.getElementById('shortcuts-overlay').classList.remove('show');
  });

  // ================= shortcuts: windows/mac toggle =================
  const platformBtns = document.querySelectorAll('.platform-btn');
  const keySpans = document.querySelectorAll('.shortcuts-list .keys');

  function setShortcutPlatform(platform) {
    keySpans.forEach(el => {
      el.textContent = platform === 'mac' ? el.dataset.mac : el.dataset.win;
    });
    platformBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.platform === platform);
    });
  }

  platformBtns.forEach(btn => {
    btn.addEventListener('click', () => setShortcutPlatform(btn.dataset.platform));
  });

  // auto-detect so mac users see Cmd/Option by default, windows users see Ctrl/Alt
  const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.toUpperCase().includes('MAC');
  setShortcutPlatform(isMac ? 'mac' : 'win');

  // ================= auth state =================
  let currentUser = null; // null = logged out, otherwise the object /me returns

  async function checkAuth() {
    try {
      currentUser = await api('/me');
    } catch (e) {
      currentUser = null;
      console.error('mcbCode auth check failed:', e.message);
    }
    updateAuthUI();
  }

  function updateAuthUI() {
    const popupTitle = document.getElementById('account-popup-title');
    const popupBody = document.getElementById('account-popup-body');
    const popupBtn = document.getElementById('account-popup-btn');
    const loginBtn = document.getElementById('btn-login');
    const accountIconImg = document.querySelector('#account-icon img');
    const accountLinks = document.getElementById('account-popup-links');
    if (accountLinks) accountLinks.style.display = currentUser ? 'block' : 'none';

    if (currentUser) {
      popupTitle.textContent = currentUser.username || 'Account';
      popupBody.textContent = `${currentUser.points || 0} points${currentUser.is_obsidian ? ' \u00b7 Obsidian' : ''}`;
      popupBtn.textContent = 'Log out';
      popupBtn.style.display = 'block';
      popupBtn.onclick = async () => {
        await api('/logout', { method: 'POST' });
        currentUser = null;
        updateAuthUI();
      };
      loginBtn.textContent = 'Account';
      accountIconImg.src = currentUser.pfp_url || 'https://mcbcode.com/img/icons/blank-transparent.png';
    } else {
      popupTitle.textContent = 'Account';
      popupBody.textContent = 'not logged in';
      popupBtn.textContent = 'Login';
      popupBtn.style.display = 'block';
      popupBtn.onclick = () => {
        window.location.href = 'https://mcbcode.com/account?redirectto=https://studio.mcbcode.com';
      };
      loginBtn.textContent = 'Login';
      accountIconImg.src = 'https://mcbcode.com/img/icons/blank-transparent.png';
    }
  }

  checkAuth();

  // ================= welcome panel + tab state =================
  const tabBar = document.getElementById('tab-bar');
  const codeArea = document.getElementById('code-area');
  const welcomePanel = document.getElementById('welcome-panel');
  const splitTabIds = [];

  function updateWelcomeVisibility() {
    const anyTabs = document.querySelectorAll('.tab').length > 0;
    welcomePanel.classList.toggle('show', !anyTabs);
  }

  // ================= tabs: switching =================
  function renderSplitPanels() {
    const isSplit = splitTabIds.length > 1;
    codeArea.classList.toggle('split-screen', isSplit);
    codeArea.dataset.splitCount = String(isSplit ? splitTabIds.length : 1);
    document.querySelectorAll('.code-panel').forEach(panel => {
      panel.classList.toggle('split-visible', isSplit && splitTabIds.includes(panel.dataset.panel));
    });
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.toggle('split-member', isSplit && splitTabIds.includes(tab.dataset.tab));
    });
  }

  function activateTab(id) {
    if (splitTabIds.length > 1 && !splitTabIds.includes(id)) splitTabIds.splice(0);
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === id);
    });
    document.querySelectorAll('.code-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.panel === id);
    });
    document.querySelectorAll('.file-item').forEach(f => {
      f.classList.toggle('active', f.dataset.file === id);
    });
    if (typeof setActiveTreeFileByTabId === 'function') setActiveTreeFileByTabId(id);
    updateWelcomeVisibility();
    if (typeof currentProject === 'undefined' || !currentProject) window.renderStudioExplorer?.();
    renderSplitPanels();

    // CodeMirror sizes itself based on its container at creation time, so a fresh
    // instance mounted while its tab was hidden renders broken until this is called
    const entry = editors[id];
    if (entry || splitTabIds.length > 1) {
      const visibleIds = splitTabIds.length > 1 ? [...splitTabIds] : [id];
      setTimeout(() => {
        visibleIds.forEach(tabId => editors[tabId]?.cm.refresh());
        // don't steal focus if a tab label is mid-rename (e.g. the two click events that
        // precede a dblclick both call activateTab, and would otherwise blur the label
        // the instant the rename starts)
        if (!document.activeElement || !document.activeElement.isContentEditable) {
          editors[id]?.cm.focus();
        }
      }, 0);
    }
  }
  window.activateTab = activateTab;

  function splitTab(id) {
    if (!document.querySelector(`.tab[data-tab="${CSS.escape(id)}"]`)) return false;
    if (!splitTabIds.length) {
      const activeId = document.querySelector('.tab.active')?.dataset.tab;
      const otherId = activeId && activeId !== id
        ? activeId
        : [...document.querySelectorAll('.tab')].map(tab => tab.dataset.tab).find(tabId => tabId !== id);
      if (!otherId) return false;
      splitTabIds.push(otherId);
    }
    if (!splitTabIds.includes(id)) {
      if (splitTabIds.length >= 3) return false;
      splitTabIds.push(id);
    }
    activateTab(id);
    return splitTabIds.length > 1;
  }
  window.studioSplitTab = splitTab;

  window.studioRemoveSplitTab = id => {
    const index = splitTabIds.indexOf(id);
    if (index < 0) return;
    splitTabIds.splice(index, 1);
    if (splitTabIds.length < 2) splitTabIds.splice(0);
    renderSplitPanels();
  };
  window.studioGetSplitTabs = () => [...splitTabIds];

  window.studioExitSplitView = () => {
    splitTabIds.splice(0);
    renderSplitPanels();
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active) activateTab(active);
  };

  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== 'Tab') return;
    const tabs = [...document.querySelectorAll('#tab-bar .tab')];
    if (tabs.length < 2) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex(tab => tab.classList.contains('active'));
    const direction = event.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    activateTab(tabs[nextIndex].dataset.tab);
  }, true);
