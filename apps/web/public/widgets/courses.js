/*!
 * AgricPlatform course catalogue embed (wave P5d).
 * Usage: <script src="https://<host>/widgets/courses.js" data-target="#agric-courses" defer></script>
 * Optional: data-api="https://api.example/api/v1" data-limit="8"
 * Framework-free, <15KB, no iframes. Feed: GET /api/v1/embed/courses (CORS-open, no PII).
 */
(function () {
  'use strict';
  // currentScript is null when a host page (or React/Next) injects the tag
  // dynamically — fall back to matching our own src.
  var script =
    document.currentScript ||
    document.querySelector('script[src*="/widgets/courses.js"]');
  if (!script) return;
  var target = document.querySelector(script.getAttribute('data-target') || '#agric-courses');
  if (!target) return;
  var apiBase = (script.getAttribute('data-api') || new URL(script.src).origin + '/api/v1').replace(/\/$/, '');
  var limit = script.getAttribute('data-limit') || '8';

  fetch(apiBase + '/embed/courses?limit=' + encodeURIComponent(limit), {
    headers: { accept: 'application/json' }
  })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (body) {
      target.innerHTML = '';
      var list = document.createElement('ul');
      list.className = 'agric-widget agric-courses';
      (body.data || []).forEach(function (course) {
        var item = document.createElement('li');
        var title = document.createElement('strong');
        title.textContent = course.title;
        var meta = document.createElement('span');
        meta.textContent =
          ' — ' + course.category + ' · ' + course.level + ' · ' + course.durationMinutes + ' min';
        item.appendChild(title);
        item.appendChild(meta);
        list.appendChild(item);
      });
      if (!list.children.length) {
        var empty = document.createElement('li');
        empty.textContent = 'No courses published yet.';
        list.appendChild(empty);
      }
      target.appendChild(list);
    })
    .catch(function () {
      target.textContent = 'Courses are temporarily unavailable.';
    });
})();
