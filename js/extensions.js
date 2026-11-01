// =====================================================================
  // EXTENSION SYSTEM — frontend/UI layer only. No runtime, no sandboxing,
  // no real network/file access happens here. Everything below is grouped
  // into the modules called out in the spec so a real backend can replace
  // just the "extension-data" module later without touching the UI code.
  // =====================================================================

  // ---------- extension-ui-api ----------
  // the eventual public API extensions call to add UI (studio.ui.registerPanel(...) etc).
  // right now these are stubs: they just log what would happen and record the call,
  // so it's obvious this is a placeholder and not a real integration point yet.
  // no extension code ever actually runs in this build, so nothing here is
  // reachable by an extension yet — it exists purely to define the future shape.
  window.studio = window.studio || {};
  studio.ui = {
    _registry: [], // just for inspecting in devtools during development
    registerPanel(opts) { this._log('registerPanel', opts); },
    registerSidebarItem(opts) { this._log('registerSidebarItem', opts); },
    registerToolbarItem(opts) { this._log('registerToolbarItem', opts); },
    registerEditorAction(opts) { this._log('registerEditorAction', opts); },
    registerStatusBarItem(opts) { this._log('registerStatusBarItem', opts); },
    registerCommand(opts) { this._log('registerCommand', opts); },
    registerContextMenuAction(opts) { this._log('registerContextMenuAction', opts); },
    _log(method, opts) {
      this._registry.push({ method, opts });
      console.log(`[studio.ui.${method}] (stub — no extension runtime yet)`, opts);
    }
  };

  // ---------- extension-data ----------
  // mock persistence layer. installed extensions live in localStorage for now
  // (per-browser, not per-account) so the manager UI has something real to
  // read/write during development. every function here is where the real
  // backend calls (install/uninstall/enable/disable, extension id lookups,
  // etc) will eventually go instead.
  const ExtensionData = (function () {
    const STORAGE_KEY = 'studio_installed_extensions';

    function loadInstalled() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
      catch { return []; }
    }
    function saveInstalled(list) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    return {
      getInstalledExtensions() {
        return loadInstalled();
      },
      getExtension(id) {
        return loadInstalled().find(e => e.id === id) || null;
      },
      // manifest: the parsed (mocked) .studiomcbc manifest, already approved by the user.
      // meta: { source: 'imported'|'marketplace', verified: bool }
      installExtension(manifest, meta) {
        const list = loadInstalled();
        if (list.some(e => e.id === manifest.id)) {
          // already installed — real backend would probably treat this as an update
          return list.find(e => e.id === manifest.id);
        }
        const record = {
          ...manifest,
          enabled: true,
          verified: !!meta.verified,
          source: meta.source,
          installedAt: new Date().toISOString().slice(0, 10)
        };
        list.push(record);
        saveInstalled(list);
        return record;
      },
      uninstallExtension(id) {
        saveInstalled(loadInstalled().filter(e => e.id !== id));
      },
      enableExtension(id) { this._setEnabled(id, true); },
      disableExtension(id) { this._setEnabled(id, false); },
      _setEnabled(id, val) {
        const list = loadInstalled();
        const e = list.find(x => x.id === id);
        if (e) e.enabled = val;
        saveInstalled(list);
      },
      getExtensionPermissions(id) {
        const e = this.getExtension(id);
        return e ? e.permissions : null;
      },
      // mock marketplace catalog — real backend will fetch this from a server instead
      getMarketplaceExtensions() {
        return MOCK_MARKETPLACE;
      }
    };
  })();

  // ---------- extension-runtime ----------
  // this is the real (if minimal) execution layer. an extension's code runs inside
  // a sandboxed <iframe sandbox="allow-scripts"> — no allow-same-origin, so it can't
  // touch this page's DOM, cookies, or storage directly. the only way in or out is
  // the postMessage bridge below, which currently exposes exactly two capabilities:
  // studio.ui.registerCommand and studio.ui.registerStatusBarItem. everything else
  // in the permission model (network/workspace/editor/bedrock) is still declared
  // and shown to the user, but not yet wired to a real capability — that's next.
  const ExtensionRuntime = (function () {
    const running = {}; // id -> { iframe, commands: [{id,label}] }

    function statusBarEl() { return document.getElementById('ext-status-bar'); }
    function refreshStatusBarVisibility() {
      const bar = statusBarEl();
      bar.classList.toggle('show', bar.children.length > 0);
    }
    function addStatusBarItem(extId, itemId, text) {
      const bar = statusBarEl();
      const span = document.createElement('span');
      span.className = 'status-item';
      span.id = `status-${extId}-${itemId}`;
      span.textContent = text; // textContent only — never innerHTML, this comes from extension code
      bar.appendChild(span);
      refreshStatusBarVisibility();
    }
    function removeAllStatusBarItemsFor(extId) {
      statusBarEl().querySelectorAll(`[id^="status-${extId}-"]`).forEach(el => el.remove());
      refreshStatusBarVisibility();
    }

    function start(ext) {
      if (running[ext.id]) return;       // already running
      if (!ext.code) return;             // manifest-only mock (marketplace-browse-only entries) — nothing to execute

      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts'); // deliberately no allow-same-origin
      iframe.style.display = 'none';

      // bootstrap defines the extension-facing `studio` object. every call it makes
      // just posts a message up to the real page — the extension never gets a direct
      // reference to anything outside its own iframe.
      const bootstrap = `
        <script>
          window.__commands = {};
          window.studio = {
            ui: {
              registerCommand: function (opts) {
                window.__commands[opts.id] = opts.run;
                parent.postMessage({ type: 'studio-ext-call', extId: ${JSON.stringify(ext.id)}, method: 'registerCommand', payload: { id: opts.id, label: opts.label } }, '*');
              },
              registerStatusBarItem: function (opts) {
                parent.postMessage({ type: 'studio-ext-call', extId: ${JSON.stringify(ext.id)}, method: 'registerStatusBarItem', payload: { id: opts.id, text: String(opts.text) } }, '*');
              }
            }
          };
          window.addEventListener('message', function (e) {
            if (e.data && e.data.type === 'studio-run-command' && e.data.extId === ${JSON.stringify(ext.id)}) {
              var fn = window.__commands[e.data.commandId];
              if (fn) { try { fn(); } catch (err) { console.error('[extension error]', err); } }
            }
          });
        <\/script>
        <script>${ext.code}<\/script>
      `;
      iframe.srcdoc = bootstrap;
      document.body.appendChild(iframe);
      running[ext.id] = { iframe, commands: [] };
    }

    function stop(id) {
      const r = running[id];
      if (!r) return;
      r.iframe.remove();
      removeAllStatusBarItemsFor(id);
      delete running[id];
    }

    function handleMessage(extId, method, payload) {
      const r = running[extId];
      if (!r) return;
      if (method === 'registerCommand') {
        if (!r.commands.some(c => c.id === payload.id)) r.commands.push(payload);
      } else if (method === 'registerStatusBarItem') {
        addStatusBarItem(extId, payload.id, payload.text);
      }
    }

    window.addEventListener('message', (e) => {
      const data = e.data;
      if (data && data.type === 'studio-ext-call') {
        handleMessage(data.extId, data.method, data.payload);
        // if the extension's details modal happens to be open, refresh its command list
        if (document.getElementById('ext-detail-overlay').classList.contains('show')) {
          refreshOpenDetailCommandsIfMatching(data.extId);
        }
      }
    });

    function getCommands(id) {
      return running[id] ? running[id].commands : [];
    }
    function runCommand(extId, commandId) {
      const r = running[extId];
      if (!r) return;
      r.iframe.contentWindow.postMessage({ type: 'studio-run-command', extId, commandId }, '*');
    }
    function isRunning(id) { return !!running[id]; }

    return { start, stop, getCommands, runCommand, isRunning };
  })();

  // ---------- mock manifests ----------
  // shape mirrors the real future .studiomcbc manifest (formatVersion, id, permissions, contributes, etc).
  const MOCK_EXTENSIONS = {
    wiki: {
      formatVersion: 1,
      id: 'example.minecraft-wiki',
      name: 'Minecraft Wiki',
      version: '1.0.0',
      description: 'Look up Minecraft Bedrock wiki pages without leaving the editor.',
      author: 'example developer',
      main: 'main.js',
      icon: 'https://mcbcode.com/img/icons/blank-transparent.png',
      permissions: {
        network: ['https://api.example.com'],
        workspace: ['read'],
        editor: ['read']
      },
      contributes: { commands: ['wiki.search'], panels: ['wiki.sidebar'], editor: {} },
      // real, sandboxed extension code — runs inside an isolated iframe via the studio.ui bridge.
      // this is the interim runtime: only registerCommand/registerStatusBarItem are wired to
      // anything real right now. network/workspace/editor/bedrock permissions are still just
      // declared+displayed, not yet enforced capabilities.
      code: `
        studio.ui.registerCommand({
          id: 'wiki.search',
          label: 'Search Minecraft Wiki',
          run: function () {
            alert('Minecraft Wiki extension: this is where a wiki search box would open. (demo — proves the extension is really executing in its own sandbox)');
          }
        });
      `
    },
    mcfTools: {
      formatVersion: 1,
      id: 'community.mcfunction-tools',
      name: 'mcfunction Tools',
      version: '0.4.2',
      description: 'Snippets and quick actions for writing .mcfunction files.',
      author: 'community contributor',
      main: 'main.js',
      icon: 'https://mcbcode.com/img/icons/blank-transparent.png',
      permissions: {
        workspace: ['read', 'write'],
        editor: ['read', 'modify'],
        ui: ['registerCommands', 'registerPanels']
      },
      contributes: { commands: ['mcf.formatFile'], panels: [], editor: {} },
      code: `
        studio.ui.registerCommand({
          id: 'mcf.formatFile',
          label: 'Format mcfunction File',
          run: function () {
            alert('mcfunction Tools: formatting is a demo action for now — this alert is running from inside the extension\\'s own sandboxed iframe, not the main page.');
          }
        });
        studio.ui.registerStatusBarItem({ id: 'mcf.status', text: 'mcfunction Tools active' });
      `
    },
    textureHelper: {
      formatVersion: 1,
      id: 'community.block-texture-helper',
      name: 'Block Texture Helper',
      version: '1.3.0',
      description: 'Generates and edits block texture files directly inside your resource pack.',
      author: 'community contributor',
      main: 'main.js',
      icon: 'https://mcbcode.com/img/icons/blank-transparent.png',
      permissions: {
        workspace: ['read', 'write'],
        bedrock: ['read', 'modify']
      },
      contributes: { commands: ['textures.generate'], panels: ['textures.panel'], editor: {} }
    },
    multiApi: {
      formatVersion: 1,
      id: 'community.multi-api-connector',
      name: 'Multi API Connector',
      version: '2.0.1',
      description: 'Pulls data from CurseForge, MCPEDL, and a custom texture host all in one panel.',
      author: 'community contributor',
      main: 'main.js',
      icon: 'https://mcbcode.com/img/icons/blank-transparent.png',
      permissions: {
        network: ['https://api.curseforge.com', 'https://api.mcpedl.com', 'https://api.example-textures.com'],
        workspace: ['read']
      },
      contributes: { commands: [], panels: ['connector.panel'], editor: {} }
    }
  };

  // marketplace listing — verified flag here represents what the (future) store would say.
  // nothing is pre-installed: this is the full catalog a user can browse and choose from.
  const MOCK_MARKETPLACE = [
    { manifest: MOCK_EXTENSIONS.wiki, verified: true },
    { manifest: MOCK_EXTENSIONS.mcfTools, verified: true },
    { manifest: MOCK_EXTENSIONS.textureHelper, verified: true },
    { manifest: MOCK_EXTENSIONS.multiApi, verified: false }
  ];

  // boot every enabled installed extension that has real code, so extensions
  // stay "running" across page reloads just like a real IDE would
  ExtensionData.getInstalledExtensions().forEach(ext => {
    if (ext.enabled && ext.code) ExtensionRuntime.start(ext);
  });

  // ---------- extension-permissions (shared rendering helpers) ----------
  const PERMISSION_LABELS = {
    network: 'Network Access',
    workspace: 'Workspace Access',
    editor: 'Editor Access',
    ui: 'UI Access',
    bedrock: 'Bedrock Project Access'
  };
  const PERMISSION_VALUE_LABELS = {
    read: 'Read project files',
    write: 'Write project files',
    modify: 'Modify contents',
    registerCommands: 'Register commands',
    registerPanels: 'Register panels',
    registerToolbarItems: 'Register toolbar items',
    registerStatusBarItems: 'Register status bar items'
  };

  // builds the permission-groups markup used in both the install review and details view
  function renderPermissionGroups(permissions) {
    if (!permissions || Object.keys(permissions).length === 0) {
      return '<div class="ext-empty">This extension requests no special permissions.</div>';
    }
    return Object.entries(permissions).map(([category, values]) => {
      const title = PERMISSION_LABELS[category] || category;
      const items = values.map(v => {
        // network permissions are raw domains/URLs — show them exactly, never collapse to "internet access"
        const label = category === 'network' ? v : (PERMISSION_VALUE_LABELS[v] || v);
        return `<div class="ext-perm-item"><span class="check">✓</span>${label}</div>`;
      }).join('');
      return `<div class="ext-perm-group"><div class="ext-perm-group-title">${title}</div>${items}</div>`;
    }).join('');
  }

  // ---------- extension-manager ----------
  const extManagerOverlay = document.getElementById('ext-manager-overlay');
  const extList = document.getElementById('ext-list');
  let extManagerTab = 'installed';

  function openExtManager(tab) {
    extManagerTab = tab || 'installed';
    document.querySelectorAll('.ext-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === extManagerTab));
    renderExtManagerList();
    extManagerOverlay.classList.add('show');
  }
  document.getElementById('ext-manager-close').addEventListener('click', () => extManagerOverlay.classList.remove('show'));

  document.querySelectorAll('.ext-tab').forEach(tab => {
    tab.addEventListener('click', () => openExtManager(tab.dataset.tab));
  });

  function extBadgeHtml(verified) {
    return verified
      ? `<span class="ext-badge verified">Verified</span>`
      : `<span class="ext-badge unverified">Unverified</span>`;
  }

  function renderExtManagerList() {
    extList.innerHTML = '';

    if (extManagerTab === 'installed') {
      const installed = ExtensionData.getInstalledExtensions();
      if (!installed.length) {
        extList.innerHTML = '<div class="ext-empty">No extensions installed yet.</div>';
        return;
      }
      installed.forEach(ext => extList.appendChild(buildInstalledCard(ext)));
    } else {
      const installedIds = new Set(ExtensionData.getInstalledExtensions().map(e => e.id));
      MOCK_MARKETPLACE.forEach(entry => extList.appendChild(buildMarketplaceCard(entry, installedIds.has(entry.manifest.id))));
    }
  }

  function buildInstalledCard(ext) {
    const card = document.createElement('div');
    card.className = 'ext-card' + (ext.enabled ? '' : ' disabled');
    card.innerHTML = `
      <img class="ext-icon" src="${ext.icon}" alt="">
      <div class="ext-card-body">
        <div class="ext-card-title-row">
          <strong>${ext.name}</strong>
          <span class="ext-card-id">${ext.id}</span>
          ${extBadgeHtml(ext.verified)}
        </div>
        <div class="ext-card-meta">by ${ext.author} · v${ext.version} · ${ext.enabled ? 'enabled' : 'disabled'}</div>
        <div class="ext-card-desc">${ext.description}</div>
        <div class="ext-card-actions">
          <button data-act="manage">Manage</button>
          <button data-act="toggle">${ext.enabled ? 'Disable' : 'Enable'}</button>
          <button data-act="perms">Permissions</button>
          <button data-act="download">Download</button>
          <button data-act="uninstall" class="ext-danger">Uninstall</button>
        </div>
      </div>
    `;
    card.querySelector('[data-act="manage"]').addEventListener('click', () => openExtDetails(ext.id));
    card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      if (ext.enabled) {
        ExtensionData.disableExtension(ext.id);
        ExtensionRuntime.stop(ext.id);
      } else {
        ExtensionData.enableExtension(ext.id);
        ExtensionRuntime.start(ExtensionData.getExtension(ext.id));
      }
      renderExtManagerList();
    });
    card.querySelector('[data-act="perms"]').addEventListener('click', () => openExtPermissions(ext));
    card.querySelector('[data-act="download"]').addEventListener('click', () => downloadExtension(ext));
    card.querySelector('[data-act="uninstall"]').addEventListener('click', () => {
      if (confirm(`Uninstall "${ext.name}"?`)) {
        ExtensionRuntime.stop(ext.id);
        ExtensionData.uninstallExtension(ext.id);
        renderExtManagerList();
      }
    });
    return card;
  }

  function buildMarketplaceCard(entry, alreadyInstalled) {
    const { manifest, verified } = entry;
    const card = document.createElement('div');
    card.className = 'ext-card';
    card.innerHTML = `
      <img class="ext-icon" src="${manifest.icon}" alt="">
      <div class="ext-card-body">
        <div class="ext-card-title-row">
          <strong>${manifest.name}</strong>
          <span class="ext-card-id">${manifest.id}</span>
          ${extBadgeHtml(verified)}
        </div>
        <div class="ext-card-meta">by ${manifest.author} · v${manifest.version}</div>
        <div class="ext-card-desc">${manifest.description}</div>
        <div class="ext-card-actions">
          <button data-act="install" ${alreadyInstalled ? 'disabled' : ''}>${alreadyInstalled ? 'Installed' : 'Install'}</button>
        </div>
      </div>
    `;
    if (!alreadyInstalled) {
      card.querySelector('[data-act="install"]').addEventListener('click', () => {
        openInstallReview(manifest, { source: 'marketplace', verified });
      });
    }
    return card;
  }

  function downloadExtension(ext) {
    // interim .studiomcbc format: JSON containing the manifest fields plus the
    // extension's real code. real version will package this as an actual zip,
    // but this round-trips correctly with the import flow below right now.
    const { enabled, verified, source, installedAt, ...manifestOnly } = ext;
    const payload = { manifest: manifestOnly, code: ext.code || '' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ext.id}.studiomcbc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- extension-install ----------
  document.getElementById('ext-install-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('ext-install-menu').classList.toggle('show');
  });
  document.addEventListener('click', () => document.getElementById('ext-install-menu').classList.remove('show'));

  document.getElementById('ext-browse-btn').addEventListener('click', () => openExtManager('marketplace'));

  const extImportInput = document.getElementById('ext-import-input');
  document.getElementById('ext-import-btn').addEventListener('click', () => extImportInput.click());

  extImportInput.addEventListener('change', () => {
    const file = extImportInput.files[0];
    extImportInput.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let manifest, hasRealCode = false;
      try {
        const parsed = JSON.parse(reader.result);
        if (parsed && parsed.manifest && parsed.manifest.id) {
          manifest = { ...parsed.manifest, code: parsed.code || '' };
          hasRealCode = !!parsed.code;
        } else {
          throw new Error('not the expected format');
        }
      } catch {
        // not a real .studiomcbc (manifest+code) file — fall back to a mock manifest
        // so the review flow is still testable with an arbitrary file
        const pool = Object.values(MOCK_EXTENSIONS);
        manifest = pool[Math.floor(Math.random() * pool.length)];
      }
      // manually imported files are unverified unless mock data explicitly says otherwise —
      // real .studiomcbc files a person built themselves are never "verified"
      openInstallReview(manifest, { source: 'imported', verified: false });
    };
    reader.readAsText(file);
  });

  let pendingInstall = null; // { manifest, meta } awaiting approval in the shared detail modal

  function openInstallReview(manifest, meta) {
    pendingInstall = { manifest, meta };
    renderExtDetailModal({ manifest, meta, mode: 'install-review' });
    document.getElementById('ext-detail-overlay').classList.add('show');
  }

  // ---------- extension-details ----------
  function openExtDetails(id) {
    const ext = ExtensionData.getExtension(id);
    if (!ext) return;
    pendingInstall = null;
    renderExtDetailModal({ manifest: ext, meta: { source: ext.source, verified: ext.verified, installedAt: ext.installedAt, enabled: ext.enabled }, mode: 'details' });
    document.getElementById('ext-detail-overlay').classList.add('show');
  }

  function renderExtDetailModal({ manifest, meta, mode }) {
    document.getElementById('ext-detail-name').dataset.extId = manifest.id;
    const existingCommandsSection = document.getElementById('ext-detail-commands-section');
    if (existingCommandsSection) existingCommandsSection.remove();

    document.getElementById('ext-detail-icon').src = manifest.icon;
    document.getElementById('ext-detail-name').textContent = manifest.name;
    document.getElementById('ext-detail-author').textContent = manifest.author;
    document.getElementById('ext-detail-version').textContent = manifest.version;
    document.getElementById('ext-detail-description').textContent = manifest.description;
    document.getElementById('ext-detail-badge').outerHTML = `<span id="ext-detail-badge" class="ext-badge ${meta.verified ? 'verified' : 'unverified'}">${meta.verified ? 'Verified' : 'Unverified'}</span>`;

    const warningEl = document.getElementById('ext-detail-warning');
    if (!meta.verified) {
      warningEl.textContent = 'This extension has not been verified by Studio.';
      warningEl.classList.add('show');
    } else {
      warningEl.classList.remove('show');
    }

    document.getElementById('ext-detail-permissions').innerHTML =
      `<div class="ext-section-label">This extension requests</div>` + renderPermissionGroups(manifest.permissions);

    const infoGrid = document.getElementById('ext-detail-info');
    infoGrid.innerHTML = `
      <span class="label">Studio compatibility</span><span>1.0.0+</span>
      <span class="label">Extension version</span><span>${manifest.version}</span>
      <span class="label">Manifest format</span><span>v${manifest.formatVersion}</span>
      <span class="label">Extension ID</span><span>${manifest.id}</span>
      <span class="label">Source</span><span>${meta.source === 'marketplace' ? 'Marketplace' : 'Imported (.studiomcbc)'}</span>
      ${mode === 'details' ? `<span class="label">Installed</span><span>${meta.installedAt}</span>` : ''}
    `;

    const actions = document.getElementById('ext-detail-actions');
    if (mode === 'install-review') {
      actions.innerHTML = `
        <button id="ext-detail-cancel">Cancel</button>
        <button id="ext-detail-install" class="ext-primary">Install Extension</button>
      `;
      document.getElementById('ext-detail-cancel').addEventListener('click', () => {
        pendingInstall = null;
        document.getElementById('ext-detail-overlay').classList.remove('show');
      });
      document.getElementById('ext-detail-install').addEventListener('click', () => {
        const record = ExtensionData.installExtension(manifest, meta);
        ExtensionRuntime.start(record);
        pendingInstall = null;
        document.getElementById('ext-detail-overlay').classList.remove('show');
        openExtManager('installed');
      });
    } else {
      actions.innerHTML = `
        <button id="ext-detail-toggle">${meta.enabled ? 'Disable' : 'Enable'}</button>
        <button id="ext-detail-download">Download .studiomcbc</button>
        <button id="ext-detail-uninstall" class="ext-danger">Uninstall</button>
      `;
      document.getElementById('ext-detail-toggle').addEventListener('click', () => {
        if (meta.enabled) {
          ExtensionData.disableExtension(manifest.id);
          ExtensionRuntime.stop(manifest.id);
        } else {
          ExtensionData.enableExtension(manifest.id);
          ExtensionRuntime.start(ExtensionData.getExtension(manifest.id));
        }
        openExtDetails(manifest.id); // re-render with fresh state
        renderExtManagerList();
      });
      document.getElementById('ext-detail-download').addEventListener('click', () => downloadExtension(ExtensionData.getExtension(manifest.id)));
      document.getElementById('ext-detail-uninstall').addEventListener('click', () => {
        if (confirm(`Uninstall "${manifest.name}"?`)) {
          ExtensionRuntime.stop(manifest.id);
          ExtensionData.uninstallExtension(manifest.id);
          document.getElementById('ext-detail-overlay').classList.remove('show');
          renderExtManagerList();
        }
      });

      renderDetailCommands(manifest.id);
      // registerCommand messages from the iframe arrive asynchronously right after it
      // boots, so give it a beat and refresh the commands list once more
      setTimeout(() => renderDetailCommands(manifest.id), 300);
    }
  }

  // shows whatever commands the running extension has actually registered, with
  // a Run button that posts the real command back into its sandboxed iframe
  function renderDetailCommands(extId) {
    // only touch the DOM if this extension's details modal is still the one open
    if (document.getElementById('ext-detail-name').dataset.extId !== extId) {
      document.getElementById('ext-detail-name').dataset.extId = extId;
    }
    let section = document.getElementById('ext-detail-commands-section');
    if (!section) {
      section = document.createElement('div');
      section.id = 'ext-detail-commands-section';
      document.getElementById('ext-detail-permissions').insertAdjacentElement('afterend', section);
    }
    if (!ExtensionRuntime.isRunning(extId)) {
      section.innerHTML = '';
      return;
    }
    const commands = ExtensionRuntime.getCommands(extId);
    if (!commands.length) {
      section.innerHTML = `<div class="ext-section-label">Commands</div><div class="ext-empty">This extension hasn't registered any commands yet.</div>`;
      return;
    }
    section.innerHTML = `<div class="ext-section-label">Commands</div>` + commands.map(c =>
      `<div class="ext-perm-item"><span>${c.label}</span><button class="ext-run-cmd" data-cmd="${c.id}" style="margin-left:auto;background:var(--bg-6);border:1px solid var(--border-strong);color:#eee;padding:2px 8px;cursor:pointer;font-size:11px;font-family:var(--font-mono);">Run</button></div>`
    ).join('');
    section.querySelectorAll('.ext-run-cmd').forEach(btn => {
      btn.addEventListener('click', () => ExtensionRuntime.runCommand(extId, btn.dataset.cmd));
    });
  }
  function refreshOpenDetailCommandsIfMatching(extId) {
    if (document.getElementById('ext-detail-name').dataset.extId === extId) {
      renderDetailCommands(extId);
    }
  }

  document.getElementById('ext-detail-close').addEventListener('click', () => {
    // closing without approving an install-review counts as cancel
    pendingInstall = null;
    document.getElementById('ext-detail-overlay').classList.remove('show');
  });

  // ---------- extension permissions-only quick view ----------
  function openExtPermissions(ext) {
    document.getElementById('ext-perms-title').textContent = `${ext.name} — Permissions`;
    document.getElementById('ext-perms-list').innerHTML = renderPermissionGroups(ext.permissions);
    document.getElementById('ext-perms-overlay').classList.add('show');
  }
  document.getElementById('ext-perms-close').addEventListener('click', () => {
    document.getElementById('ext-perms-overlay').classList.remove('show');
  });
