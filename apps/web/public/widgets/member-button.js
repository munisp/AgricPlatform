/*!
 * "Register as NYFN Member" button embed (wave P5d).
 * Usage: <script src="https://<host>/widgets/member-button.js" data-target="#agric-join" defer></script>
 * Optional: data-api="https://api.example/api/v1" data-href="https://app.example/onboarding"
 * Framework-free, <15KB, no iframes. Config: GET /api/v1/embed/member-cta (CORS-open, no PII).
 */
(function () {
  'use strict';
  // currentScript is null when a host page (or React/Next) injects the tag
  // dynamically — fall back to matching our own src.
  var script =
    document.currentScript ||
    document.querySelector('script[src*="/widgets/member-button.js"]');
  if (!script) return;
  var target = document.querySelector(script.getAttribute('data-target') || '#agric-join');
  if (!target) return;
  var scriptOrigin = new URL(script.src).origin;
  var apiBase = (script.getAttribute('data-api') || scriptOrigin + '/api/v1').replace(/\/$/, '');
  var overrideHref = script.getAttribute('data-href');

  function render(label, href, description) {
    target.innerHTML = '';
    var link = document.createElement('a');
    link.className = 'agric-widget agric-member-button';
    link.href = href;
    link.textContent = label;
    link.setAttribute('role', 'button');
    if (description) link.title = description;
    target.appendChild(link);
  }

  fetch(apiBase + '/embed/member-cta', { headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (body) {
      var cta = body.data || {};
      var href = overrideHref || new URL(cta.href || '/onboarding', scriptOrigin).toString();
      render(cta.label || 'Register as NYFN Member', href, cta.description);
    })
    .catch(function () {
      // Static fallback: the button must never disappear on third-party pages.
      render('Register as NYFN Member', overrideHref || scriptOrigin + '/onboarding');
    });
})();
