// ================= cloud file browser =================
  const cloudfileOverlay = document.getElementById('cloudfile-overlay');
  const cloudfileList = document.getElementById('cloudfile-list');
  const cloudfileTitle = document.getElementById('cloudfile-title');

  // navigation state: null = showing the project list.
  // otherwise { code, name, files (flat list from /project), stack: [parentId,...] }
  let cloudNav = null;

  // ---- session caches (cleared only when the page is refreshed/closed) ----
  // file contents are fetched ONLY when that exact file is opened (or searched),
  // then kept here so the worker/database is never asked for the same file twice.
  // stores promises so two requests for the same file at the same time share one fetch.
  const cloudFileCache = new Map();   // save_id -> Promise<{ content }>
  const projectTreeCache = new Map(); // project code -> files array (no contents, just the tree)
  let projectListCache = null;        // result of GET /projects

  function loadCloudFile(saveId) {
    const key = String(saveId);
    if (!cloudFileCache.has(key)) {
      const pending = api('/save?id=' + encodeURIComponent(key))
        .then(data => ({ content: typeof data.content === 'string' ? data.content : '' }));
      pending.catch(() => cloudFileCache.delete(key)); // failed fetches arent cached, so retrying works
      cloudFileCache.set(key, pending);
    }
    return cloudFileCache.get(key);
  }
  // call after a save/rename so the cache matches what the server now has
  function updateCloudFileCache(saveId, content) {
    if (saveId == null) return;
    cloudFileCache.set(String(saveId), Promise.resolve({ content }));
  }
  window.loadCloudFile = loadCloudFile;
  window.updateCloudFileCache = updateCloudFileCache;

  function openCloudBrowser() {
    if (!currentUser) {
      const goLogin = confirm("You need to be logged in to open a file from your mcbCode account. Go log in now?");
      if (goLogin) window.location.href = 'https://mcbcode.com/account?redirectto=https://studio.mcbcode.com';
      return;
    }
    cloudNav = null;
    cloudfileOverlay.classList.add('show');
    renderProjectList();
  }
  document.getElementById('cloudfile-close').addEventListener('click', () => {
    cloudfileOverlay.classList.remove('show');
  });

  function cloudRow({ icon, name, idLabel, onClick }) {
    const row = document.createElement('div');
    row.className = 'cloudfile-row';
    row.innerHTML = `<img src="${icon}" alt=""><span class="cf-name"></span>${idLabel ? `<span class="cf-id"></span>` : ''}`;
    row.querySelector('.cf-name').textContent = name;
    if (idLabel) row.querySelector('.cf-id').textContent = idLabel;
    row.addEventListener('click', onClick);
    return row;
  }

  async function renderProjectList() {
    cloudfileTitle.textContent = 'Open mcbCode Project';
    cloudfileList.innerHTML = '<div class="cloudfile-loading">loading your projects...</div>';
    try {
      const data = projectListCache || (projectListCache = await api('/projects'));
      cloudfileList.innerHTML = '';

      if (!data.projects.length && !data.collab_projects.length) {
        cloudfileList.innerHTML = '<div class="cloudfile-empty">no projects yet — create one on mcbcode.com first.</div>';
        return;
      }

      if (data.projects.length) {
        const label = document.createElement('div');
        label.className = 'cloudfile-section-label';
        label.textContent = 'Your Projects';
        cloudfileList.appendChild(label);
        data.projects.forEach(p => {
          cloudfileList.appendChild(cloudRow({
            icon: 'https://mcbcode.com/img/icons/folder.png',
            name: p.name,
            idLabel: `(${p.share_code})`,
            onClick: () => openProject(p.share_code, p.name)
          }));
        });
      }

      if (data.collab_projects.length) {
        const label = document.createElement('div');
        label.className = 'cloudfile-section-label';
        label.textContent = 'Collaborating On';
        cloudfileList.appendChild(label);
        data.collab_projects.forEach(p => {
          cloudfileList.appendChild(cloudRow({
            icon: 'https://mcbcode.com/img/icons/folder.png',
            name: p.name,
            idLabel: `(${p.share_code})`,
            onClick: () => openProject(p.share_code, p.name)
          }));
        });
      }
    } catch (e) {
      cloudfileList.innerHTML = `<div class="cloudfile-error">${e.message}</div>`;
    }
  }

  async function openProject(code, name) {
    cloudfileList.innerHTML = '<div class="cloudfile-loading">loading project...</div>';
    try {
      // the tree (names + folders only, no file contents) is fetched once per project per page load
      if (!projectTreeCache.has(code)) {
        const data = await api('/project?code=' + encodeURIComponent(code));
        projectTreeCache.set(code, data.files);
      }
      const files = projectTreeCache.get(code);
      cloudNav = { code, name, files, stack: [null] };
      currentProject = { code, name, files }; // the whole project now lives in the sidebar explorer
      collapsedFolders.clear();
      window.studioSyncBedrockProfile?.();
      cloudfileOverlay.classList.remove('show');
      document.getElementById('sidebar-wrap')?.classList.remove('collapsed');
      renderSidebarTree();
      window.refreshStudioSearch?.();
    } catch (e) {
      cloudfileList.innerHTML = `<div class="cloudfile-error">${e.message}</div>`;
    }
  }

  function renderFolder() {
    const parentId = cloudNav.stack[cloudNav.stack.length - 1];
    cloudfileTitle.textContent = cloudNav.name;
    cloudfileList.innerHTML = '';

    // back row: goes up a folder, or back to the project list if already at project root
    const backRow = cloudRow({
      icon: 'https://mcbcode.com/img/icons/folderup.png',
      name: '.. back',
      onClick: () => {
        if (cloudNav.stack.length > 1) {
          cloudNav.stack.pop();
          renderFolder();
        } else {
          cloudNav = null;
          renderProjectList();
        }
      }
    });
    cloudfileList.appendChild(backRow);

    const children = cloudNav.files.filter(f => (f.parent_id ?? null) === parentId);
    if (!children.length) {
      const empty = document.createElement('div');
      empty.className = 'cloudfile-empty';
      empty.textContent = 'empty folder';
      cloudfileList.appendChild(empty);
      return;
    }

    // folders first, then files, alphabetical within each
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    children.forEach(f => {
      if (f.type === 'folder') {
        cloudfileList.appendChild(cloudRow({
          icon: 'https://mcbcode.com/img/icons/folder.png',
          name: f.name,
          onClick: () => { cloudNav.stack.push(f.id); renderFolder(); }
        }));
      } else {
        cloudfileList.appendChild(cloudRow({
          icon: 'https://mcbcode.com/img/icons/file.png',
          name: f.name,
          idLabel: `(${f.id})`,
          onClick: () => openCloudFile(f)
        }));
      }
    });
  }

  async function openCloudFile(file) {
    if (mediaKindForFilename(file.name)) {
      const tabId = await openCloudMediaFile(file, cloudNav ? cloudNav.code : null);
      if (tabId) {
        cloudfileOverlay.classList.remove('show');
        renderSidebarTree();
        setActiveTreeFileByTabId(tabId);
      }
      return;
    }
    if (!file.save_id) {
      alert('file type unsupported');
      return;
    }
    cloudfileList.innerHTML = '<div class="cloudfile-loading">opening file...</div>';
    try {
      const data = await loadCloudFile(file.save_id);
      const id = 'cloud_' + file.save_id;
      openTab(id, file.name, data.content || '', file.save_id, file.id, cloudNav ? cloudNav.code : null);
      cloudfileOverlay.classList.remove('show');
      renderSidebarTree();
      setActiveTreeFileByTabId(id);
    } catch (e) {
      cloudfileList.innerHTML = `<div class="cloudfile-error">${e.message}</div>`;
    }
  }

  // ================= sidebar: real project file tree =================
  // show the real project tree when available; otherwise list only actual open tabs.
  let currentProject = null; // { code, name, files } — set by openProject() above
  const collapsedFolders = new Set(); // folder ids the user has manually collapsed

  function renderSidebarTree() {
    const sidebarContent = document.getElementById('sidebar-content');
    const sidebarTitle = document.getElementById('sidebar-title');

    if (!currentProject) {
      sidebarTitle.textContent = 'Explorer';
      sidebarContent.replaceChildren();
      const tabs = [...document.querySelectorAll('#tab-bar .tab')];
      if (!tabs.length) {
        const empty = document.createElement('div');
        empty.className = 'explorer-empty';
        empty.textContent = 'no files';
        sidebarContent.appendChild(empty);
      } else {
        tabs.forEach(tab => {
          const id = tab.dataset.tab;
          const label = tab.querySelector('.tab-label')?.textContent || 'untitled';
          const row = document.createElement('div');
          row.className = 'file-item' + (tab.classList.contains('active') ? ' active' : '');
          row.dataset.file = id;
          row.dataset.label = label;
          row.textContent = label;
          row.addEventListener('click', () => activateTab(id));
          sidebarContent.appendChild(row);
        });
      }
      window.studioRefreshSidebarTitle?.();
      window.updateStudioStatus?.();
      return;
    }

    sidebarTitle.textContent = currentProject.name;
    window.studioRefreshSidebarTitle?.();
    window.updateStudioStatus?.();
    sidebarContent.innerHTML = '';

    const backRow = document.createElement('div');
    backRow.id = 'sidebar-back-row';
    backRow.className = 'tree-row';
    backRow.innerHTML = `<img src="https://mcbcode.com/img/icons/folderup.png" alt=""><span>Close Project</span>`;
    backRow.addEventListener('click', () => {
      currentProject = null;
      window.studioSyncBedrockProfile?.();
      collapsedFolders.clear();
      sidebarTitle.textContent = 'Explorer';
      window.studioRefreshSidebarTitle?.();
      window.updateStudioStatus?.();
      window.refreshStudioSearch?.();
      renderSidebarTree();
    });
    sidebarContent.appendChild(backRow);

    const treeRoot = document.createElement('div');
    sidebarContent.appendChild(treeRoot);
    buildTreeLevel(treeRoot, null, 0);
    if (!currentProject.files.some(file => file.type === 'file')) {
      const empty = document.createElement('div');
      empty.className = 'explorer-empty';
      empty.textContent = 'no files';
      sidebarContent.appendChild(empty);
    }
  }
  window.renderStudioExplorer = renderSidebarTree;

  function buildTreeLevel(container, parentId, depth) {
    const children = currentProject.files
      .filter(f => (f.parent_id ?? null) === parentId)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    children.forEach(f => {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = (depth * 14 + 4) + 'px';

      if (f.type === 'folder') {
        const isCollapsed = collapsedFolders.has(f.id);
        row.classList.toggle('collapsed', isCollapsed);
        row.dataset.folderId = f.id;
        row.innerHTML = '<span class="tree-chevron">▾</span><img src="https://mcbcode.com/img/icons/folder.png" alt=""><span></span>';
        row.querySelector('span:last-child').textContent = f.name;
        container.appendChild(row);

        const childWrap = document.createElement('div');
        childWrap.className = 'tree-children' + (isCollapsed ? ' hidden' : '');
        container.appendChild(childWrap);
        buildTreeLevel(childWrap, f.id, depth + 1);

        row.addEventListener('click', () => {
          if (collapsedFolders.has(f.id)) collapsedFolders.delete(f.id);
          else collapsedFolders.add(f.id);
          renderSidebarTree();
        });
      } else {
        row.dataset.fileId = f.id;
        row.innerHTML = '<span class="tree-chevron"></span><img src="https://mcbcode.com/img/icons/file.png" alt=""><span></span>';
        row.querySelector('span:last-child').textContent = f.name;
        row.addEventListener('click', () => openProjectTreeFile(f));
        container.appendChild(row);
      }
    });
  }

  async function openProjectTreeFile(file) {
    if (currentProject && currentProject.localArchive) {
      await openLocalArchiveFile(file);
      return;
    }
    if (mediaKindForFilename(file.name)) {
      const tabId = await openCloudMediaFile(file, currentProject ? currentProject.code : null);
      if (tabId) setActiveTreeFileByTabId(tabId);
      return;
    }
    if (!file.save_id) {
      alert('file type unsupported');
      return;
    }
    const id = 'cloud_' + file.save_id;
    if (editors[id]) { activateTab(id); setActiveTreeFileByTabId(id); return; } // already open, no request needed
    try {
      const data = await loadCloudFile(file.save_id);
      openTab(id, file.name, data.content || '', file.save_id, file.id, currentProject ? currentProject.code : null);
      setActiveTreeFileByTabId(id);
    } catch (e) {
      alert("Couldn't open that file: " + e.message);
    }
  }

  // highlights whichever tree row matches the tab that's currently open, so the
  // sidebar shows what you're actually looking at
  function setActiveTreeFileByTabId(tabId) {
    if (!currentProject) return;
    const activeEntry = editors[tabId];
    const saveId = tabId.startsWith('cloud_') ? tabId.slice('cloud_'.length) : null;
    const mediaEntry = typeof mediaViewers !== 'undefined' ? mediaViewers[tabId] : null;
    const archiveFileId = (activeEntry && activeEntry.localArchiveFile ? String(activeEntry.localArchiveFile.fileId) : null)
      || (mediaEntry && mediaEntry.archiveFileId);
    const cloudMediaFileId = mediaEntry && mediaEntry.projectCode === currentProject.code ? mediaEntry.projectFileId : null;
    document.querySelectorAll('#sidebar-content .tree-row[data-file-id]').forEach(row => {
      const f = currentProject.files.find(x => String(x.id) === row.dataset.fileId);
      const isActive = f && (currentProject.localArchive
        ? String(f.id) === archiveFileId
        : (!!(saveId && f.save_id === saveId) || String(f.id) === cloudMediaFileId));
      row.classList.toggle('active', !!isActive);
    });
  }

  renderSidebarTree();
