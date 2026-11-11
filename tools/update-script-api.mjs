#!/usr/bin/env node
/*
 * Refreshes the official Minecraft Bedrock Script API type definitions that
 * Studio uses for IntelliSense.
 *
 *   - downloads the official @minecraft/* packages from the npm registry
 *   - keeps only each package's official declaration file (usually index.d.ts)
 *   - writes them to js/script-api/definitions/packages/<module>@<version>/ (one folder per version)
 *   - writes js/script-api/definitions/manifest.json (which version is in which channel)
 *   - writes js/script-api/definitions/beta-only.json (names that exist in beta but not in stable)
 *
 * Normally this runs by itself from .github/workflows/update-script-api.yml
 * (Actions tab > "update script api definitions" > Run workflow). Nobody needs to run it by hand.
 *
 * Needs: node 18+, the `tar` command, and the `typescript` npm package (5.x) resolvable from the
 * current folder (the workflow installs it). Set TS_DIR to a folder that contains node_modules/typescript
 * if it lives somewhere else.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(ROOT, 'js', 'script-api', 'definitions');
const REGISTRY = 'https://registry.npmjs.org';

// To add or remove a module, edit this list. "api" modules follow the stable/beta split,
// "support" modules (shared types / data) use their newest release in both channels.
const PACKAGES = [
  { name: '@minecraft/server', kind: 'api' },
  { name: '@minecraft/server-ui', kind: 'api' },
  { name: '@minecraft/server-gametest', kind: 'api' },
  { name: '@minecraft/server-admin', kind: 'api' },
  { name: '@minecraft/server-net', kind: 'api' },
  { name: '@minecraft/debug-utilities', kind: 'api' },
  { name: '@minecraft/server-editor', kind: 'api' },
  { name: '@minecraft/common', kind: 'support' },
  { name: '@minecraft/vanilla-data', kind: 'support' }
];
// Studio's channels. "beta" = the newest "-beta.<game version>-stable" build, i.e. the beta APIs of the
// released game. (Preview builds like "-preview.24" could be added as a third channel here.)
const CHANNELS = ['stable', 'beta'];

const require = createRequire(path.join(process.env.TS_DIR || process.cwd(), 'noop.js'));
const ts = require('typescript');

const fileFor = name => name.replace('@minecraft/', '') + '.d.ts';
const isPlainRelease = v => /^\d+\.\d+\.\d+$/.test(v);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function pickVersion(meta, kind, channel) {
  const versions = Object.keys(meta.versions);
  const byTime = list => list.sort((a, b) => new Date(meta.time[a]) - new Date(meta.time[b])).pop() || null;
  if (kind === 'support') {
    const latest = meta['dist-tags'].latest;
    if (latest && !/preview|internal/.test(latest)) return latest;
    return byTime(versions.filter(v => !/preview|internal/.test(v)));
  }
  if (channel === 'stable') {
    const latest = meta['dist-tags'].latest;
    return latest && isPlainRelease(latest) ? latest : null; // no stable release of this module
  }
  return byTime(versions.filter(v => /-beta\.[\d.]+-stable$/.test(v)));
}

function download(name, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdts-'));
  const base = name.split('/')[1];
  const tgz = path.join(tmp, 'pkg.tgz');
  return fetch(`${REGISTRY}/${name}/-/${base}-${version}.tgz`).then(async res => {
    if (!res.ok) throw new Error(`download ${name}@${version} -> ${res.status}`);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['-xzf', tgz, '-C', tmp, '--strip-components=1']);
    // most packages keep their declarations in index.d.ts; others (vanilla-data) point to a lib/ folder
    const pkgJson = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    const typesRel = (pkgJson.types || pkgJson.typings || 'index.d.ts').replace(/^\.\//, '');
    const typesDir = path.join(tmp, path.dirname(typesRel));
    const files = {};
    for (const f of fs.readdirSync(typesDir)) {
      if (f.endsWith('.d.ts')) files[f] = fs.readFileSync(path.join(typesDir, f), 'utf8').replace(/\r\n/g, '\n');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return { entry: path.basename(typesRel), files };
  });
}

// every exported top-level name, plus Class.member / Enum.member for the declarations that have members
function apiNames(text) {
  const names = new Set();
  const sf = ts.createSourceFile('x.d.ts', text, ts.ScriptTarget.Latest, true);
  const isExported = n => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
  for (const st of sf.statements) {
    if (!isExported(st)) continue;
    if (ts.isVariableStatement(st)) {
      st.declarationList.declarations.forEach(d => ts.isIdentifier(d.name) && names.add(d.name.text));
      continue;
    }
    const nm = st.name && st.name.text;
    if (!nm) continue;
    names.add(nm);
    if (st.members) {
      for (const m of st.members) {
        const mn = m.name && (m.name.text || m.name.escapedText);
        if (mn) names.add(`${nm}.${mn}`);
      }
    }
  }
  return names;
}

const manifest = { generatedAt: new Date().toISOString(), defaultChannel: 'stable', channels: {} };
const downloaded = {};   // "<name>@<version>" -> { entry, files }
const picked = {};       // channel -> { name -> version }
for (const channel of CHANNELS) {
  manifest.channels[channel] = { label: channel === 'stable' ? 'Stable' : 'Beta', packages: {}, unavailable: [] };
  picked[channel] = {};
}

for (const pkg of PACKAGES) {
  const meta = await getJson(`${REGISTRY}/${pkg.name.replace('/', '%2F')}`);
  for (const channel of CHANNELS) {
    const version = pickVersion(meta, pkg.kind, channel);
    const entry = manifest.channels[channel];
    if (!version) { entry.unavailable.push(pkg.name); console.log(`${channel}: ${pkg.name} has no ${channel} release`); continue; }
    const key = `${pkg.name}@${version}`;
    if (!downloaded[key]) downloaded[key] = await download(pkg.name, version);
    picked[channel][pkg.name] = version;
    const dl = downloaded[key];
    entry.packages[pkg.name] = {
      version, kind: pkg.kind,
      dir: `packages/${pkg.name.split('/')[1]}@${version}`,
      entry: dl.entry,
      files: Object.keys(dl.files).sort()
    };
    console.log(`${channel}: ${key}`);
  }
}

const entryText = (channel, name) => {
  const v = picked[channel][name];
  if (!v) return null;
  const dl = downloaded[`${name}@${v}`];
  return dl.files[dl.entry];
};

// beta-only index: names that exist in the beta definitions but not in the stable ones
const betaOnly = {};
for (const name of Object.keys(picked.beta)) {
  const betaText = entryText('beta', name);
  const stableText = entryText('stable', name);
  const betaNames = apiNames(betaText);
  const stableNames = stableText ? apiNames(stableText) : new Set();
  const only = [...betaNames].filter(n => !stableNames.has(n)).sort();
  betaOnly[name] = stableText ? only : { wholeModule: true, names: only };
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const [key, dl] of Object.entries(downloaded)) {
  const [name, version] = [key.slice(0, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1)];
  const dir = path.join(OUT, 'packages', `${name.split('/')[1]}@${version}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(dl.files)) fs.writeFileSync(path.join(dir, file), text);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'beta-only.json'), JSON.stringify(betaOnly) + '\n');
console.log('done');
