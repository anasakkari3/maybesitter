/**
 * The two responses the system browser sees during a Google connection (CL6a).
 *
 * Both are served outside `/api/mobile/**` because a browser carries no
 * Firebase token, and every `/api/mobile` handler authenticates first (the
 * route census asserts it). Neither of them can act for anybody:
 *
 *  - the **callback** only forwards `code`, `state` and a closed `error` value
 *    to the app's own scheme. The exchange happens later, in an authenticated
 *    POST, against a PKCE verifier that never left the server;
 *  - the **picker page** renders only after a one-time ticket minted by an
 *    authenticated route has been redeemed (`redeemDrivePickTicket`).
 *
 * Nothing here logs, and every response is `no-store` with no referrer, so the
 * code, the state and the page's token are not kept in a cache or sent onward
 * in a `Referer` header.
 */
import { randomBytes } from 'node:crypto';
import { GOOGLE_APP_RETURN_URL, GOOGLE_PICKER_RETURN_URL } from './googleConfig';
import { DRIVE_IMPORTABLE_TYPES, type PickerPageConfig } from './googleDrive';

const PRIVATE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

/** OAuth values are URL-safe printable ASCII; anything else is not one. */
const OAUTH_VALUE = /^[\x21-\x7e]{1,2048}$/;

/**
 * Google's redirect → the app.
 *
 * Only three parameters survive, and `error` is reduced to a closed set so a
 * crafted link cannot put arbitrary text in front of the app. The target is a
 * constant: this is not an open redirect, whatever the query says.
 */
export function oauthCallbackRedirect(requestUrl: string): Response {
  const incoming = new URL(requestUrl).searchParams;
  const target = new URL(GOOGLE_APP_RETURN_URL);
  const code = incoming.get('code');
  const state = incoming.get('state');
  const error = incoming.get('error');
  if (error !== null) {
    target.searchParams.set('error', error === 'access_denied' ? 'access_denied' : 'failed');
  } else if (code !== null && state !== null && OAUTH_VALUE.test(code) && OAUTH_VALUE.test(state)) {
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
  } else {
    target.searchParams.set('error', 'failed');
  }
  return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, location: target.toString() } });
}

/** JSON that cannot close the `<script>` element it sits in. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/**
 * The page that hosts Google Picker.
 *
 * The configuration travels in an inert `application/json` block rather than
 * interpolated into script, and the only script that runs is this page's own,
 * by nonce, plus whatever Google's loader it trusts pulls in (`strict-dynamic`).
 * Picking a file sends the browser to the app's scheme with the file id and
 * nothing else; cancelling sends it back with `cancelled=1`.
 */
export function pickerPage(config: PickerPageConfig, random: (size: number) => Buffer = randomBytes): Response {
  const nonce = random(16).toString('base64');
  const data = scriptSafeJson({
    token: config.accessToken,
    key: config.apiKey,
    appId: config.appId,
    returnUrl: config.returnUrl,
    mimeTypes: Object.values(DRIVE_IMPORTABLE_TYPES).join(','),
  });
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Google Drive</title>
<style>body{margin:0;padding:24px;font-family:-apple-system,system-ui,sans-serif;background:#fbf8f4;color:#2b2a28}</style>
</head>
<body>
<script type="application/json" id="picker-config">${data}</script>
<script nonce="${nonce}">
(function () {
  var config = JSON.parse(document.getElementById('picker-config').textContent);
  document.getElementById('picker-config').textContent = '';
  function back(query) { window.location.replace(config.returnUrl + '?' + query); }
  function build() {
    var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(config.mimeTypes)
      .setSelectFolderEnabled(false);
    var picker = new google.picker.PickerBuilder()
      .setOAuthToken(config.token)
      .setDeveloperKey(config.key)
      .setAppId(config.appId)
      .addView(view)
      .setCallback(function (data) {
        var action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          var doc = data[google.picker.Response.DOCUMENTS][0];
          back('fileId=' + encodeURIComponent(doc[google.picker.Document.ID]));
        } else if (action === google.picker.Action.CANCEL) {
          back('cancelled=1');
        }
      })
      .build();
    picker.setVisible(true);
  }
  var loader = document.createElement('script');
  loader.src = 'https://apis.google.com/js/api.js';
  loader.onload = function () { gapi.load('picker', { callback: build }); };
  loader.onerror = function () { back('error=failed'); };
  document.head.appendChild(loader);
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' 'strict-dynamic' https:`,
        "style-src 'unsafe-inline' https:",
        'img-src https: data:',
        'font-src https: data:',
        'connect-src https://*.googleapis.com https://*.google.com',
        'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com',
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  });
}

/** A ticket that did not redeem: the same page for every reason, sending the browser back. */
export function pickerExpiredPage(): Response {
  const target = `${GOOGLE_PICKER_RETURN_URL}?error=expired`;
  return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, location: target } });
}
