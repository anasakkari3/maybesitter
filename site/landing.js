/* MaybeSitter landing pages — the only script on the site.
 *
 * It does three things and nothing else:
 *   1. Reads `?v=a|b` and `?source=` from the URL the visitor followed, and swaps the
 *      hero line for the matching message-test arm. No arm = the interim copy.
 *   2. Carries `v` and `source` onto the language links, so switching language keeps
 *      the arm the visitor was sent to.
 *   3. Submits the tester sign-up form as JSON to /api/early-access, including `v`
 *      and `source`, so sign-ups can be counted per arm.
 *
 * It sets no cookies, writes no localStorage or sessionStorage, sends no page views
 * and loads nothing from any other origin. Assignment is by the link a visitor was
 * given, never by tracking the visitor. See site/README.md, "Message test".
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var params = new URLSearchParams(window.location.search);

  var arm = (params.get('v') || '').toLowerCase();
  if (arm !== 'a' && arm !== 'b') arm = 'none';

  var source = params.get('source') || '';
  source = /^[A-Za-z0-9_-]{1,64}$/.test(source) ? source.toLowerCase() : 'direct';

  root.setAttribute('data-arm', arm);

  function applyArm(id) {
    var el = document.getElementById(id);
    if (!el || arm === 'none') return;
    var text = el.getAttribute('data-arm-' + arm);
    if (text) el.textContent = text;
  }
  applyArm('hero-title');
  applyArm('hero-sub');

  var query = [];
  if (arm !== 'none') query.push('v=' + arm);
  if (source !== 'direct') query.push('source=' + encodeURIComponent(source));
  if (query.length) {
    var links = document.querySelectorAll('a[data-keep-query]');
    for (var i = 0; i < links.length; i += 1) {
      var href = links[i].getAttribute('href').split('?')[0];
      links[i].setAttribute('href', href + '?' + query.join('&'));
    }
  }

  var form = document.getElementById('join-form');
  if (!form) return;

  document.getElementById('join-source').value = source;
  document.getElementById('join-v').value = arm;
  form.hidden = false;

  var whatsapp = document.getElementById('join-wa');
  var phoneField = document.getElementById('join-phone-field');
  var phone = document.getElementById('join-phone');
  function syncPhone() {
    // A phone number is only ever collected as an explicit WhatsApp-contact opt-in.
    phoneField.hidden = !whatsapp.checked;
    phone.required = whatsapp.checked;
    if (!whatsapp.checked) phone.value = '';
  }
  whatsapp.addEventListener('change', syncPhone);
  syncPhone();

  var status = document.getElementById('join-status');
  var button = form.querySelector('button[type="submit"]');

  function say(key) {
    status.textContent = form.getAttribute('data-msg-' + key) || '';
  }

  function checked(name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!form.checkValidity()) {
      say('invalid');
      form.reportValidity();
      return;
    }

    var body = {
      email: form.email.value.trim(),
      device: checked('device'),
      language: checked('language'),
      knowsFounder: checked('knowsFounder'),
      whatsappOptIn: whatsapp.checked,
      phone: whatsapp.checked ? phone.value.trim() : null,
      pageLanguage: root.getAttribute('lang'),
      source: source,
      v: arm,
      website: form.website.value
    };

    button.disabled = true;
    say('busy');
    fetch('/api/early-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (response) {
      if (response.ok) {
        say('ok');
        form.reset();
        syncPhone();
        return;
      }
      button.disabled = false;
      say(response.status === 422 ? 'invalid' : 'error');
    }).catch(function () {
      button.disabled = false;
      say('error');
    });
  });
})();
