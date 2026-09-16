/**
 * The server fetching a URL a user pasted (UC-3.4, #188).
 *
 * A calendar feed URL is the one place in this product where somebody outside
 * the company chooses what the server connects to. On Cloud Run the thing
 * worth reaching is the metadata server at 169.254.169.254, which hands out the
 * service account's access token to anything that asks from inside; after that,
 * whatever sits on the VPC. So every refusal the issue lists is a test here,
 * and each is proved over a real TLS connection or at the DNS hook — not by
 * asserting on a helper that production might not call.
 *
 * ── How a test reaches a local server without weakening the guard ──
 *
 * The guard refuses loopback, so a test server on 127.0.0.1 is unreachable by
 * design. The test seam is therefore *after* the guard: `resolve` stands in for
 * DNS and answers what a public host would, the guard validates that answer
 * exactly as it would in production, and only then does `dialOverride` point
 * the socket at the local server. A stubbed DNS answer of `192.168.1.1` is
 * refused before any dial happens, which is the case that matters. The seam
 * refuses to exist under NODE_ENV=production, and that refusal is tested too.
 *
 * The certificate in tests/fixtures/ics/tls is a test-only CA and a leaf for
 * `feed.example` and `cdn.example`, valid for a century so the suite does not
 * start failing on a date nobody remembers. TLS verification stays on: the CA
 * is passed as `ca`, never by turning verification off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SafeFetchError,
  assertPublicAddress,
  normalizeFeedUrl,
  safeFetch,
  type SafeFetchOptions,
} from '../../lib/net/safeFetch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tlsDir = path.join(here, '..', 'fixtures', 'ics', 'tls');
const CA = readFileSync(path.join(tlsDir, 'ca.pem'), 'utf8');
const KEY = readFileSync(path.join(tlsDir, 'server.key'), 'utf8');
const CERT = readFileSync(path.join(tlsDir, 'server.pem'), 'utf8');

const PUBLIC_ADDRESS = '93.184.216.34';
const CALENDAR = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nEND:VCALENDAR\r\n';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (port: number, seen: IncomingMessage[]) => Promise<void>): Promise<void> {
  const seen: IncomingMessage[] = [];
  const server: Server = createServer({ key: KEY, cert: CERT }, (req, res) => {
    seen.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Every host resolves to one public address, and every dial goes to the local server. */
function testTransport(port: number, answers: Record<string, string[]> = {}): Partial<SafeFetchOptions> {
  return {
    ca: CA,
    resolve: async (hostname: string) => answers[hostname] ?? [PUBLIC_ADDRESS],
    dialOverride: { address: '127.0.0.1', port },
  };
}

async function refusal(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SafeFetchError, `expected a SafeFetchError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the fetch to be refused');
}

const calendarHandler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
  res.end(CALENDAR);
};

/* ── The URL alone ─────────────────────────────────────────────────── */

test('the issue list of URLs is refused before any DNS or socket is touched', async () => {
  const cases: Array<[string, SafeFetchError['code']]> = [
    ['http://feed.example/cal.ics', 'blocked_scheme'],
    ['ftp://feed.example/cal.ics', 'blocked_scheme'],
    ['file:///etc/passwd', 'blocked_scheme'],
    ['https://127.0.0.1/cal.ics', 'blocked_address'],
    ['https://[::1]/cal.ics', 'blocked_address'],
    ['https://169.254.169.254/computeMetadata/v1/', 'blocked_address'],
    ['https://metadata.google.internal/computeMetadata/v1/', 'blocked_host'],
    ['https://metadata/computeMetadata/v1/', 'blocked_host'],
    ['https://10.0.0.5/cal.ics', 'blocked_address'],
    ['https://[::ffff:10.0.0.5]/cal.ics', 'blocked_address'],
    ['https://[::ffff:7f00:1]/cal.ics', 'blocked_address'],
    ['https://172.16.0.1/cal.ics', 'blocked_address'],
    ['https://100.64.0.1/cal.ics', 'blocked_address'],
    ['https://0.0.0.0/cal.ics', 'blocked_address'],
    ['https://[fd00::1]/cal.ics', 'blocked_address'],
    ['https://[fe80::1]/cal.ics', 'blocked_address'],
    // The WHATWG parser normalises these to 127.0.0.1, which is the point of
    // parsing with it rather than with a regex.
    ['https://2130706433/cal.ics', 'blocked_address'],
    ['https://0x7f.1/cal.ics', 'blocked_address'],
    ['https://localhost/cal.ics', 'blocked_host'],
    ['https://printer.local/cal.ics', 'blocked_host'],
    ['https://db.internal/cal.ics', 'blocked_host'],
    ['https://app.localhost/cal.ics', 'blocked_host'],
    ['https://intranet/cal.ics', 'blocked_host'],
    // The fully-qualified spelling of the same names.
    ['https://metadata.google.internal./computeMetadata/v1/', 'blocked_host'],
    ['https://localhost./cal.ics', 'blocked_host'],
    ['https://metadata./computeMetadata/v1/', 'blocked_host'],
    ['https://printer.local../cal.ics', 'blocked_host'],
    ['https://feed.example:8443/cal.ics', 'blocked_port'],
    ['https://user:pw@feed.example/cal.ics', 'blocked_credentials'],
    ['https://user@feed.example/cal.ics', 'blocked_credentials'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
  ];
  let resolved = 0;
  for (const [url, code] of cases) {
    const error = await refusal(safeFetch(url, {
      resolve: async () => { resolved += 1; return [PUBLIC_ADDRESS]; },
      dialOverride: { address: '127.0.0.1', port: 1 },
    }));
    assert.equal(error.code, code, url);
    // The refusal names a reason and never the URL: a feed URL carries a token.
    assert.ok(!error.message.includes('feed.example'), `message leaked the host for ${url}`);
  }
  assert.equal(resolved, 0, 'a URL refused on its face must not reach DNS');
});

test('webcal: is read as https:, and an explicit :443 is accepted', () => {
  assert.equal(normalizeFeedUrl('webcal://feed.example/a.ics').protocol, 'https:');
  assert.equal(normalizeFeedUrl('WEBCAL://feed.example/a.ics').protocol, 'https:');
  assert.equal(normalizeFeedUrl('https://feed.example:443/a.ics').port, '');
  assert.equal(normalizeFeedUrl('  https://feed.example/a.ics  ').hostname, 'feed.example');
});

test('assertPublicAddress allows only global unicast, with IPv4-mapped IPv6 unwrapped first', () => {
  // A public IPv4 address written as IPv4-mapped IPv6 is that public address.
  for (const ok of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
    assert.doesNotThrow(() => assertPublicAddress(ok), ok);
  }
  for (const bad of [
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '255.255.255.255', '224.0.0.1', '240.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:169.254.169.254', '::ffff:192.168.1.1',
    '64:ff9b::a00:5', '2002:a00:5::1', 'not-an-ip',
  ]) {
    assert.throws(() => assertPublicAddress(bad), SafeFetchError, bad);
  }
});

/* ── DNS ───────────────────────────────────────────────────────────── */

test('a public host that resolves to a private address is refused at the DNS hook, before a socket opens', async () => {
  await withServer(calendarHandler, async (port, seen) => {
    for (const address of ['192.168.1.1', '169.254.169.254', '127.0.0.1', '::1', '::ffff:10.0.0.5']) {
      const error = await refusal(safeFetch('https://feed.example/cal.ics', {
        ...testTransport(port, { 'feed.example': [address] }),
      }));
      assert.equal(error.code, 'blocked_address', address);
    }
    assert.equal(seen.length, 0, 'no request may reach the server for a blocked answer');
  });
});

test('one private address among public ones refuses the whole answer', async () => {
  await withServer(calendarHandler, async (port, seen) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', {
      ...testTransport(port, { 'feed.example': [PUBLIC_ADDRESS, '10.0.0.5'] }),
    }));
    assert.equal(error.code, 'blocked_address');
    assert.equal(seen.length, 0);
  });
});

test('a host that resolves to nothing is a network failure, not an allowed fetch', async () => {
  await withServer(calendarHandler, async (port, seen) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', {
      ...testTransport(port, { 'feed.example': [] }),
    }));
    assert.equal(error.code, 'network');
    assert.equal(seen.length, 0);
  });
});

/* ── A real fetch, and its headers ─────────────────────────────────── */

test('a calendar is fetched over verified TLS with the conditional headers and our user agent', async () => {
  await withServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/calendar',
      etag: '"v2"',
      'last-modified': 'Tue, 15 Sep 2026 10:00:00 GMT',
    });
    res.end(CALENDAR);
  }, async (port, seen) => {
    const result = await safeFetch('webcal://feed.example/cal.ics?authtoken=secret', {
      ...testTransport(port),
      etag: '"v1"',
      lastModified: 'Mon, 14 Sep 2026 10:00:00 GMT',
    });
    assert.equal(result.notModified, false);
    assert.equal(result.notModified === false && result.body, CALENDAR);
    assert.equal(result.etag, '"v2"');
    assert.equal(result.lastModified, 'Tue, 15 Sep 2026 10:00:00 GMT');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers['user-agent'], 'MaybeSitter-ICS/1.0');
    assert.equal(seen[0]!.headers['if-none-match'], '"v1"');
    assert.equal(seen[0]!.headers['if-modified-since'], 'Mon, 14 Sep 2026 10:00:00 GMT');
    assert.equal(seen[0]!.headers.host, 'feed.example');
    assert.equal(seen[0]!.url, '/cal.ics?authtoken=secret');
  });
});

test('without the test CA the same server is refused: verification is on', async () => {
  await withServer(calendarHandler, async (port) => {
    const { ca: _ca, ...withoutCa } = testTransport(port);
    const error = await refusal(safeFetch('https://feed.example/cal.ics', withoutCa));
    assert.equal(error.code, 'network');
  });
});

test('a 304 is reported as not modified, with no body', async () => {
  await withServer((_req, res) => {
    res.writeHead(304, { etag: '"v1"' });
    res.end();
  }, async (port) => {
    const result = await safeFetch('https://feed.example/cal.ics', { ...testTransport(port), etag: '"v1"' });
    assert.equal(result.notModified, true);
  });
});

test('a non-2xx answer is refused with its status and nothing else', async () => {
  await withServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<h1>token expired for https://feed.example/cal.ics?authtoken=secret</h1>');
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'http_status');
    assert.equal(error.status, 403);
    assert.ok(!error.message.includes('secret'));
  });
});

/* ── Redirects ─────────────────────────────────────────────────────── */

test('a 302 to the metadata server is refused, and so is one to http:', async () => {
  for (const [location, code] of [
    ['http://169.254.169.254/computeMetadata/v1/', 'blocked_scheme'],
    ['https://169.254.169.254/computeMetadata/v1/', 'blocked_address'],
    ['https://metadata.google.internal/', 'blocked_host'],
    ['https://cdn.example:8443/cal.ics', 'blocked_port'],
  ] as const) {
    await withServer((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    }, async (port, seen) => {
      const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
      assert.equal(error.code, code, location);
      assert.equal(seen.length, 1, 'only the first hop may be requested');
    });
  }
});

test('a redirect to a host that resolves privately is refused at DNS', async () => {
  await withServer((req, res) => {
    if (req.headers.host === 'feed.example') {
      res.writeHead(301, { location: 'https://cdn.example/cal.ics' });
      res.end();
      return;
    }
    calendarHandler(req, res);
  }, async (port, seen) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', {
      ...testTransport(port, { 'cdn.example': ['192.168.1.1'] }),
    }));
    assert.equal(error.code, 'blocked_address');
    assert.equal(seen.length, 1);
  });
});

test('a relative redirect to a public host is followed, and the conditional headers are not replayed to it', async () => {
  await withServer((req, res) => {
    if (req.headers.host === 'feed.example') {
      res.writeHead(307, { location: 'https://cdn.example/moved.ics' });
      res.end();
      return;
    }
    calendarHandler(req, res);
  }, async (port, seen) => {
    const result = await safeFetch('https://feed.example/cal.ics', { ...testTransport(port), etag: '"v1"' });
    assert.equal(result.notModified, false);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.headers.host, 'cdn.example');
    assert.equal(seen[1]!.url, '/moved.ics');
    assert.equal(seen[0]!.headers['if-none-match'], '"v1"');
    assert.equal(seen[1]!.headers['if-none-match'], undefined);
  });
});

test('more than three redirects is refused', async () => {
  await withServer((req, res) => {
    const n = Number((req.url ?? '/0').slice(1)) || 0;
    res.writeHead(302, { location: `/${n + 1}` });
    res.end();
  }, async (port, seen) => {
    const error = await refusal(safeFetch('https://feed.example/0', testTransport(port)));
    assert.equal(error.code, 'too_many_redirects');
    assert.equal(seen.length, 4, 'the original request plus three followed hops');
  });
  // And exactly three is still fine.
  await withServer((req, res) => {
    const n = Number((req.url ?? '/0').slice(1)) || 0;
    if (n >= 3) return calendarHandler(req, res);
    res.writeHead(302, { location: `/${n + 1}` });
    res.end();
  }, async (port) => {
    const result = await safeFetch('https://feed.example/0', testTransport(port));
    assert.equal(result.notModified, false);
  });
});

test('a redirect with no Location is refused rather than treated as a body', async () => {
  await withServer((_req, res) => {
    res.writeHead(302);
    res.end(CALENDAR);
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'http_status');
  });
});

/* ── Size and time ─────────────────────────────────────────────────── */

test('a 3 MB body is refused while streaming, when no Content-Length announces it', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    const chunk = 'X'.repeat(64 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < 3 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'too_large');
  });
});

test('a Content-Length over the cap is refused before the body is read', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(3 * 1024 * 1024) });
    res.write(CALENDAR);
    // Never finishes: a refusal that waited for the body would hang here.
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'too_large');
  });
});

test('a body exactly at the cap is accepted and one byte over is not', async () => {
  const body = CALENDAR + 'X'.repeat(100 - CALENDAR.length);
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(body);
  }, async (port) => {
    const ok = await safeFetch('https://feed.example/cal.ics', { ...testTransport(port), maxBytes: 100 });
    assert.equal(ok.notModified === false && ok.body.length, 100);
    const error = await refusal(safeFetch('https://feed.example/cal.ics', { ...testTransport(port), maxBytes: 99 }));
    assert.equal(error.code, 'too_large');
  });
});

test('a response that never finishes is abandoned at the time cap', async () => {
  await withServer((_req, res) => {
    // Headers, a first line, and then nothing for as long as the test lives.
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.write('BEGIN:VCALENDAR\r\n');
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', { ...testTransport(port), timeoutMs: 150 }));
    assert.equal(error.code, 'timeout');
  });
  await withServer(() => {
    // No headers at all.
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', { ...testTransport(port), timeoutMs: 150 }));
    assert.equal(error.code, 'timeout');
  });
});

test('a compressed body is refused rather than inflated', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' });
    res.end('not really gzip');
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'bad_content_type');
  });
});

/* ── Content type ──────────────────────────────────────────────────── */

test('text/html is refused even when the body looks like a calendar', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CALENDAR);
  }, async (port) => {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
    assert.equal(error.code, 'bad_content_type');
  });
});

test('text/plain and octet-stream are accepted only when the body opens as a calendar', async () => {
  for (const type of ['text/plain', 'application/octet-stream', 'TEXT/PLAIN; charset=utf-8', undefined]) {
    await withServer((_req, res) => {
      res.writeHead(200, type ? { 'content-type': type } : {});
      res.end(`\ufeff \r\n${CALENDAR}`);
    }, async (port) => {
      const result = await safeFetch('https://feed.example/cal.ics', testTransport(port));
      assert.equal(result.notModified, false, String(type));
    });
    await withServer((_req, res) => {
      res.writeHead(200, type ? { 'content-type': type } : {});
      res.end('<html>BEGIN:VCALENDAR</html>');
    }, async (port) => {
      const error = await refusal(safeFetch('https://feed.example/cal.ics', testTransport(port)));
      assert.equal(error.code, 'bad_content_type', String(type));
    });
  }
});

/* ── The test seam itself ──────────────────────────────────────────── */

test('the dial override and the injected CA refuse to exist in production', async () => {
  const previous = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = 'production';
  try {
    const error = await refusal(safeFetch('https://feed.example/cal.ics', {
      resolve: async () => [PUBLIC_ADDRESS],
      dialOverride: { address: '127.0.0.1', port: 1 },
    }));
    assert.equal(error.code, 'invalid_options');
    const caError = await refusal(safeFetch('https://feed.example/cal.ics', { ca: CA }));
    assert.equal(caError.code, 'invalid_options');
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
  }
});
