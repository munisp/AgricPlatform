/* AgricPlatform service worker — offline-first asset caching.
   No build step: plain script served from /public/sw.js. */
'use strict';

var VERSION = 'agric-sw-v4';
var STATIC_CACHE = VERSION + '-static';
var PAGE_CACHE = VERSION + '-pages';
var API_CACHE = VERSION + '-api-public';
/* User-chosen offline content pack (knowledge resources saved from Settings). */
var OFFLINE_CACHE = VERSION + '-offline-pack';

/* Cap the page cache: low-storage Android devices must not fill up with
   visited pages. Only the newest entries are kept (FIFO eviction). */
var PAGE_CACHE_LIMIT = 50;

/* Core offline pack: the app shell page, offline fallback, manifest, the
   install icons (so installability works offline) and the primary public
   routes a farmer needs with no connectivity. None of these routes
   redirect, so cache.addAll cannot reject the install. */
var APP_SHELL = [
  '/',
  '/offline',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/marketplace',
  '/learning',
  '/opportunities',
  '/dashboard'
];

/*
 * Runtime caching of PUBLIC reference data GET endpoints only
 * (network-first, cache fallback). Never cache mutations, authenticated
 * requests, or user-private endpoints (dashboard, finance, privacy,
 * notifications, admin, partner, search is per-user-filtered so excluded).
 */
var PUBLIC_API_PATHS = [
  '/api/v1/opportunities',
  '/api/v1/courses',
  '/api/v1/chapters',
  '/api/v1/listings',
  '/api/v1/advisory',
  /* Public knowledge GETs: also serves offline-pack downloads. */
  '/api/v1/knowledge-resources',
  '/api/v1/podcast-episodes'
];

function isPublicApiGet(url, request) {
  if (request.method !== 'GET') return false;
  // Defence in depth: never cache a request that carries credentials.
  if (request.headers.get('authorization') || request.headers.get('x-user-id')) {
    return false;
  }
  return PUBLIC_API_PATHS.some(function (path) {
    return url.pathname === path || url.pathname.indexOf(path + '/') === 0;
  });
}

/* Trim a cache to its newest `limit` entries (keys() is insertion-ordered,
   so keys[0] is the oldest). */
function trimCache(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= limit) return undefined;
      return cache.delete(keys[0]).then(function () {
        return trimCache(cacheName, limit);
      });
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
    /* No unconditional skipWaiting(): a new worker waits until the user
       confirms the "Update available" banner, so farmers are never yanked
       mid-form by a surprise reload. See sw-register.tsx. */
  );
});

/* Message-gated update flow: the page posts {type: 'SKIP_WAITING'} only
   after the user taps "Refresh now". */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  /* Offline content pack: the Settings page posts {type:'CACHE_URLS', urls}
     with a MessagePort for the ack. Only GET URLs are cached, matching the
     fetch handler's never-cache-mutations rule. */
  if (event.data && event.data.type === 'CACHE_URLS' && Array.isArray(event.data.urls)) {
    var replyPort = event.ports && event.ports[0];
    var urls = event.data.urls.filter(function (url) {
      return typeof url === 'string';
    });
    event.waitUntil(
      caches
        .open(OFFLINE_CACHE)
        .then(function (cache) {
          return cache.addAll(urls);
        })
        .then(function () {
          if (replyPort) replyPort.postMessage({ ok: true, count: urls.length });
        })
        .catch(function (error) {
          if (replyPort) {
            replyPort.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
          }
        })
    );
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf(VERSION) !== 0;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  var url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  // Public API reference data: network-first with cache fallback. The API
  // typically lives on another origin (localhost:3001), so this check runs
  // before the same-origin early return below.
  if (isPublicApiGet(url, request)) {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches.open(API_CACHE).then(function (cache) {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (cached) {
            return (
              cached ||
              /* Offline with no cached copy: a real Response (never
                 undefined, which would reject respondWith). */
              new Response(
                JSON.stringify({
                  statusCode: 504,
                  error: 'Gateway Timeout',
                  message: 'You are offline and no saved copy is available.'
                }),
                {
                  status: 504,
                  headers: { 'Content-Type': 'application/json' }
                }
              )
            );
          });
        })
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations: network-first, fall back to cached page or the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            var copy = response.clone();
            caches
              .open(PAGE_CACHE)
              .then(function (cache) {
                return cache.put(request, copy);
              })
              .then(function () {
                return trimCache(PAGE_CACHE, PAGE_CACHE_LIMIT);
              });
          }
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (cached) {
            return cached || caches.match('/offline');
          });
        })
    );
    return;
  }

  // Static assets: cache-first, then network and cache the result.
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request)
        .then(function (response) {
          if (response && response.ok && (response.type === 'basic' || response.type === 'default')) {
            var copy = response.clone();
            caches.open(STATIC_CACHE).then(function (cache) {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(function () {
          /* A failed non-navigation fetch must resolve to a real Response;
             resolving undefined rejects respondWith and surfaces as a
             confusing network error. */
          return Response.error();
        });
    })
  );
});
