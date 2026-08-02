/*!
 * AgricPlatform opportunity directory embed (wave P5d).
 * Usage: <script src="https://<host>/widgets/opportunities.js" data-target="#agric-opps" defer></script>
 * Optional: data-api="https://api.example/api/v1" data-limit="10"
 * Framework-free, <15KB, no iframes. Feed: GET /api/v1/embed/opportunities (CORS-open, no PII).
 */
(function () {
  'use strict';
  // currentScript is null when a host page (or React/Next) injects the tag
  // dynamically — fall back to matching our own src.
  var script =
    document.currentScript ||
    document.querySelector('script[src*="/widgets/opportunities.js"]');
  if (!script) return;
  var target = document.querySelector(script.getAttribute('data-target') || '#agric-opportunities');
  if (!target) return;
  var apiBase = (script.getAttribute('data-api') || new URL(script.src).origin + '/api/v1').replace(/\/$/, '');
  var limit = script.getAttribute('data-limit') || '10';

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
  }

  fetch(apiBase + '/embed/opportunities?limit=' + encodeURIComponent(limit), {
    headers: { accept: 'application/json' }
  })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (body) {
      target.innerHTML = '';
      var list = el('ul');
      list.className = 'agric-widget agric-opportunities';
      (body.data || []).forEach(function (opp) {
        var item = el('li');
        var title = el('strong', opp.title);
        var meta = el(
          'span',
          ' — ' + opp.type + (opp.states && opp.states.length ? ' · ' + opp.states.join(', ') : '') +
            ' · deadline ' + opp.deadline
        );
        item.appendChild(title);
        item.appendChild(meta);
        list.appendChild(item);
      });
      if (!list.children.length) list.appendChild(el('li', 'No open opportunities right now.'));
      target.appendChild(list);
    })
    .catch(function () {
      target.innerHTML = '';
      target.appendChild(el('p', 'Opportunities are temporarily unavailable.'));
    });
})();
