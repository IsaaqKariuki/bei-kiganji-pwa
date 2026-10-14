// Include the version number
// When an update is made , add the version number to clear the old  cache
const CACHE = 'bk-v1';

// Files that make up the app shell - the UI without any data
// we cache these so the app loads instantly even offline
const SHELL = [
    './index.html',
    './app.js',
    './manifest.webmaifest',
];

// install: runs once when the service worker is first registered
// we pre-cache the app shell files.
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => cache.addALL([SHELL]))
    );
    self.skipWaiting ();// activate immediately
});

// activate: runs after install. delete any old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch :intesrcepts every network request the page makes.
// Strategy: cache-first for the app shell, network-only for API calls
self.addEventListener('fetch', e => {
    // Never cache API calls - they must always go to the server
    if (e.request.url.includes('/api/')) return;

    e.respondWith(
        caches.match(e.request).then(cached => {
            // return cached version if we have it, otherwise fetch from network
            return cached || fetch(e.request);
        })
    );
});
