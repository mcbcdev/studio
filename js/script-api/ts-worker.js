/*
 * mcbCode Studio - Bedrock Script API language worker.
 *
 * Runs the TypeScript language service (js/script-api/typescript.min.js) against the official
 * @minecraft/* declaration files (js/script-api/definitions/) entirely inside the browser.
 * It never touches the page: bedrock-script-api.js sends it the text of the open .js files and asks for
 * completions, hover docs, signature help and diagnostics.
 */
'use strict';

// everything lives inside a function so our own `ts` binding cannot clash with the `var ts` that typescript.min.js defines
(function () {

let ts = null;

const NM = '/node_modules/@minecraft/';
const LIB = '/lib/';
const PROJECT = '/project/';
const STUBS = '/stubs/';
const FORMAT = { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: '\n', semicolons: 'ignore' };

const state = {
  base: '',
  libs: {},
  manifest: null,
  betaOnly: {},
  betaSets: {},
  channel: 'stable',
  defs: new Map(),       // virtual path -> text (declaration files, package.json stubs, runtime globals)
  defRoots: [],
  unavailable: [],       // @minecraft modules that have no release in the current channel
  files: new Map(),      // virtual path -> { text, version }
  snapshots: new Map(),
  projectVersion: 0,
  defGeneration: 0,
  fileCounter: 0,
  service: null,
  exportIndex: null
};

function getJson(url) {
  return fetch(url).then(r => { if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.json(); });
}
function getText(url) {
  return fetch(url).then(r => { if (!r.ok) throw new Error(`${url} -> ${r.status}`); return r.text(); });
}

// ---------------------------------------------------------------- virtual file system

function dirOf(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }

function hasFile(p) {
  return state.files.has(p) || state.defs.has(p) || (p.startsWith(LIB) && Object.prototype.hasOwnProperty.call(state.libs, p.slice(LIB.length)));
}
function readVirtual(p) {
  const f = state.files.get(p);
  if (f) return f.text;
  if (state.defs.has(p)) return state.defs.get(p);
  if (p.startsWith(LIB)) return state.libs[p.slice(LIB.length)];
  return undefined;
}
function allPaths() {
  return [...state.files.keys(), ...state.defs.keys()];
}
function hasDirectory(d) {
  d = d.replace(/\/$/, '');
  if (d === '' || d === '/') return true;
  return allPaths().some(p => p.startsWith(d + '/')) || d === LIB.slice(0, -1);
}
function childDirectories(d) {
  d = d.replace(/\/$/, '') + '/';
  const out = new Set();
  for (const p of allPaths()) {
    if (!p.startsWith(d)) continue;
    const rest = p.slice(d.length);
    const i = rest.indexOf('/');
    if (i > 0) out.add(rest.slice(0, i));
  }
  return [...out];
}

function snapshotFor(p) {
  const text = readVirtual(p);
  if (text === undefined) return undefined;
  const version = state.files.has(p) ? state.files.get(p).version : (state.defs.has(p) ? 'd' + state.defGeneration : 0);
  const cached = state.snapshots.get(p);
  if (cached && cached.version === version && cached.text === text) return cached.snapshot;
  const snapshot = ts.ScriptSnapshot.fromString(text);
  state.snapshots.set(p, { version, text, snapshot });
  return snapshot;
}

function compilerOptions() {
  return {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    strict: false,
    strictNullChecks: true,
    noImplicitAny: false,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    allowNonTsExtensions: true,
    types: [],
    maxNodeModuleJsDepth: 0
  };
}

function rootNames() {
  return [...state.files.keys(), ...state.defRoots, STUBS + 'runtime-globals.d.ts', STUBS + 'unavailable.d.ts'];
}

function createService() {
  const host = {
    getCompilationSettings: compilerOptions,
    getProjectVersion: () => String(state.projectVersion),
    getScriptFileNames: rootNames,
    getScriptVersion: p => state.files.has(p) ? String(state.files.get(p).version) : (state.defs.has(p) ? 'd' + state.defGeneration : '0'),
    getScriptSnapshot: snapshotFor,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => LIB + 'lib.es2022.d.ts',
    fileExists: hasFile,
    readFile: readVirtual,
    directoryExists: hasDirectory,
    getDirectories: childDirectories,
    readDirectory: () => [],
    realpath: p => p,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n'
  };
  state.service = ts.createLanguageService(host, ts.createDocumentRegistry());
}

// ---------------------------------------------------------------- definitions / channels

async function loadChannel(channel) {
  const info = state.manifest.channels[channel];
  if (!info) throw new Error(`Unknown Script API channel "${channel}"`);
  const defs = new Map();
  const roots = [];
  const jobs = [];
  for (const [name, pkg] of Object.entries(info.packages)) {
    const base = name.split('/')[1];
    const dir = `${NM}${base}/`;
    defs.set(dir + 'package.json', JSON.stringify({ name, version: pkg.version, types: pkg.entry }));
    for (const file of pkg.files) {
      jobs.push(getText(`${state.base}definitions/${pkg.dir}/${file}`).then(text => {
        defs.set(dir + file, text);
        if (file === pkg.entry) roots.push(dir + file);
      }));
    }
  }
  await Promise.all(jobs);
  // modules with no release in this channel resolve to `any` so they do not cascade into noise;
  // an explicit diagnostic explains why (see diagnostics()).
  const stub = info.unavailable.map(n => `declare module "${n}";`).join('\n') || '// no unavailable modules';
  defs.set(STUBS + 'unavailable.d.ts', stub);
  defs.set(STUBS + 'runtime-globals.d.ts', state.runtimeGlobals);
  state.defs = defs;
  state.defRoots = roots.sort();
  state.unavailable = info.unavailable.slice();
  state.channel = channel;
  state.exportIndex = null;
  state.snapshots.clear();
  state.defGeneration++;
  state.projectVersion++;
}

function betaSet(moduleName) {
  if (!state.betaSets[moduleName]) {
    const entry = state.betaOnly[moduleName];
    const names = Array.isArray(entry) ? entry : (entry && entry.names) || [];
    state.betaSets[moduleName] = { whole: !!(entry && entry.wholeModule), names: new Set(names) };
  }
  return state.betaSets[moduleName];
}
// true when a name (Foo, or Foo.bar) exists in the beta definitions but not in the stable ones
function isBetaOnlyName(moduleName, name) {
  return betaSet(moduleName).names.has(name);
}
// beta-only for display: the whole module is beta-only, or this exact name is
function isBetaOnly(moduleName, qualified) {
  const s = betaSet(moduleName);
  return s.whole || s.names.has(qualified);
}

// ---------------------------------------------------------------- helpers

const partsToString = parts => (parts && ts.displayPartsToString(parts)) || '';

function tagsOf(tags) {
  return (tags || []).map(t => ({ name: t.name, text: partsToString(t.text) }));
}

function nodeAt(sf, pos) {
  let found = sf;
  (function visit(n) {
    ts.forEachChild(n, child => {
      if (child.getStart(sf) <= pos && pos < child.getEnd()) { found = child; visit(child); return true; }
      return undefined;
    });
  })(sf);
  return found;
}
function exactNode(sf, start, length) {
  let found = null;
  (function visit(n) {
    ts.forEachChild(n, child => {
      const s = child.getStart(sf);
      const e = child.getEnd();
      if (s === start && e === start + length) { found = child; }
      if (s <= start && start + length <= e) { visit(child); return true; }
      return undefined;
    });
  })(sf);
  return found;
}

function realSymbol(checker, sym) {
  if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
    try { return checker.getAliasedSymbol(sym) || sym; } catch (e) { return sym; }
  }
  return sym;
}
function apiOfSymbol(sym) {
  const decl = sym && sym.declarations && sym.declarations[0];
  if (!decl) return null;
  const file = decl.getSourceFile().fileName;
  if (!file.startsWith(NM)) return null;
  const module = '@minecraft/' + file.slice(NM.length).split('/')[0];
  const parent = decl.parent;
  const containerName = parent && parent.name && parent.name.text && (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent)) ? parent.name.text : '';
  const name = sym.getName();
  return { module, name, container: containerName, qualified: containerName ? `${containerName}.${name}` : name, declKind: ts.SyntaxKind[decl.kind] };
}
function symIsApi(sym) { return !!apiOfSymbol(sym); }
function typeIsApi(type, depth) {
  depth = depth || 0;
  if (!type || depth > 3) return false;
  if (type.isUnionOrIntersection && type.isUnionOrIntersection()) return type.types.some(t => typeIsApi(t, depth + 1));
  return symIsApi(type.symbol) || symIsApi(type.aliasSymbol);
}

function docUrl(api) {
  if (!api) return '';
  const view = state.channel === 'stable' ? 'minecraft-bedrock-stable' : 'minecraft-bedrock-experimental';
  const mod = api.module.split('/')[1];
  const kindIsType = /Class|Interface|Enum|TypeAlias/.test(api.declKind || '');
  let page;
  if (api.container) page = api.container.toLowerCase();
  else if (kindIsType) page = api.name.toLowerCase();
  else page = `minecraft-${mod}`;
  return `https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/${mod}/${page}?view=${view}`;
}

function availability(api, tags) {
  if (!api) return null;
  const pkg = state.manifest.channels[state.channel].packages[api.module];
  const beta = state.channel === 'beta' && (isBetaOnly(api.module, api.qualified) || (tags || []).some(t => t.name === 'beta'));
  return {
    module: api.module,
    version: pkg ? pkg.version : '',
    channel: state.channel,
    beta,
    betaWholeModule: betaSet(api.module).whole,
    url: docUrl(api)
  };
}

function buildExportIndex() {
  if (state.exportIndex) return state.exportIndex;
  const index = new Map();
  const program = state.service.getProgram();
  const checker = program.getTypeChecker();
  for (const root of state.defRoots) {
    const sf = program.getSourceFile(root);
    const modSym = sf && checker.getSymbolAtLocation(sf);
    if (!modSym) continue;
    const module = '@minecraft/' + root.slice(NM.length).split('/')[0];
    for (const exp of checker.getExportsOfModule(modSym)) {
      if (!index.has(exp.getName())) index.set(exp.getName(), module);
    }
  }
  state.exportIndex = index;
  return index;
}

function scoreName(name, typed) {
  if (!typed) return 0;
  if (name.startsWith(typed)) return 0;
  const ln = name.toLowerCase();
  const lt = typed.toLowerCase();
  if (ln.startsWith(lt)) return 1;
  const initials = name.replace(/[^A-Z0-9_]/g, '').toLowerCase();
  if (lt.length > 1 && initials.startsWith(lt)) return 2;
  if (ln.includes(lt)) return 3;
  return -1;
}

// TypeScript writes `const { x } = require("m")` into plain .js files that have no imports yet.
// Bedrock scripts are ES modules, so turn that into a normal import (keeping the file's semicolon style).
function esmImport(newText, fileText) {
  const lines = fileText.split('\n').filter(l => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
  const withSemi = lines.filter(l => /;\s*$/.test(l)).length;
  const semi = lines.length === 0 || withSemi >= lines.length / 2 ? ';' : '';
  return newText.replace(/const\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\((["'])([^"']+)\2\)\s*;?/g, (m, what, q, spec) => {
    const clause = what.startsWith('{') ? '{ ' + what.slice(1, -1).trim() + ' }' : what;
    return `import ${clause} from ${q}${spec}${q}${semi}`;
  });
}

function prefsFor(quote) {
  return {
    includeCompletionsForModuleExports: true,
    includeCompletionsForImportStatements: true,
    includeCompletionsWithInsertText: true,
    includeAutomaticOptionalChainCompletions: true,
    allowIncompleteCompletions: true,
    importModuleSpecifierPreference: 'non-relative',
    importModuleSpecifierEnding: 'auto',
    quotePreference: quote === "'" ? 'single' : 'double'
  };
}

// ---------------------------------------------------------------- request handlers

const handlers = {
  async init({ base, tsUrl }) {
    state.base = base;
    importScripts(tsUrl);
    ts = self.ts;
    if (!ts || !ts.createLanguageService) throw new Error('TypeScript did not load');
    const [libs, manifest, betaOnly, runtimeGlobals] = await Promise.all([
      getJson(base + 'ts-libs.json'),
      getJson(base + 'definitions/manifest.json'),
      getJson(base + 'definitions/beta-only.json'),
      getText(base + 'runtime-globals.d.ts')
    ]);
    state.libs = libs;
    state.manifest = manifest;
    state.betaOnly = betaOnly;
    state.runtimeGlobals = runtimeGlobals;
    return handlers.setChannel({ channel: manifest.defaultChannel, first: true });
  },

  async setChannel({ channel, first }) {
    await loadChannel(channel);
    if (!state.service) createService();
    return handlers.info();
  },

  info() {
    const info = state.manifest.channels[state.channel];
    const packages = {};
    for (const [n, p] of Object.entries(info.packages)) packages[n] = p.version;
    return {
      channel: state.channel,
      channels: Object.keys(state.manifest.channels).map(k => ({ id: k, label: state.manifest.channels[k].label })),
      packages,
      unavailable: info.unavailable,
      generatedAt: state.manifest.generatedAt,
      tsVersion: ts.version
    };
  },

  setFiles({ updates, removes }) {
    for (const u of updates || []) state.files.set(u.path, { text: u.text, version: ++state.fileCounter });
    for (const r of removes || []) state.files.delete(r);
    state.projectVersion++;
    return true;
  },

  complete({ file, offset, quote }) {
    const text = readVirtual(file) || '';
    let info;
    try { info = state.service.getCompletionsAtPosition(file, offset, prefsFor(quote), FORMAT); } catch (e) { info = undefined; }
    if (!info) return { items: [] };
    let wordStart = offset;
    while (wordStart > 0 && /[\w$]/.test(text[wordStart - 1])) wordStart--;
    const optional = info.optionalReplacementSpan;
    const items = [];
    for (const entry of info.entries) {
      if (entry.isSnippet) continue;
      if (entry.kind === 'string' && entry.name === text.slice(Math.max(0, offset - entry.name.length), offset)) continue;
      const span = entry.replacementSpan || optional || { start: wordStart, length: offset - wordStart };
      const typed = text.slice(span.start, offset);
      const label = entry.name;
      const score = scoreName(label, typed.replace(/^["']/, ''));
      if (score < 0) continue;
      items.push({
        name: label,
        insertText: entry.insertText || label,
        kind: entry.kind,
        modifiers: entry.kindModifiers || '',
        sortText: entry.sortText || '',
        source: entry.source || '',
        sourceDisplay: entry.sourceDisplay ? partsToString(entry.sourceDisplay) : '',
        hasAction: !!entry.hasAction,
        recommended: !!entry.isRecommended,
        betaOnly: text.slice(Math.max(0, span.start - 11), span.start) === '@minecraft/' && state.unavailable.includes('@minecraft/' + label),
        data: entry.data,
        from: span.start,
        to: span.start + span.length > offset ? span.start + span.length : offset,
        score
      });
    }
    items.sort((a, b) => a.score - b.score || (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0) || (a.name < b.name ? -1 : 1));
    return { items: items.slice(0, 250), isMember: !!info.isMemberCompletion, isGlobal: !!info.isGlobalCompletion };
  },

  completionDetails({ file, offset, name, source, data, quote }) {
    let d;
    try { d = state.service.getCompletionEntryDetails(file, offset, name, FORMAT, source || undefined, prefsFor(quote), data); } catch (e) { d = undefined; }
    if (!d) return null;
    const tags = tagsOf(d.tags);
    const sourceText = partsToString(d.source);
    return {
      display: partsToString(d.displayParts),
      documentation: partsToString(d.documentation),
      tags,
      kind: d.kind,
      sourceText,
      codeActions: (d.codeActions || []).map(a => ({
        description: a.description,
        changes: a.changes.filter(c => c.fileName === file).flatMap(c => c.textChanges.map(t => ({ start: t.span.start, length: t.span.length, newText: esmImport(t.newText, readVirtual(file) || '') })))
      }))
    };
  },

  quickInfo({ file, offset }) {
    const qi = state.service.getQuickInfoAtPosition(file, offset);
    if (!qi) return null;
    const tags = tagsOf(qi.tags);
    const program = state.service.getProgram();
    const sf = program.getSourceFile(file);
    let api = null;
    if (sf) {
      const checker = program.getTypeChecker();
      const node = nodeAt(sf, offset);
      let sym = null;
      try { sym = realSymbol(checker, checker.getSymbolAtLocation(node)); } catch (e) { sym = null; }
      api = apiOfSymbol(sym);
    }
    return {
      start: qi.textSpan.start,
      length: qi.textSpan.length,
      kind: qi.kind,
      display: partsToString(qi.displayParts),
      documentation: partsToString(qi.documentation),
      tags,
      deprecated: tags.some(t => t.name === 'deprecated'),
      availability: availability(api, tags)
    };
  },

  signatureHelp({ file, offset, triggerCharacter }) {
    const help = state.service.getSignatureHelpItems(file, offset, {
      triggerReason: triggerCharacter ? { kind: 'characterTyped', triggerCharacter } : { kind: 'invoked' }
    });
    if (!help) return null;
    const items = help.items.map(it => ({
      prefix: partsToString(it.prefixDisplayParts),
      suffix: partsToString(it.suffixDisplayParts),
      separator: partsToString(it.separatorDisplayParts),
      documentation: partsToString(it.documentation),
      tags: tagsOf(it.tags),
      params: it.parameters.map(p => ({
        display: partsToString(p.displayParts),
        documentation: partsToString(p.documentation),
        optional: !!p.isOptional
      }))
    }));
    return { items, selected: help.selectedItemIndex, argument: help.argumentIndex, count: help.argumentCount };
  },

  diagnostics({ file }) {
    return diagnosticsFor(file);
  }
};

// ---------------------------------------------------------------- diagnostics

const PROPERTY_CODES = new Set([2339, 2551]);
const IMPORT_MEMBER_CODES = new Set([2305, 2724, 2614]);
const CALLISH_CODES = new Set([2345, 2554, 2555, 2556, 2557, 2559, 2769, 2353, 2322, 2561, 2349, 2351, 2348, 2739, 2740, 2741, 2820, 2352, 2363]);
const NULLISH_CODES = new Set([2532, 18047, 18048, 18049, 2531, 2533]);
const CODE_NAME_NOT_FOUND = 2304;
const CODE_MODULE_NOT_FOUND = 2307;

function isStatementLike(n) {
  return ts.isFunctionLike(n) || ts.isBlock(n) || ts.isSourceFile(n) || ts.isVariableStatement(n) || ts.isExpressionStatement(n) ||
    ts.isReturnStatement(n) || ts.isIfStatement(n) || ts.isForStatement(n) || ts.isClassLike(n);
}

function calleeIsApi(checker, call) {
  const expr = call.expression;
  try {
    if (ts.isPropertyAccessExpression(expr)) {
      const sym = realSymbol(checker, checker.getSymbolAtLocation(expr.name));
      if (symIsApi(sym)) return true;
      return typeIsApi(checker.getTypeAtLocation(expr.expression));
    }
    const sym = realSymbol(checker, checker.getSymbolAtLocation(expr));
    if (symIsApi(sym)) return true;
    return typeIsApi(checker.getTypeAtLocation(expr));
  } catch (e) { return false; }
}

function relatedToApiCall(checker, sf, diag) {
  let n = nodeAt(sf, diag.start);
  while (n) {
    if (ts.isFunctionLike(n) && n.getStart(sf) === diag.start && n.parent && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent))) {
      n = n.parent; continue;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) return calleeIsApi(checker, n);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = n.left;
      try {
        if (ts.isPropertyAccessExpression(left)) {
          return symIsApi(realSymbol(checker, checker.getSymbolAtLocation(left.name))) || typeIsApi(checker.getTypeAtLocation(left.expression));
        }
        return symIsApi(realSymbol(checker, checker.getSymbolAtLocation(left)));
      } catch (e) { return false; }
    }
    if (isStatementLike(n)) return false;
    n = n.parent;
  }
  return false;
}

function enclosingImport(node) {
  let n = node;
  while (n && !ts.isImportDeclaration(n) && !ts.isSourceFile(n)) n = n.parent;
  return n && ts.isImportDeclaration(n) ? n : null;
}

function apiDiagnostics(file, sf, program) {
  const checker = program.getTypeChecker();
  const out = [];
  const stable = state.channel === 'stable';
  const semantic = state.service.getSemanticDiagnostics(file);
  const unavailableRanges = [];

  // imports of modules that do not exist in this channel, and (in beta) of modules that only exist as beta
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (state.channel === 'beta' && spec.startsWith('@minecraft/') && betaSet(spec).whole) {
      out.push({
        start: st.moduleSpecifier.getStart(sf), length: st.moduleSpecifier.getWidth(sf), severity: 'beta', code: 'sapi-beta',
        message: `${spec} is a Beta-only module - it has no stable release. It needs a "-beta" module version in manifest.json and Beta APIs enabled on the world.`
      });
    }
    if (state.unavailable.includes(spec)) {
      unavailableRanges.push([st.getStart(sf), st.getEnd()]);
      out.push({
        start: st.moduleSpecifier.getStart(sf), length: st.moduleSpecifier.getWidth(sf), severity: 'error', code: 'sapi-unavailable',
        message: `${spec} has no ${state.channel} release - it only exists in the Beta Script API. Switch the Script API channel to Beta to use it.`
      });
    }
  }
  const inUnavailable = start => unavailableRanges.some(r => start >= r[0] && start < r[1]);

  for (const d of semantic) {
    if (d.start === undefined || (d.file && d.file.fileName !== file)) continue;
    if (inUnavailable(d.start)) continue;
    const code = d.code;
    const base = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    let message = base;
    let severity = d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';
    let related = false;
    const node = nodeAt(sf, d.start);

    try {
      if (PROPERTY_CODES.has(code)) {
        const access = node.parent;
        if (access && (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))) {
          const recvType = checker.getTypeAtLocation(access.expression);
          related = typeIsApi(recvType);
          if (related && stable) {
            const plain = checker.getNonNullableType(recvType);
            const container = plain.symbol && plain.symbol.getName();
            const apiInfo = apiOfSymbol(plain.symbol);
            const member = ts.isPropertyAccessExpression(access) ? access.name.text : '';
            if (apiInfo && member && isBetaOnlyName(apiInfo.module, `${container}.${member}`)) {
              message += `\n"${member}" exists only in the Beta Script API - switch the Script API channel to Beta to use it.`;
            }
          }
        }
      } else if (IMPORT_MEMBER_CODES.has(code)) {
        const imp = enclosingImport(node);
        if (imp && ts.isStringLiteral(imp.moduleSpecifier) && imp.moduleSpecifier.text.startsWith('@minecraft/')) {
          related = true;
          const spec = imp.moduleSpecifier.text;
          const name = node.getText(sf);
          if (stable && isBetaOnlyName(spec, name)) message += `\n"${name}" exists only in the Beta Script API - switch the Script API channel to Beta to use it.`;
        }
      } else if (code === CODE_MODULE_NOT_FOUND) {
        const spec = ts.isStringLiteral(node) ? node.text : '';
        if (spec.startsWith('@minecraft/')) {
          related = true;
          const known = Object.keys(state.manifest.channels[state.channel].packages).join(', ');
          message = `Cannot find module '${spec}' in the ${state.channel} Script API. Known modules: ${known}.`;
        }
      } else if (code === CODE_NAME_NOT_FOUND) {
        const name = sf.text.slice(d.start, d.start + d.length);
        const module = buildExportIndex().get(name);
        if (module) {
          related = true;
          message = `"${name}" is not defined. It is exported by "${module}" - add: import { ${name} } from "${module}";`;
        } else if (state.unavailable.length) {
          for (const u of state.unavailable) {
            if (isBetaOnlyName(u, name) && !/\./.test(name)) { related = true; message = `"${name}" is only available in the Beta Script API (${u}).`; break; }
          }
        }
      } else if (CALLISH_CODES.has(code)) {
        related = relatedToApiCall(checker, sf, d);
      } else if (NULLISH_CODES.has(code)) {
        const expr = exactNode(sf, d.start, d.length) || node;
        related = typeIsApi(checker.getTypeAtLocation(expr));
        severity = 'warning';
      }
    } catch (e) { related = false; }

    if (related) out.push({ start: d.start, length: Math.max(1, d.length || 1), severity, code, message });
  }

  // deprecated APIs (the compiler reports these as suggestions)
  try {
    for (const d of state.service.getSuggestionDiagnostics(file)) {
      if (!d.reportsDeprecated || d.start === undefined || inUnavailable(d.start)) continue;
      out.push({ start: d.start, length: Math.max(1, d.length || 1), severity: 'deprecated', code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
    }
  } catch (e) { /* suggestion diagnostics are optional */ }

  // beta APIs in use (only meaningful in the beta channel - the stable definitions contain none)
  if (state.channel === 'beta') out.push(...betaUsage(sf, checker, inUnavailable));
  return out;
}

function betaUsage(sf, checker, skip) {
  const out = [];
  const seen = new Set();
  let visited = 0;
  (function visit(n) {
    if (++visited > 40000) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isDeclName = p && p.name === n && (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isClassDeclaration(p));
      if (!isDeclName && !(ts.isImportSpecifier(p) && p.propertyName && p.name === n)) {
        let sym = null;
        try { sym = realSymbol(checker, checker.getSymbolAtLocation(n)); } catch (e) { sym = null; }
        const api = apiOfSymbol(sym);
        if (api && !betaSet(api.module).whole && isBetaOnlyName(api.module, api.qualified)) {
          const start = n.getStart(sf);
          if (!seen.has(start) && !skip(start)) {
            seen.add(start);
            out.push({
              start, length: n.getWidth(sf), severity: 'beta', code: 'sapi-beta',
              message: `"${api.qualified}" is a Beta API. It is not available in stable releases and may change - it needs a "-beta" module version in manifest.json and Beta APIs enabled on the world.`
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
  return out;
}

function diagnosticsFor(file) {
  const program = state.service.getProgram();
  const sf = program && program.getSourceFile(file);
  if (!sf) return { syntax: [], api: [] };
  const syntax = state.service.getSyntacticDiagnostics(file).map(d => ({
    start: d.start || 0, length: Math.max(1, d.length || 1), severity: 'error', code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n')
  }));
  let api = [];
  try { api = apiDiagnostics(file, sf, program); } catch (e) { api = []; }
  const seen = new Set();
  api = api.filter(d => { const k = `${d.start}:${d.length}:${d.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { syntax, api };
}

// ---------------------------------------------------------------- message loop

self.onmessage = async event => {
  const { id, type, args } = event.data || {};
  try {
    const result = await handlers[type](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.stack) || error) });
  }
};

})();
