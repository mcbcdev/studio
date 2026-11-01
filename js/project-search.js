// Explicit project-content search and review-first replacement.
(() => {
  const byId = id => document.getElementById(id);
  const input = byId('workspace-search');
  const regexToggle = byId('workspace-search-regex');
  const caseToggle = byId('workspace-search-case');
  const allButton = byId('workspace-search-all');
  const replaceInput = byId('workspace-search-replace');
  const previewButton = byId('workspace-search-preview-button');
  const previewRoot = byId('workspace-search-replace-preview');
  const status = byId('workspace-search-progress');
  const resultsRoot = byId('search-results');
  if (!input || !allButton || !resultsRoot) return;

  const MAX_FILES = 300;
  const MAX_FILE_CHARS = 2 * 1024 * 1024;
  const MAX_TOTAL_CHARS = 32 * 1024 * 1024;
  const MAX_REGEX_CHARS = 120;
  const TEXT_FILE = /\.(?:json|js|ts|mcfunction|txt|md|lang|mcmeta|xml|molang|material|properties|csv|ya?ml|geo|animation|anim|shader|fsh|vsh|h|c|cpp)$/i;
  let scannedFiles = null;
  let scanQuery = '';
  let scanOptions = '';
  let scanProject = '';
  let replacePlan = null;
  let scanToken = 0;
  let refreshTimer = null;

  function projectIdentity(project) {
    if (!project) return '';
    return String(project.code || project.workspace?.id || project.name || 'workspace');
  }

  function optionsKey() {
    return `${regexToggle?.checked ? 'regex' : 'literal'}:${caseToggle?.checked ? 'case' : 'ignore-case'}`;
  }

  function makePattern(query, global = false) {
    const source = regexToggle?.checked ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(source, `${regexToggle?.checked ? 'm' : ''}${caseToggle?.checked ? '' : 'i'}${global ? 'g' : ''}`);
  }

  function validateQuery(query) {
    if (regexToggle?.checked) {
      if (query.length > MAX_REGEX_CHARS) throw new Error(`Regular expressions are limited to ${MAX_REGEX_CHARS} characters.`);
      if (/\([^)]*[+*][^)]*\)[+*{]/.test(query) || /(?:\.\*|\.\+).*(?:\.\*|\.\+)/.test(query)) {
        throw new Error('Nested repetition and repeated wildcards are disabled for search safety.');
      }
    }
    return makePattern(query);
  }

  function getPath(file) {
    if (file?.virtualPath) return file.virtualPath;
    const project = typeof currentProject !== 'undefined' ? currentProject : null;
    if (!project || !Array.isArray(project.files)) return file?.name || '';
    const names = [file?.name || ''];
    let parentId = file?.parent_id;
    const visited = new Set();
    while (parentId != null && !visited.has(String(parentId))) {
      visited.add(String(parentId));
      const parent = project.files.find(entry => String(entry.id) === String(parentId));
      if (!parent) break;
      names.unshift(parent.name || '');
      parentId = parent.parent_id;
    }
    return names.join('/');
  }

  function findOpenEntry(file) {
    try {
      return Object.entries(editors).find(([, entry]) =>
        (entry.fileId != null && String(entry.fileId) === String(file.id)) ||
        (entry.saveId != null && file.save_id != null && String(entry.saveId) === String(file.save_id)) ||
        (entry.localArchiveFile?.fileId != null && String(entry.localArchiveFile.fileId) === String(file.id))
      ) || null;
    } catch (_) { return null; }
  }

  async function readFile(file) {
    const opened = findOpenEntry(file);
    if (opened) return opened[1].cm.getValue();
    if (file.zipEntry) return file.zipEntry.async('string');
    if (file.save_id && typeof api === 'function') {
      const saved = await loadCloudFile(file.save_id);
      return typeof saved?.content === 'string' ? saved.content : null;
    }
    return null;
  }

  function clearSearchState(message = '') {
    scanToken += 1;
    scannedFiles = null;
    scanQuery = '';
    scanOptions = '';
    scanProject = '';
    replacePlan = null;
    previewButton.disabled = true;
    previewRoot.replaceChildren();
    status.textContent = message;
  }

  function invalidateSearch() {
    clearSearchState(input.value.trim() ? 'Search all project files to include unopened contents.' : '');
  }

  function renderDeepResults() {
    if (!scannedFiles || scanQuery !== input.value.trim() || scanOptions !== optionsKey() ||
        scanProject !== projectIdentity(typeof currentProject !== 'undefined' ? currentProject : null)) return;

    resultsRoot.querySelectorAll('.search-empty').forEach(node => node.remove());
    resultsRoot.querySelectorAll('[data-project-content-results]').forEach(node => node.remove());
    const group = document.createElement('div');
    group.dataset.projectContentResults = 'true';
    const title = document.createElement('div');
    title.className = 'search-group-title';
    title.textContent = 'matches in project file contents';
    group.appendChild(title);

    let matchCount = 0;
    const query = scanQuery;
    for (const record of scannedFiles) {
      if (findOpenEntry(record.file)) continue;
      const lines = String(record.content).split('\n');
      const lineHits = [];
      for (let lineIndex = 0; lineIndex < lines.length && lineHits.length < 5; lineIndex += 1) {
        let pattern;
        try { pattern = makePattern(query, true); }
        catch (_) { return; }
        const matches = [...lines[lineIndex].matchAll(pattern)].slice(0, 3);
        matches.forEach(match => lineHits.push({ line: lines[lineIndex], lineIndex, ch: match.index || 0 }));
      }
      if (!lineHits.length) continue;
      lineHits.forEach(hit => {
        matchCount += 1;
        const button = document.createElement('button');
        button.className = 'search-result';
        button.type = 'button';
        const path = document.createElement('span');
        path.className = 'result-path';
        path.textContent = record.path;
        const snippet = document.createElement('span');
        snippet.className = 'result-snippet';
        snippet.textContent = hit.line.trim() || '(blank line)';
        const meta = document.createElement('span');
        meta.className = 'result-line';
        meta.textContent = `line ${hit.lineIndex + 1}`;
        button.append(path, snippet, meta);
        button.addEventListener('click', async () => {
          if (typeof openProjectTreeFile !== 'function') return;
          await openProjectTreeFile(record.file);
          const opened = findOpenEntry(record.file);
          if (!opened) return;
          const cm = opened[1].cm;
          cm.setCursor({ line: hit.lineIndex, ch: hit.ch });
          cm.scrollIntoView({ line: hit.lineIndex, ch: 0 }, 90);
          cm.focus();
        });
        group.appendChild(button);
      });
    }

    if (matchCount) resultsRoot.appendChild(group);
    else if (!resultsRoot.children.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No matches in project file contents.';
      resultsRoot.appendChild(empty);
    }
    const baseSummary = byId('search-summary');
    if (baseSummary) baseSummary.textContent = `${scannedFiles.length} project text file${scannedFiles.length === 1 ? '' : 's'} scanned · ${matchCount} content match${matchCount === 1 ? '' : 'es'}`;
  }

  async function searchAllProjectFiles() {
    const query = input.value.trim();
    const project = typeof currentProject !== 'undefined' ? currentProject : null;
    if (!project || !Array.isArray(project.files)) {
      status.textContent = 'Open a cloud project or imported pack to search project file contents.';
      return;
    }
    if (!query) {
      status.textContent = 'Enter a search term first.';
      input.focus();
      return;
    }
    try { validateQuery(query); }
    catch (error) {
      status.textContent = `Invalid regular expression: ${error.message}`;
      return;
    }

    const token = ++scanToken;
    scannedFiles = null;
    replacePlan = null;
    previewRoot.replaceChildren();
    previewButton.disabled = true;
    const allFiles = project.files.filter(file => file.type === 'file' && TEXT_FILE.test(file.name || ''));
    const files = allFiles.slice(0, MAX_FILES);
    if (!files.length) {
      status.textContent = 'No searchable text files in this project.';
      return;
    }

    const records = new Array(files.length);
    let nextIndex = 0;
    let completed = 0;
    let skipped = 0;
    let totalChars = 0;
    status.textContent = `searching 0 of ${files.length} text files…`;

    async function worker() {
      while (nextIndex < files.length) {
        const index = nextIndex++;
        const file = files[index];
        try {
          const content = await readFile(file);
          if (typeof content === 'string' && content.length <= MAX_FILE_CHARS && totalChars + content.length <= MAX_TOTAL_CHARS) {
            totalChars += content.length;
            records[index] = { file, path: getPath(file), content };
          } else skipped += 1;
        } catch (error) {
          skipped += 1;
          console.warn('Studio project search could not read a file:', file.name, error);
        }
        completed += 1;
        if (token === scanToken) status.textContent = `searching ${completed} of ${files.length} text files…`;
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    if (token !== scanToken) return;
    scannedFiles = records.filter(Boolean);
    scanQuery = query;
    scanOptions = optionsKey();
    scanProject = projectIdentity(project);
    previewButton.disabled = false;
    const truncated = allFiles.length > files.length ? `; limited to the first ${files.length} files` : '';
    status.textContent = `${scannedFiles.length} files scanned${skipped ? `; ${skipped} unavailable or beyond the size limits skipped` : ''}${truncated}. scan limits: ${MAX_FILES} files, 2 mb per file, 32 mb total. unopened cloud file contents were fetched only because you started this search.`;
    renderDeepResults();
  }

  function replacementFor(content, query, replacement) {
    const pattern = makePattern(query, true);
    const matches = [...String(content).matchAll(pattern)];
    if (!matches.length) return null;
    return { count: matches.length, updated: String(content).replace(pattern, replacement) };
  }

  function showReplacementPreview() {
    const query = input.value.trim();
    const project = typeof currentProject !== 'undefined' ? currentProject : null;
    if (!scannedFiles || scanQuery !== query || scanOptions !== optionsKey() || scanProject !== projectIdentity(project)) {
      status.textContent = 'Run Search all project files again before previewing replacements.';
      return;
    }
    const replacement = replaceInput.value;
    const items = [];
    try {
      scannedFiles.forEach(record => {
        const open = findOpenEntry(record.file);
        const original = open ? open[1].cm.getValue() : record.content;
        const result = replacementFor(original, query, replacement);
        if (result) items.push({ ...record, open, original, updated: result.updated, count: result.count });
      });
    } catch (error) {
      status.textContent = `Invalid regular expression: ${error.message}`;
      return;
    }
    replacePlan = { items, query, replacement, project: projectIdentity(project) };
    previewRoot.replaceChildren();
    const summary = document.createElement('div');
    summary.className = 'search-replace-summary';
    const total = items.reduce((sum, item) => sum + item.count, 0);
    summary.textContent = total
      ? `preview: ${total} replacement${total === 1 ? '' : 's'} across ${items.length} file${items.length === 1 ? '' : 's'}`
      : 'preview: no matching text to replace';
    previewRoot.appendChild(summary);
    items.slice(0, 12).forEach(item => {
      const row = document.createElement('div');
      row.className = 'search-replace-row';
      const path = document.createElement('strong');
      path.textContent = `${item.path} · ${item.count}`;
      const oldText = document.createElement('span');
      oldText.textContent = `− ${item.original.slice(0, 110).replace(/\s+/g, ' ')}`;
      const newText = document.createElement('span');
      newText.textContent = `+ ${item.updated.slice(0, 110).replace(/\s+/g, ' ')}`;
      row.append(path, oldText, newText);
      previewRoot.appendChild(row);
    });
    if (items.length > 12) {
      const more = document.createElement('div');
      more.className = 'panel-note';
      more.textContent = `and ${items.length - 12} more file${items.length - 12 === 1 ? '' : 's'}`;
      previewRoot.appendChild(more);
    }
    if (total) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'view-button primary';
      apply.textContent = 'Apply replacements';
      apply.addEventListener('click', applyReplacementPlan);
      previewRoot.appendChild(apply);
    }
  }

  async function applyReplacementPlan() {
    const plan = replacePlan;
    if (!plan || !plan.items.length) return;
    const project = typeof currentProject !== 'undefined' ? currentProject : null;
    if (!project || projectIdentity(project) !== plan.project) {
      status.textContent = 'The active project changed; run the search again before replacing.';
      return;
    }
    const total = plan.items.reduce((sum, item) => sum + item.count, 0);
    const cloud = !project.localArchive;
    const warning = cloud
      ? `Apply ${total} replacements across ${plan.items.length} files? This will save changes to the active mcbCode project.`
      : `Apply ${total} replacements across ${plan.items.length} files in the imported pack? Export the pack afterward to download the changes.`;
    if (!confirm(warning)) return;
    const applyButton = previewRoot.querySelector('button[type="button"]');
    if (applyButton) { applyButton.disabled = true; applyButton.textContent = 'Applying…'; }

    let applied = 0;
    let skipped = 0;
    for (const item of plan.items) {
      try {
        const opened = findOpenEntry(item.file);
        const current = opened ? opened[1].cm.getValue() : await readFile(item.file);
        if (current !== item.original) { skipped += 1; continue; }
        const fresh = replacementFor(current, plan.query, plan.replacement);
        if (!fresh) { skipped += 1; continue; }

        if (project.localArchive) {
          if (opened) {
            opened[1].cm.setValue(fresh.updated);
            await saveTab(opened[0]);
          } else {
            item.file.zip.file(item.file.zipPath, fresh.updated);
            item.file.zipEntry = item.file.zip.file(item.file.zipPath);
            project.workspace.hasChanges = true;
          }
        } else {
          if (!item.file.save_id) { skipped += 1; continue; }
          await api('/save', {
            method: 'POST',
            body: JSON.stringify({ save_id: item.file.save_id, content: fresh.updated, filename: item.file.name })
          });
          updateCloudFileCache(item.file.save_id, fresh.updated);
          if (opened) {
            opened[1].cm.setValue(fresh.updated);
            markDirty(opened[0], false);
          }
        }
        applied += fresh.count;
      } catch (error) {
        skipped += 1;
        console.warn('Studio project replace failed for', item.path, error);
      }
    }

    clearSearchState(`${applied} replacement${applied === 1 ? '' : 's'} applied${skipped ? `; ${skipped} file${skipped === 1 ? '' : 's'} skipped or failed` : ''}.`);
    window.refreshStudioSearch?.();
  }

  allButton.addEventListener('click', searchAllProjectFiles);
  previewButton.addEventListener('click', showReplacementPreview);
  replaceInput?.addEventListener('input', () => {
    if (!replacePlan) return;
    replacePlan = null;
    previewRoot.replaceChildren();
    status.textContent = 'Replacement changed; preview again before applying.';
  });
  input.addEventListener('input', () => {
    invalidateSearch();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(renderDeepResults, 0);
  });
  [regexToggle, caseToggle].filter(Boolean).forEach(toggle => toggle.addEventListener('change', () => {
    invalidateSearch();
    window.refreshStudioSearch?.();
  }));

  window.studioInvalidateProjectSearch = invalidateSearch;
  const originalRefresh = window.refreshStudioSearch;
  if (typeof originalRefresh === 'function') {
    window.refreshStudioSearch = function refreshStudioSearchWithProjectResults(...args) {
      originalRefresh.apply(this, args);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(renderDeepResults, 180);
    };
  }
})();
