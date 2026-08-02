/*!
 * AgricPlatform commodity price ticker embed (wave P5d).
 * Usage: <script src="https://<host>/widgets/prices.js" data-target="#agric-prices" defer></script>
 * Optional: data-api="https://api.example/api/v1" data-limit="12"
 * Framework-free, <15KB, no iframes. Feed: GET /api/v1/embed/prices (CORS-open, no PII).
 */
(function () {
  'use strict';
  // currentScript is null when a host page (or React/Next) injects the tag
  // dynamically — fall back to matching our own src.
  var script =
    document.currentScript ||
    document.querySelector('script[src*="/widgets/prices.js"]');
  if (!script) return;
  var target = document.querySelector(script.getAttribute('data-target') || '#agric-prices');
  if (!target) return;
  var apiBase = (script.getAttribute('data-api') || new URL(script.src).origin + '/api/v1').replace(/\/$/, '');
  var limit = script.getAttribute('data-limit') || '12';

  function formatNgn(value) {
    return '₦' + Number(value).toLocaleString('en-NG');
  }

  fetch(apiBase + '/embed/prices?limit=' + encodeURIComponent(limit), {
    headers: { accept: 'application/json' }
  })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (body) {
      target.innerHTML = '';
      var ticker = document.createElement('div');
      ticker.className = 'agric-widget agric-price-ticker';
      ticker.setAttribute('role', 'marquee');
      (body.data || []).forEach(function (price) {
        var chip = document.createElement('span');
        chip.className = 'agric-price-chip';
        chip.textContent =
          price.commodity + ' (' + price.market + ', ' + price.state + '): ' + formatNgn(price.priceNgn);
        ticker.appendChild(chip);
      });
      if (!ticker.children.length) {
        ticker.textContent = 'No market prices published yet.';
      }
      target.appendChild(ticker);
    })
    .catch(function () {
      target.textContent = 'Prices are temporarily unavailable.';
    });
})();
