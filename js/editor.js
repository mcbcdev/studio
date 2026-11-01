// ================= CodeMirror + cloud-file tracking =================
  CodeMirror.modeURL = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/%N/%N.min.js';

  // one entry per open tab id: { cm, saveId, dirty, fileId, projectCode }
  // saveId/fileId/projectCode are only set for files opened from the cloud browser —
  // that's what ties Ctrl+S and renaming back to the right database row.
  const editors = {};

  // tracks mcfunction editors so command completions only run for matching tabs
  const mcfunctionEditors = new Set();

  // lightweight .mcfunction linter — not a full command parser (that needs real per-command
  // grammar), just catches the syntax mistakes that silently break a function in-game:
  // unbalanced [] (selectors), {} (JSON text components in tellraw/title/etc), () and
  // unterminated quotes. Returns a short message for the gutter tooltip, or null if the
  // line looks fine.
  function checkMcfunctionLine(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) return null; // blank line / comment — nothing to check

    const pairs = [['[', ']', 'selector argument'], ['{', '}', 'JSON block'], ['(', ')', 'parenthesis']];
    for (const [open, close, label] of pairs) {
      let depth = 0;
      let inString = null;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (ch === '\\') { i++; continue; } // skip escaped char inside the string
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === '"' || ch === "'") { inString = ch; continue; }
        if (ch === open) depth++;
        else if (ch === close) depth--;
        if (depth < 0) return `Unmatched "${close}" \u2014 extra closing ${label}`;
      }
      if (depth > 0) return `Unclosed "${open}" \u2014 ${depth} ${label}${depth > 1 ? 's' : ''} not closed`;
    }

    // an unterminated quote (missing closing " or ') usually breaks the whole command
    let inString = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") inString = ch;
    }
    if (inString) return `Unclosed ${inString === '"' ? 'double' : 'single'} quote`;

    return null;
  }

  // ===== mcfunction highlighting =====
  // local tokenization avoids relying on cross-origin grammar JSON requests
  CodeMirror.defineMode('mcfunction', function () {
    return {
      startState: () => ({ command: null, argIndex: 0, awaitingNestedCommand: false, replaceItemKind: null }),
      token: function (stream, state) {
        if (stream.sol()) {
          state.command = null;
          state.argIndex = 0;
          state.awaitingNestedCommand = false;
          state.replaceItemKind = null;
        }
        if (stream.eatSpace()) return null;
        if (stream.peek() === '#') {
          stream.skipToEnd();
          return 'comment';
        }

        const token = stream.match(/"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s]+/)[0];
        if (token[0] === '"' || token[0] === "'") return 'string';
        if (!state.command || state.awaitingNestedCommand) {
          state.command = token.toLowerCase();
          state.argIndex = 0;
          state.awaitingNestedCommand = false;
          return 'keyword mcf-command';
        }

        const command = state.command;
        const value = token.toLowerCase();
        if (command === 'execute' && value === 'run') {
          state.awaitingNestedCommand = true;
          return 'keyword';
        }

        const argIndex = state.argIndex++;
        if (command === 'replaceitem' && argIndex === 0) state.replaceItemKind = value;
        if (/^@[aeprsv](?:\[[^\]]*\])?$/i.test(token)) return 'atom mcf-selector';
        if (argIndex === 0 && mcfunctionTargetCommands.has(command) && /^[A-Za-z0-9_]{1,36}$/.test(token)) return 'atom mcf-selector';
        if (command === 'replaceitem' && state.replaceItemKind === 'entity' && argIndex === 1 && /^[A-Za-z0-9_]{1,36}$/.test(token)) return 'atom mcf-selector';
        if (/^(?:[~^]-?\d*\.?\d*|-?\d+\.?\d*)(?:[bBsSlLfFdD])?$/.test(token)) return 'number';

        const isItemArgument = (command === 'give' || command === 'clear') && argIndex === 1 ||
          command === 'replaceitem' && (state.replaceItemKind === 'block' && argIndex >= 6 || state.replaceItemKind === 'entity' && argIndex >= 4);
        if (/^[a-z0-9_]+:[a-z0-9_./-]+$/i.test(token) || isItemArgument) return 'string mcf-item';
        if (/^(true|false)$/i.test(token)) return 'atom mcf-argument';
        return 'mcf-argument';
      }
    };
  });

  function mcfunctionDiagnostics(text) {
    return String(text || '').split('\n').flatMap((line, index) => {
      const message = checkMcfunctionLine(line);
      if (!message) return [];
      return [{
        from: CodeMirror.Pos(index, 0),
        to: CodeMirror.Pos(index, Math.max(1, line.length)),
        message,
        severity: 'error'
      }];
    });
  }

  function mcfunctionFilename(name) {
    return /\.mcfunction$/i.test(String(name || ''));
  }

  // grammar.js calls this after a command grammar request to refresh any open completions.
  function renderHighlight() {
    clearTimeout(window._mcfRehighlightTimer);
    window._mcfRehighlightTimer = setTimeout(() => {
      mcfunctionEditors.forEach(cm => {
        maybeShowMcfunctionHint(cm);
      });
    }, 100);
  }

  const mcfunctionCommandNames = `ability aimassist allowlist camera camerashake changesetting clear clearspawnpoint clone controlscheme damage daylock deop dialogue difficulty effect enchant event execute fill fog function gamemode gamerule give help hud inputpermission kick kill list locate loot me mobevent msg music op particle permission playanimation playsound recipe reload replaceitem ride say schedule scoreboard script scriptevent setblock setmaxplayers setworldspawn spawnpoint spreadplayers stopsound structure summon tag teleport tell tellraw testfor testforblock testforblocks tickingarea time title titleraw toggledownfall weather wb worldbuilder xp w tp`.split(/\s+/);
  const mcfunctionSelectors = ['@a', '@e', '@p', '@r', '@s', '@v'];
  const mcfunctionTargetCommands = new Set(['clear', 'damage', 'effect', 'enchant', 'give', 'kill', 'tag', 'teleport', 'tell', 'tellraw', 'title', 'tp', 'xp']);
  const mcfunctionGrammarLoads = new Set();

  function mcfPatternsFor(commandData) {
    if (Array.isArray(commandData.overloads)) return commandData.overloads.map(overload => overload.pattern).filter(Array.isArray);
    return Array.isArray(commandData.pattern) ? [commandData.pattern] : [];
  }

  function mcfExpectedAfter(commandData, completedArgs) {
    let patterns = mcfPatternsFor(commandData);
    let argIndex = 0;
    for (const arg of completedArgs) {
      const survivors = patterns.filter(pattern => {
        const expected = pattern[argIndex];
        return expected && typeof getHighlightClass === 'function' && getHighlightClass(arg, expected) !== 'hl-error';
      });
      if (!survivors.length) return [];

      const nested = [];
      survivors.forEach(pattern => {
        const expected = pattern[argIndex];
        if (Array.isArray(expected.pattern)) nested.push(expected.pattern);
        if (Array.isArray(expected.overloads)) {
          expected.overloads.forEach(overload => {
            if (Array.isArray(overload.pattern)) nested.push(overload.pattern);
          });
        }
      });
      patterns = survivors;
      if (nested.length) {
        patterns = nested;
        argIndex = 0;
      } else {
        argIndex++;
      }
    }
    return patterns.map(pattern => pattern[argIndex]).filter(Boolean);
  }

  function mcfSuggestionsForExpected(expected) {
    if (!expected || expected.type === 'item_id') return [];
    if (expected.type === 'target') return mcfunctionSelectors;
    if (!Array.isArray(expected.options)) return [];
    return expected.options.filter(option => typeof option === 'string' && option !== '*' && option.length > 0);
  }

  function mcfunctionFallbackSuggestions(command, args) {
    if ((mcfunctionTargetCommands.has(command) || command === 'spawnpoint') && args.length === 0) return mcfunctionSelectors;
    if (command === 'execute') {
      if (!args.length) return ['align', 'anchored', 'as', 'at', 'facing', 'if', 'in', 'on', 'positioned', 'rotated', 'run', 'summon', 'unless'];
      const last = args[args.length - 1].toLowerCase();
      if (['as', 'at', 'on', 'summon'].includes(last)) return mcfunctionSelectors;
      if (['as', 'at', 'positioned', 'rotated', 'facing', 'if', 'in', 'on', 'unless'].includes(last)) return ['align', 'anchored', 'as', 'at', 'facing', 'if', 'in', 'on', 'positioned', 'rotated', 'run', 'summon', 'unless'];
    }
    const firstArgOptions = {
      difficulty: ['peaceful', 'easy', 'normal', 'hard'],
      gamemode: ['survival', 'creative', 'adventure', 'spectator'],
      weather: ['clear', 'rain', 'thunder'],
      daylock: ['true', 'false'],
      toggledownfall: ['true', 'false']
    };
    if (args.length === 0 && firstArgOptions[command]) return firstArgOptions[command];
    if (command === 'time') {
      if (args.length === 0) return ['add', 'query', 'set'];
      if (args.length === 1 && args[0].toLowerCase() === 'set') return ['day', 'noon', 'night', 'sunrise', 'sunset'];
    }
    if (command === 'title' && args.length === 1) return ['actionbar', 'clear', 'reset', 'subtitle', 'title', 'times'];
    if (command === 'setblock' && args.length >= 4) return ['destroy', 'keep', 'replace'];
    if (command === 'fill' && args.length >= 6) return ['destroy', 'hollow', 'keep', 'outline', 'replace'];
    return [];
  }

  function requestMcfunctionGrammar(command) {
    if (!command || mcfunctionGrammarLoads.has(command) || typeof fetchCommandGrammar !== 'function') return;
    mcfunctionGrammarLoads.add(command);
    Promise.resolve(fetchCommandGrammar(command)).finally(() => mcfunctionGrammarLoads.delete(command));
  }

  function mcfunctionHintResult(cm) {
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    if (line.trimStart().startsWith('#')) return null;

    const wordPattern = /[A-Za-z0-9_:@.-]/;
    let fromCh = cursor.ch;
    let toCh = cursor.ch;
    while (fromCh > 0 && wordPattern.test(line[fromCh - 1])) fromCh--;
    while (toCh < line.length && wordPattern.test(line[toCh])) toCh++;
    const prefix = line.slice(fromCh, cursor.ch);
    const beforeWord = line.slice(0, fromCh).trim();

    let suggestions = [];
    if (!beforeWord) {
      if (prefix) {
        const cachedCommands = typeof commandCache !== 'undefined' ? Object.keys(commandCache) : [];
        suggestions = [...new Set([...mcfunctionCommandNames, ...cachedCommands])];
      }
    } else {
      const tokens = beforeWord.split(/\s+/);
      let command = tokens.shift().toLowerCase();
      let completedArgs = tokens;

      // After execute ... run, completion switches to the nested command's grammar.
      if (command === 'execute') {
        const runIndex = completedArgs.map(token => token.toLowerCase()).lastIndexOf('run');
        if (runIndex >= 0) {
          const nestedCommand = completedArgs[runIndex + 1];
          if (!nestedCommand) {
            suggestions = mcfunctionCommandNames;
            command = '';
          } else {
            command = nestedCommand.toLowerCase();
            completedArgs = completedArgs.slice(runIndex + 2);
          }
        }
      }

      if (command) {
        const commandData = typeof commandCache !== 'undefined' ? commandCache[command] : null;
        if (commandData) {
          const expected = mcfExpectedAfter(commandData, completedArgs);
          suggestions = [...new Set(expected.flatMap(mcfSuggestionsForExpected))];
        }
        if (!suggestions.length) suggestions = mcfunctionFallbackSuggestions(command, completedArgs);
        if (!commandData) requestMcfunctionGrammar(command);
      }
    }

    const matches = suggestions
      .filter(value => value.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 40)
      .map(value => ({ text: value, displayText: value }));
    return matches.length ? {
      list: matches,
      from: CodeMirror.Pos(cursor.line, fromCh),
      to: CodeMirror.Pos(cursor.line, toCh)
    } : null;
  }

  function maybeShowMcfunctionHint(cm) {
    if (!mcfunctionEditors.has(cm) || typeof CodeMirror.showHint !== 'function') return;
    const panel = cm.getWrapperElement().closest('.code-panel');
    if (!panel || !panel.classList.contains('active')) {
      if (cm.state.completionActive) cm.state.completionActive.close();
      return;
    }
    clearTimeout(cm._mcfHintTimer);
    cm._mcfHintTimer = setTimeout(() => {
      const result = mcfunctionHintResult(cm);
      if (result) {
        CodeMirror.showHint(cm, () => result, { completeSingle: false, alignWithWord: true, closeOnUnfocus: true });
      } else if (cm.state.completionActive) {
        cm.state.completionActive.close();
      }
    }, 60);
  }

  function modeDetailsForFilename(name) {
    const filename = String(name || '').split(/[\\/]/).pop() || '';
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext === 'mcfunction') return { mode: 'mcfunction', spec: 'mcfunction' };
    if (ext === 'json') return { mode: 'javascript', spec: { name: 'javascript', json: true } };

    const match = typeof CodeMirror.findModeByFileName === 'function'
      ? CodeMirror.findModeByFileName(filename)
      : null;
    if (!match || !match.mode || match.mode === 'null') return { mode: 'null', spec: 'text/plain' };
    return { mode: match.mode, spec: match.mime || match.mode };
  }

  // Use CodeMirror's full mode catalog rather than treating unrecognized files as JavaScript.
  function modeForFilename(name) {
    return modeDetailsForFilename(name).spec;
  }

  function lintOptionsForFilename(name) {
    if (mcfunctionFilename(name)) {
      return { getAnnotations: text => mcfunctionDiagnostics(text), async: false };
    }
    return lintableFilename(name)
      ? { esversion: 11, asi: true, undef: false, unused: false }
      : false;
  }

  function applyFilenameToEditor(id, cm, name) {
    const details = modeDetailsForFilename(name);
    cm.setOption('mode', details.spec);
    if (details.mode !== 'null' && details.mode !== 'mcfunction' && typeof CodeMirror.autoLoadMode === 'function') {
      CodeMirror.autoLoadMode(cm, details.mode);
    }

    const isMcfunction = details.mode === 'mcfunction';
    if (isMcfunction) {
      mcfunctionEditors.add(cm);
    } else {
      mcfunctionEditors.delete(cm);
      if (cm.state.completionActive) cm.state.completionActive.close();
    }

    const preferences = window.studioPreferences || { lineNumbers: true };
    const gutters = [];
    if (preferences.lineNumbers) gutters.push('CodeMirror-linenumbers');
    if (lintableFilename(name)) gutters.push('CodeMirror-lint-markers');
    cm.setOption('gutters', gutters);
    cm.setOption('lint', lintOptionsForFilename(name));
  }

  // JavaScript/JSON use JSHint; .mcfunction uses the conservative Bedrock checks above.
  function lintableFilename(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ext === 'js' || ext === 'json' || ext === '' || ext === 'mcfunction';
  }

  function markDirty(id, dirty) {
    const entry = editors[id];
    if (!entry) return;
    entry.dirty = dirty;
    if (dirty && entry.localArchiveFile) entry.localArchiveFile.workspace.hasChanges = true;
    const tab = document.querySelector(`.tab[data-tab="${id}"]`);
    if (tab) tab.classList.toggle('dirty', !!(dirty && entry.saveId));
    const dot = document.querySelector(`.code-panel[data-panel="${id}"] .save-state-dot`);
    if (dot) dot.classList.toggle('unsaved', dirty);
  }

  // ================= find & replace =================
  // per-tab state, keyed by tab id, so switching tabs never mixes up one panel's
  // search with another's: { marks: [CodeMirror TextMarker], matches: [{from,to}], currentIndex }
  const findReplaceState = {};

  function getFrEls(id) {
    const panel = document.querySelector(`.code-panel[data-panel="${id}"]`);
    if (!panel) return null;
    return {
      panel,
      bar: panel.querySelector('.find-replace-bar'),
      findInput: panel.querySelector('.fr-find-input'),
      replaceInput: panel.querySelector('.fr-replace-input'),
      replaceRow: panel.querySelector('.fr-replace-row'),
      count: panel.querySelector('.fr-count')
    };
  }

  function openFindReplace(id, showReplace) {
    const entry = editors[id];
    const els = getFrEls(id);
    if (!entry || !els) return;

    els.bar.classList.add('show');
    if (showReplace) els.replaceRow.classList.remove('hidden');

    // pre-fill the find box with the current selection, like most editors do
    const sel = entry.cm.getSelection();
    if (sel && !sel.includes('\n')) els.findInput.value = sel;

    els.findInput.focus();
    els.findInput.select();

    runSearch(id);
  }

  function closeFindReplace(id) {
    const entry = editors[id];
    const els = getFrEls(id);
    if (!entry || !els) return;
    els.bar.classList.remove('show');
    els.replaceRow.classList.add('hidden');
    clearMatches(id);
    entry.cm.focus();
  }

  function clearMatches(id) {
    const state = findReplaceState[id];
    if (!state) return;
    state.marks.forEach(m => m.clear());
    state.marks = [];
    state.matches = [];
    state.currentIndex = -1;
  }

  function runSearch(id) {
    const entry = editors[id];
    const els = getFrEls(id);
    if (!entry || !els) return;

    clearMatches(id);
    const query = els.findInput.value;
    const state = findReplaceState[id] || (findReplaceState[id] = { marks: [], matches: [], currentIndex: -1 });

    if (!query) {
      els.count.textContent = '0/0';
      els.count.classList.remove('no-matches');
      return;
    }

    const cm = entry.cm;
    const cursor = cm.getSearchCursor(query, { line: 0, ch: 0 }, { caseFold: true });
    while (cursor.findNext()) {
      const from = cursor.from(), to = cursor.to();
      state.marks.push(cm.markText(from, to, { className: 'cm-fr-match' }));
      state.matches.push({ from, to });
    }

    if (!state.matches.length) {
      els.count.textContent = '0/0';
      els.count.classList.add('no-matches');
      state.currentIndex = -1;
      return;
    }
    els.count.classList.remove('no-matches');

    // land on the match closest to (or after) the cursor, not always the first in the doc
    const cursorPos = cm.getCursor();
    let startIndex = state.matches.findIndex(m =>
      m.from.line > cursorPos.line || (m.from.line === cursorPos.line && m.from.ch >= cursorPos.ch)
    );
    if (startIndex === -1) startIndex = 0;

    goToMatch(id, startIndex);
  }

  function goToMatch(id, index) {
    const entry = editors[id];
    const els = getFrEls(id);
    const state = findReplaceState[id];
    if (!entry || !els || !state || !state.matches.length) return;

    // un-highlight the previous "current" match back to a normal match
    if (state.currentIndex >= 0 && state.marks[state.currentIndex]) {
      const old = state.marks[state.currentIndex];
      const pos = old.find();
      old.clear();
      if (pos) state.marks[state.currentIndex] = entry.cm.markText(pos.from, pos.to, { className: 'cm-fr-match' });
    }

    const len = state.matches.length;
    state.currentIndex = ((index % len) + len) % len;

    const mark = state.marks[state.currentIndex];
    const pos = mark.find();
    if (!pos) return;
    mark.clear();
    state.marks[state.currentIndex] = entry.cm.markText(pos.from, pos.to, { className: 'cm-fr-match cm-fr-match-current' });

    entry.cm.scrollIntoView(pos, 60);
    entry.cm.setSelection(pos.from, pos.to);
    els.count.textContent = `${state.currentIndex + 1}/${len}`;
  }

  function findNext(id) {
    const state = findReplaceState[id];
    if (!state || !state.matches.length) return;
    goToMatch(id, state.currentIndex + 1);
  }
  function findPrev(id) {
    const state = findReplaceState[id];
    if (!state || !state.matches.length) return;
    goToMatch(id, state.currentIndex - 1);
  }

  function replaceOne(id) {
    const entry = editors[id];
    const els = getFrEls(id);
    const state = findReplaceState[id];
    if (!entry || !els || !state || !state.matches.length || state.currentIndex < 0) return;

    const mark = state.marks[state.currentIndex];
    const pos = mark.find();
    if (!pos) return;

    entry.cm.replaceRange(els.replaceInput.value, pos.from, pos.to);
    runSearch(id); // positions shift after a replace, so re-scanning is the simplest way to stay correct
  }

  function replaceAll(id) {
    const entry = editors[id];
    const els = getFrEls(id);
    const state = findReplaceState[id];
    if (!entry || !els || !state || !state.matches.length) return;

    const replacement = els.replaceInput.value;
    entry.cm.operation(() => {
      // replace back-to-front so earlier match positions stay valid as we go
      for (let i = state.matches.length - 1; i >= 0; i--) {
        const m = state.matches[i];
        entry.cm.replaceRange(replacement, m.from, m.to);
      }
    });
    runSearch(id);
  }

  // wires up the buttons/inputs inside one tab's find-replace-bar (built fresh per tab in openTab)
  function wireFindReplaceBar(id, findBar) {
    const findInput = findBar.querySelector('.fr-find-input');
    const replaceInput = findBar.querySelector('.fr-replace-input');
    const replaceRow = findBar.querySelector('.fr-replace-row');

    findInput.addEventListener('input', () => runSearch(id));
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) findPrev(id); else findNext(id);
      } else if (e.key === 'Escape') {
        closeFindReplace(id);
      }
    });

    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceOne(id);
      } else if (e.key === 'Escape') {
        closeFindReplace(id);
      }
    });

    findBar.querySelector('.fr-prev').addEventListener('click', () => findPrev(id));
    findBar.querySelector('.fr-next').addEventListener('click', () => findNext(id));
    findBar.querySelector('.fr-toggle-replace').addEventListener('click', () => {
      replaceRow.classList.toggle('hidden');
      if (!replaceRow.classList.contains('hidden')) replaceInput.focus();
    });
    findBar.querySelector('.fr-close').addEventListener('click', () => closeFindReplace(id));
    findBar.querySelector('.fr-replace-one').addEventListener('click', () => replaceOne(id));
    findBar.querySelector('.fr-replace-all').addEventListener('click', () => replaceAll(id));
  }

  // ================= tabs: opening =================
  // saveId/fileId/projectCode: pass these for cloud files so Ctrl+S syncs content
  // and renaming syncs the filename back to the right project. leave them undefined
  // for local/new/scratch files (Save just shows a "can't save" note; rename stays local-only).
  function openTab(id, label, content, saveId, fileId, projectCode, localArchiveFile) {
    let tab = document.querySelector(`.tab[data-tab="${id}"]`);

    if (!tab) {
      // build the tab
      tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.tab = id;
      tab.innerHTML = '<span class="dirty-dot"></span><span class="tab-label"></span><span class="close-btn"></span>';
      tab.querySelector('.tab-label').textContent = label;
      tab.querySelector('.close-btn').textContent = '\u00d7';
      tab.querySelector('.close-btn').dataset.close = id;
      tabBar.appendChild(tab);

      // build the matching code panel: optional cloud-status strip + CodeMirror
      const panel = document.createElement('div');
      panel.className = 'code-panel';
      panel.dataset.panel = id;

      const status = document.createElement('div');
      status.className = 'code-status';
      if (saveId || localArchiveFile) {
        status.classList.add('show');
        // green dot = saved, red dot = unsaved changes, toggled by markDirty()
        const saveMessage = saveId ? 'synced to your mcbCode account' : 'saved in imported pack \u2014 export pack to download';
        status.innerHTML = `<span class="save-state-dot"></span><span>${saveMessage}</span><button class="save-btn">Save</button>`;
        status.querySelector('.save-btn').addEventListener('click', () => saveTab(id));
      }
      panel.appendChild(status);

      const findBar = document.createElement('div');
      findBar.className = 'find-replace-bar';
      findBar.innerHTML = `
        <div class="fr-row">
          <input type="text" class="fr-find-input" placeholder="Find">
          <span class="fr-count">0/0</span>
          <button class="fr-prev" title="Previous match">\u02c4</button>
          <button class="fr-next" title="Next match">\u02c5</button>
          <button class="fr-toggle-replace" title="Toggle replace">\u21c4</button>
          <button class="fr-close" title="Close">&times;</button>
        </div>
        <div class="fr-row fr-replace-row hidden">
          <input type="text" class="fr-replace-input" placeholder="Replace">
          <button class="fr-replace-one">Replace</button>
          <button class="fr-replace-all">Replace All</button>
        </div>
      `;
      panel.appendChild(findBar);
      wireFindReplaceBar(id, findBar);

      const editorWrap = document.createElement('div');
      editorWrap.className = 'code-editor';
      panel.appendChild(editorWrap);
      codeArea.appendChild(panel);

      const isLintable = lintableFilename(label);
      const preferences = window.studioPreferences || { fontSize: 14, tabSize: 2, lineNumbers: true, softWrap: false };
      const tabSize = preferences.tabSize === 'tab' ? 4 : Number(preferences.tabSize) || 2;
      const gutters = [];
      if (preferences.lineNumbers) gutters.push('CodeMirror-linenumbers');
      if (isLintable) gutters.push('CodeMirror-lint-markers');

      const cm = CodeMirror(editorWrap, {
        value: content,
        mode: modeForFilename(label),
        lineNumbers: preferences.lineNumbers,
        theme: 'default',
        keyMap: 'sublime',        // unlocks multi-cursor shortcuts (see the Shortcuts menu)
        matchBrackets: true,
        styleActiveLine: true,
        indentUnit: tabSize,
        tabSize,
        indentWithTabs: preferences.tabSize === 'tab',
        lineWrapping: preferences.softWrap,
        gutters,
        lint: false,
        extraKeys: {
          'Shift-Tab': 'indentLess',
          'Ctrl-S': () => saveTab(id),
          'Cmd-S': () => saveTab(id),
          'Ctrl-F': () => openFindReplace(id, false),
          'Cmd-F': () => openFindReplace(id, false),
          'Ctrl-H': () => openFindReplace(id, true),
          'Cmd-Alt-F': () => openFindReplace(id, true),
          'Esc': () => closeFindReplace(id)
        }
      });

      cm.getWrapperElement().style.fontSize = `${preferences.fontSize || 14}px`;
      editors[id] = { cm, saveId: saveId || null, fileId: fileId || null, projectCode: projectCode || null, localArchiveFile: localArchiveFile || null, dirty: false };
      applyFilenameToEditor(id, cm, label);
      window.studioBedrockEditorReady?.(id, cm, label);
      window.studioGeometryEditorReady?.(id, cm, label, panel);
      cm.on('change', () => {
        markDirty(id, true);
        window.studioInvalidateProjectSearch?.();
        window.refreshStudioSearch?.();
      });

      cm.on('inputRead', () => maybeShowMcfunctionHint(cm));

      attachTabEvents(tab);
      attachCloseEvent(tab.querySelector('.close-btn'));
      attachRenameEvent(tab.querySelector('.tab-label'), id);
    }

    activateTab(id);
    window.refreshStudioSearch?.();
    window.updateStudioStatus?.();
    window.renderStudioExplorer?.();
  }

  // generates a unique tab id for files opened outside the sidebar (local files, new blank files, cloud files)
  let dynamicTabCounter = 1;
  function nextDynamicId() {
    return `dyn${dynamicTabCounter++}`;
  }

  function attachTabEvents(tab) {
    tab.draggable = true;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('close-btn')) return;
      if (e.target.isContentEditable) return;
      activateTab(tab.dataset.tab);
    });
  }

  // ================= saving =================
  // syncs a tab's current content to the matching `saves` row via POST /save.
  // this is the same endpoint the main site uses, so anything saved here shows
  // up back on mcbcode.com immediately.
  async function saveTab(id) {
    const entry = editors[id];
    if (!entry) return;
    const dot = document.querySelector(`.code-panel[data-panel="${id}"] .save-state-dot`);

    if (entry.localArchiveFile) {
      const localFile = entry.localArchiveFile;
      localFile.zip.file(localFile.zipPath, entry.cm.getValue());
      if (localFile.treeFile) localFile.treeFile.zipEntry = localFile.zip.file(localFile.zipPath);
      markDirty(id, false);
      return;
    }
    if (!entry.saveId) {
      // local/new file — nothing on the server to sync to
      alert("This isn't a cloud file, so there's nothing to sync it to yet \u2014 save/download it locally instead.");
      return;
    }
    const tabLabelEl = document.querySelector(`.tab[data-tab="${id}"] .tab-label`);
    const filename = tabLabelEl ? tabLabelEl.textContent : 'untitled';

    try {
      await api('/save', {
        method: 'POST',
        body: JSON.stringify({ save_id: entry.saveId, content: entry.cm.getValue(), filename })
      });
      updateCloudFileCache(entry.saveId, entry.cm.getValue());
      markDirty(id, false);
    } catch (e) {
      if (dot) dot.title = 'save failed: ' + e.message;
      alert("Couldn't save: " + e.message);
    }
  }

  function saveActiveTab() {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) saveTab(activeTab.dataset.tab);
  }

  // warn before closing/refreshing the browser tab if anything is unsaved
  window.addEventListener('beforeunload', (e) => {
    const anyDirty = Object.values(editors).some(entry => entry.dirty)
      || (typeof archiveWorkspaces !== 'undefined' && [...archiveWorkspaces].some(workspace => workspace.hasChanges));
    if (anyDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ================= tabs: renaming (double-click the label) =================
  // for cloud files (opened from the file browser or the project tree), this also
  // renames the real file server-side via POST /project/file, using the same
  // file_id + project_code the file was opened with. local/scratch files just
  // rename locally since there's nothing on the server to rename.
  function attachRenameEvent(labelEl, id) {
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      labelEl.contentEditable = 'true';
      labelEl.focus();
      const range = document.createRange();
      range.selectNodeContents(labelEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    let originalName = labelEl.textContent;
    labelEl.addEventListener('focus', () => { originalName = labelEl.textContent; });

    async function finishRename() {
      labelEl.contentEditable = 'false';
      const newName = labelEl.textContent.trim() || 'untitled';
      labelEl.textContent = newName;

      if (newName === originalName) return;

      // keep the open-tab Explorer label in sync with the renamed tab
      const fileItem = document.querySelector(`.file-item[data-file="${id}"]`);
      if (fileItem) {
        fileItem.textContent = newName;
        fileItem.dataset.label = newName;
      }
      window.renderStudioExplorer?.();

      const entry = editors[id];
      if (entry) applyFilenameToEditor(id, entry.cm, newName);
      if (!entry || !entry.fileId || !entry.projectCode) return; // not a cloud file, local rename only

      try {
        await api('/project/file', {
          method: 'POST',
          body: JSON.stringify({
            project_code: entry.projectCode,
            file_id: entry.fileId,
            name: newName,
            type: 'file',
            content: entry.cm.getValue()
          })
        });
        if (entry.saveId) updateCloudFileCache(entry.saveId, entry.cm.getValue());
        // keep the in-memory project file lists in sync so the sidebar tree
        // and cloud browser show the new name without needing a refetch
        [currentProject, cloudNav].forEach(proj => {
          if (!proj) return;
          const f = proj.files.find(x => x.id === entry.fileId);
          if (f) f.name = newName;
        });
        renderSidebarTree();
      } catch (err) {
        labelEl.textContent = originalName; // revert on failure
        if (fileItem) {
          fileItem.textContent = originalName;
          fileItem.dataset.label = originalName;
        }
        if (entry) applyFilenameToEditor(id, entry.cm, originalName);
        alert("Couldn't rename that file: " + err.message);
      }
    }

    labelEl.addEventListener('blur', finishRename);
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        labelEl.blur();
      }
      if (e.key === 'Escape') {
        labelEl.textContent = originalName;
        labelEl.blur();
      }
    });
  }

  // ================= tabs: closing =================
  function attachCloseEvent(btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.close;
      const entry = editors[id];

      if (entry && entry.dirty) {
        const ok = confirm('This tab has unsaved changes. Close anyway?');
        if (!ok) return;
      }

      const tab = document.querySelector(`.tab[data-tab="${id}"]`);
      const panel = document.querySelector(`.code-panel[data-panel="${id}"]`);
      const wasActive = tab.classList.contains('active');

      window.studioRemoveSplitTab?.(id);
      tab.remove();
      if (panel) panel.remove();
      if (entry) {
        mcfunctionEditors.delete(entry.cm);
        entry.geometryPreview?.dispose?.();
      }
      if (typeof disposeMediaTab === 'function') disposeMediaTab(id);
      delete editors[id];
      delete findReplaceState[id];
      document.querySelector(`.file-item[data-file="${id}"]`)?.classList.remove('active');

      // if the closed tab was active, activate the first remaining tab
      const splitTabs = window.studioGetSplitTabs?.() || [];
      const nextTab = splitTabs.length
        ? document.querySelector(`.tab[data-tab="${CSS.escape(splitTabs[0])}"]`)
        : document.querySelector('.tab');
      if (wasActive && nextTab) {
        activateTab(nextTab.dataset.tab);
      } else {
        if (wasActive) setActiveTreeFileByTabId('');
        updateWelcomeVisibility();
      }
      window.refreshStudioSearch?.();
      window.updateStudioStatus?.();
      window.renderStudioExplorer?.();
    });
  }

  // ================= sidebar: clicking a file opens/activates its tab =================
  document.querySelectorAll('.file-item').forEach(file => {
    file.addEventListener('click', () => {
      const id = file.dataset.file;
      const label = file.dataset.label;
      const content = file.dataset.content;
      openTab(id, label, content);
    });
  });

  updateWelcomeVisibility();

  // ================= account popup =================
  const accountIcon = document.getElementById('account-icon');
  const accountPopup = document.getElementById('account-popup');

  accountIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    accountPopup.classList.toggle('show');
  });
  document.addEventListener('click', (event) => {
    if (!accountPopup.contains(event.target) && !accountIcon.contains(event.target)) {
      accountPopup.classList.remove('show');
    }
  });

  // ================= welcome panel buttons =================
  const openfileOverlay = document.getElementById('openfile-overlay');
  // "Open File" button -> shows the local / mcbCode / pack choice popup
  document.getElementById('btn-open-file').addEventListener('click', () => {
    openfileOverlay.classList.add('show');
  });
  document.getElementById('openfile-close').addEventListener('click', () => {
    openfileOverlay.classList.remove('show');
  });
  // "Open mcbCode Project" -> opens the project picker (needs login)
  document.getElementById('btn-open-mcbcode').addEventListener('click', () => {
    openfileOverlay.classList.remove('show');
    openCloudBrowser();
  });

  // "Login" button on the welcome screen: if already logged in, just pop the account
  // popup instead of redirecting somewhere pointless
  document.getElementById('btn-login').addEventListener('click', () => {
    if (currentUser) {
      accountPopup.classList.add('show');
    } else {
      window.location.href = 'https://mcbcode.com/account?redirectto=https://studio.mcbcode.com';
    }
  });

  // "New Blank File" -> opens an empty scratch tab to start typing in right away
  document.getElementById('btn-new-file').addEventListener('click', () => {
    const id = nextDynamicId();
    openTab(id, 'untitled', '');
  });

  window.studioRunEditorCommand = function (command, id) {
    const tab = id ? document.querySelector(`.tab[data-tab="${CSS.escape(id)}"]`) : document.querySelector('.tab.active');
    const entry = tab ? editors[tab.dataset.tab] : null;
    if (entry && ['undo', 'redo', 'selectAll'].includes(command)) entry.cm.execCommand(command);
  };
  window.studioGetEditor = id => editors[id]?.cm || null;
  window.studioSaveTab = id => saveTab(id);
  window.studioOpenActiveFind = function (id) {
    const tab = id ? document.querySelector(`.tab[data-tab="${CSS.escape(id)}"]`) : document.querySelector('.tab.active');
    if (tab) openFindReplace(tab.dataset.tab, false);
  };
