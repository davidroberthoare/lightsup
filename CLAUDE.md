# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LightsUP is a browser-based theatrical lighting drafting tool (work in progress, hobbyist-oriented). It is a fully static, client-side app: no build step, no bundler, no server-side or database backend. All third-party libraries (jQuery, Fabric.js v6, AlaSQL, Tabulator, Bulma CSS) are vendored as minified files in `src/js/` and `src/css/` and loaded as plain UMD `<script>` tags; the app's own code is native ES modules loaded via `<script type="module">`.

## Commands

- `npm start` — serve `src/` at http://localhost:8080 (ES modules require http, not file://)
- `npm test` — run all tests (Node's built-in test runner; no test dependencies)
- `node --test tests/store.test.js` — run a single test file
- `npm run lint` — ESLint (the only npm dependency; `npm install` once first)
- http://localhost:8080/smoke-test.html — browser smoke test for the layers Node can't reach (SVG loading/caching, incremental rendering, localStorage upgrade path). Page title becomes `SMOKE-OK`/`SMOKE-FAIL`; it snapshots and restores localStorage so it won't destroy real work.

## Architecture

The deployable app lives entirely in `src/`; tests and tooling live at the repo root and must not be deployed.

**The store is the single source of truth.** `src/js/store.js` owns two AlaSQL in-memory tables — `shows` (per-show metadata) and `items` (every fixture/position, each carrying a `show_id`) — and is the only module that touches SQL or localStorage. Everything else follows the flow: UI event → store mutation → targeted render update. Store mutation functions return `{id, number}` change lists where renumbering side-effects occur, so callers can apply text updates without redrawing.

**Persistence** is a single versioned JSON document under the localStorage key `lightsup:data` (`DATA_VERSION` in store.js). Legacy v1 saves (separate `shows`/`items` keys, no `show_id`) are migrated on load in `readDocument`/`migrateLegacy` — schema changes must bump the version and add an upgrade path there. Saving is manual (Ctrl+S / File→Save); a dirty flag in the store drives a `beforeunload` warning.

**The render layer** (`src/js/render.js`) mirrors store items onto the Fabric.js canvas and holds no authoritative state. Each item is a Fabric `Group` tagged with the store row's `id` and an `itemType` (`'fixture'`/`'position'`); text sub-objects are tagged with `itemType` matching their column name (`number`, `label`, `dimmer`, `channel`, `gel`) so `updateItemText()` can update them in place. Rendering is incremental — full redraws (`renderAll`) happen only on load and show switching. SVG symbols are promise-cached and cloned per use; a per-id token map cancels stale in-flight renders.

**Controllers**: `src/js/main.js` (drafting page) and `src/js/report-main.js` (report page) wire DOM/canvas events to the store. Two HTML entry points — `index.html` (canvas) and `report.html` (Tabulator instrument schedule) — share the store, so the report shows the last *saved* state of the current show.

### Domain rules encoded in the store

- Drawing coordinates are in **centimeters** (see `GRID_OPTIONS` in render.js).
- A fixture "hangs on" a position when their canvas objects intersect after a move; `assignFixtureToPosition` maintains the link and renumbering.
- Unit numbering runs stage-right to stage-left: fixtures on a position are numbered by **descending x** (then descending y). An unassigned fixture has `number: null` (rendered blank).
- Generic field updates (`updateItemField`/`updateShowField`) validate column names against whitelists — extend `ITEM_FIELDS`/`SHOW_FIELDS` when adding columns, and add the column to the table schema, `ITEM_COLUMNS`, and `ITEM_DEFAULTS`.
- Layer order (Edit→Layer, PageUp/PageDown) is persisted as each item's `zindex`; `getItems()` orders by it, and a new item defaults to the top of its own show's stack (`nextZIndex`). The canvas stacking order is the actual working copy during a layer command — `main.js`'s `layerSelection`/`applyLayerOrder` reorder the live Fabric objects first, then `setItemsOrder()` renumbers `zindex` to match. `render.js`'s `renderAll` has to re-assert that same order after its own async render pass, since each item's SVG can finish loading (and thus get added to the canvas) in any order.

### Fixture catalog

`src/config/fixtures.json` defines the Insert→Fixtures menu; each entry's `symbol` must have a matching SVG at `src/img/symbols/fixtures/<symbol>.svg`. Adding a fixture type = JSON entry + SVG file.

### PWA / offline caching

The app is installable and works fully offline via `src/sw.js`, registered from both entry points by `src/js/register-sw.js` (a plain script, not a module — it must keep working even if the module graph fails). `src/sw.js` **must** live at the `src/` root, not under `src/js/`: a service worker's default scope is the directory it's served from, and a worker under `js/` would never control `index.html`/`report.html`.

`src/config/pwa.json` is the one file meant to be hand-edited to manage caching:
- `cacheVersion` — bump this (any string) to cache-bust: `activate()` deletes every `lightsup-cache-*` whose name doesn't match the current version, forcing a full re-fetch on next load.
- `offlineCacheEnabled` — set `false` to disable offline caching entirely (plain network passthrough) and tear down any caches this worker previously created. Useful during local development, where a stale cache is more often in the way than helpful.

`pwa.json` itself is always fetched network-first (falling back to cache only if offline) — otherwise a version bump or toggle flip could never be observed, since the file announcing the change would itself be served stale. The service worker's precache list (`CORE_URLS` in sw.js) is hand-maintained for the app shell, but fixture symbol SVGs are read from `config/fixtures.json` at install time rather than hardcoded, so adding a fixture type doesn't also require touching `sw.js`.

Icons live in `src/icons/` (`icon.svg`/`icon-maskable.svg` are the source files; the PNGs are generated from them, e.g. via `inkscape file.svg --export-type=png --export-filename=out.png -w N -h N`) and are referenced from `src/manifest.json` and the `<link rel="icon"/apple-touch-icon>` tags in both HTML entry points.

### Testing notes

Tests run the real vendored AlaSQL in Node via `tests/helpers/alasql-loader.js` (a CommonJS shim needed because the root package.json sets `"type": "module"`), and pass a fake storage object to store functions — every store function takes an optional storage parameter defaulting to `localStorage`. Store logic is covered there; the render layer and controllers are browser-only and covered by `src/smoke-test.html` instead.

`smoke-test.html` must live at the `src/` root: `render.js` resolves SVG symbol paths relative to the *page* URL (`./img/symbols/...`), so a harness in a subdirectory would 404 on every symbol.
