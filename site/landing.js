/* First-party landing script: message-test copy, language-link attribution and
 * the early-access dialog. No cookies, analytics, storage or third-party calls. */
(function () {
  'use strict';

  var root = document.documentElement;
  var params = new URLSearchParams(window.location.search);
  var arm = (params.get('v') || '').toLowerCase();
  if (arm !== 'a' && arm !== 'b') arm = 'none';
  var source = params.get('source') || '';
  source = /^[A-Za-z0-9_-]{1,64}$/.test(source) ? source.toLowerCase() : 'direct';
  root.setAttribute('data-arm', arm);

  ['hero-title', 'hero-sub'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && arm !== 'none') {
      var copy = el.getAttribute('data-arm-' + arm);
      if (copy) el.textContent = copy;
    }
  });

  var query = [];
  if (arm !== 'none') query.push('v=' + arm);
  if (source !== 'direct') query.push('source=' + encodeURIComponent(source));
  document.querySelectorAll('a[data-keep-query]').forEach(function (link) {
    if (query.length) link.href = link.getAttribute('href').split('?')[0] + '?' + query.join('&');
  });

  var dialog = document.getElementById('interest-dialog');
  var form = document.getElementById('interest-form');
  if (!dialog || !form) return;
  var status = document.getElementById('interest-status');
  var submit = form.querySelector('button[type="submit"]');
  var selectedDevice = '';
  var opener = null;
  var registered = false;

  function message(key) { status.textContent = form.getAttribute('data-msg-' + key) || ''; }
  document.querySelectorAll('a[data-device]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      selectedDevice = link.getAttribute('data-device');
      opener = link;
      if (registered) message('ok');
      else status.textContent = '';
      dialog.showModal();
      document.getElementById('interest-name').focus();
    });
  });
  dialog.querySelector('.dialog-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { if (opener) opener.focus(); });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!form.checkValidity() || (selectedDevice !== 'iphone' && selectedDevice !== 'android')) {
      message('invalid');
      form.reportValidity();
      return;
    }
    var body = {
      kind: 'landing_interest',
      name: form.elements.namedItem('name').value.trim(),
      email: form.elements.namedItem('email').value.trim(),
      device: selectedDevice,
      pageLanguage: root.lang,
      source: source,
      v: arm,
      website: form.elements.namedItem('website').value
    };
    submit.disabled = true;
    message('busy');
    fetch('/api/early-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        submit.disabled = false;
        message(response.status === 422 ? 'invalid' : 'error');
        return;
      }
      form.reset();
      registered = true;
      form.querySelectorAll('input, button[type="submit"]').forEach(function (field) { field.hidden = true; });
      form.querySelectorAll('label, .form-privacy').forEach(function (field) { field.hidden = true; });
      message('ok');
    }).catch(function () {
      submit.disabled = false;
      message('error');
    });
  });
})();
