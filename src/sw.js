// Service worker: full offline caching for this static, client-only app.
//
// The cache name is derived from config/pwa.json's cacheVersion, so bumping
// that number is the cache-busting mechanism — activate() drops every cache
// whose name doesn't match the current version, forcing a clean re-fetch of
// everything on the next load. Setting offlineCacheEnabled to false switches
// fetch handling to plain network passthrough and removes any caches this
// worker previously created (handy for local development, where a stale
// cache is more often in the way than in the way).
//
// config/pwa.json is deliberately excluded from that cache-first policy (see
// isConfigRequest below) — otherwise a version bump or a toggle flip could
// never be observed, because the very file that announces the change would
// itself be served stale from the old cache.

const CONFIG_URL = '/config/pwa.json';
const CACHE_PREFIX = 'lightsup-cache-';

// The app shell. Fixture symbol SVGs aren't listed here — they're read from
// config/fixtures.json at install time (see precacheUrls) so adding a
// fixture type doesn't also require editing this file.
const CORE_URLS = [
    '/',
    '/index.html',
    '/report.html',
    '/manifest.json',
    '/config/pwa.json',
    '/config/fixtures.json',
    '/css/bulma.min.css',
    '/css/styles.css',
    '/css/tabulator.min.css',
    '/js/alasql.min.js',
    '/js/jquery.min.js',
    '/js/fabric.min.js',
    '/js/tabulator.min.js',
    '/js/main.js',
    '/js/render.js',
    '/js/report-main.js',
    '/js/store.js',
    '/js/util.js',
    '/js/register-sw.js',
    '/img/symbols/util/dimmer.svg',
    '/img/icons/icon.svg',
    '/img/icons/icon-maskable.svg',
    '/img/icons/icon-192.png',
    '/img/icons/icon-512.png',
    '/img/icons/icon-maskable-192.png',
    '/img/icons/icon-maskable-512.png',
    '/img/icons/apple-touch-icon.png',
    '/img/icons/favicon-32.png',
];

// Fetched once per worker lifetime and reused; the worker can be killed and
// respawned by the browser between events, so this is re-populated lazily
// rather than assumed to survive.
let configPromise = null;
function loadConfig() {
    if (!configPromise) {
        configPromise = fetch(CONFIG_URL, { cache: 'no-store' })
            .then((res) => res.json())
            .catch(() => ({ cacheVersion: 'dev', offlineCacheEnabled: false }));
    }
    return configPromise;
}

function cacheNameFor(version) {
    return `${CACHE_PREFIX}${version}`;
}

function isConfigRequest(url) {
    return new URL(url).pathname.endsWith('/config/pwa.json');
}

async function precacheUrls() {
    const urls = CORE_URLS.slice();
    try {
        const res = await fetch('/config/fixtures.json', { cache: 'no-store' });
        const fixtures = await res.json();
        fixtures.forEach((fixture) => urls.push(`/img/symbols/fixtures/${fixture.symbol}.svg`));
    } catch {
        // Offline install with fixtures.json unreachable — the rest of the
        // shell still caches; any missed symbol fills in via the runtime
        // cache-then-network fallback below the first time it's drawn.
    }
    return urls;
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const config = await loadConfig();
        if (config.offlineCacheEnabled) {
            const cache = await caches.open(cacheNameFor(config.cacheVersion));
            await cache.addAll(await precacheUrls());
        }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const config = await loadConfig();
        const current = config.offlineCacheEnabled ? cacheNameFor(config.cacheVersion) : null;
        const names = await caches.keys();
        await Promise.all(
            names
                .filter((name) => name.startsWith(CACHE_PREFIX) && name !== current)
                .map((name) => caches.delete(name)),
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith((async () => {
        const config = await loadConfig();

        if (isConfigRequest(event.request.url)) {
            try {
                return await fetch(event.request);
            } catch (err) {
                const cache = await caches.open(cacheNameFor(config.cacheVersion));
                const cached = await cache.match(event.request);
                if (cached) return cached;
                throw err;
            }
        }

        if (!config.offlineCacheEnabled) {
            return fetch(event.request);
        }

        const cache = await caches.open(cacheNameFor(config.cacheVersion));
        const cached = await cache.match(event.request);
        if (cached) return cached;

        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
    })());
});
