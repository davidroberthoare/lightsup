// Loads the vendored AlaSQL UMD bundle and exposes it as the same global the
// browser pages provide. require() can't be used directly because the root
// package.json declares "type": "module", which makes Node treat the .js
// bundle as an ES module — so evaluate it with a CommonJS-style shim instead.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../src/js/alasql.min.js', import.meta.url), 'utf8');

const mod = { exports: {} };
new Function('module', 'exports', 'require', source)(mod, mod.exports, require);

globalThis.alasql = mod.exports;

export default mod.exports;
