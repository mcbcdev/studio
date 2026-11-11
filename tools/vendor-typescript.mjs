#!/usr/bin/env node
/*
 * One-time (or rare) job: copies the TypeScript compiler/language service that Studio runs in the browser
 * into js/script-api/, plus the standard JavaScript library typings (lib.es*.d.ts) it needs.
 *
 *   js/script-api/typescript.min.js   minified TypeScript (browser build, no Node needed to use it)
 *   js/script-api/ts-libs.json        { "lib.es5.d.ts": "...", ... } standard library typings
 *
 * Needs the `typescript` (5.x, NOT 7) and `esbuild` npm packages. Set TS_DIR to a folder that has them in node_modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.join(ROOT, 'js', 'script-api');
const require = createRequire(path.join(process.env.TS_DIR || process.cwd(), 'noop.js'));
const esbuild = require('esbuild');
const tsLibDir = path.dirname(require.resolve('typescript/lib/typescript.js'));
const tsVersion = require('typescript/package.json').version;

// Bedrock scripting runs on a modern JS engine without a DOM, so ES2022 and no "dom" lib.
const ENTRY_LIB = 'lib.es2022.d.ts';
const libs = {};
(function collect(name) {
  if (libs[name]) return;
  const text = fs.readFileSync(path.join(tsLibDir, name), 'utf8');
  libs[name] = text;
  for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g)) collect(`lib.${m[1].toLowerCase()}.d.ts`);
})(ENTRY_LIB);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'ts-libs.json'), JSON.stringify(libs));

const src = fs.readFileSync(path.join(tsLibDir, 'typescript.js'), 'utf8');
const min = esbuild.transformSync(src, { minify: true, legalComments: 'none', target: 'es2020' }).code;
fs.writeFileSync(path.join(OUT, 'typescript.min.js'), `/* TypeScript ${tsVersion} (Apache-2.0, Microsoft) - minified for Studio's Script API IntelliSense */\n` + min);
console.log(`typescript ${tsVersion}: ${(min.length / 1e6).toFixed(1)} MB, ${Object.keys(libs).length} lib files`);
