/* AgricPlatform service worker — offline-first asset caching.
   No build step: plain script served from /public/sw.js. */
'use strict';

var VERSION = 'agric-sw-v2';
var STATIC_CACHE = VERSION + '-static';
var PAGE_CACHE = VERSION + '-pages';
var API_CACHE = VERSION + '-api-public';

var APP_SHELL = ['/', '/offline', '/manifest.webmanifest', '/icon.svg'];

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
  '/api/v1/advisory'
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

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(function (cache) {
        return cache.addAll(APP_SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
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
              new Response(JSON.stringify({ data: [] }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              })
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
            caches.open(PAGE_CACHE).then(function (cache) {
              cache.put(request, copy);
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
          return cached;
        });
    })
  );
});
