/**
 * Every mobile route is guarded, enumerated from the filesystem (UC-1.0e, #144).
 *
 * The point is the enumeration. A per-route test only covers the routes
 * somebody remembered to write a test for, and the failure this guards
 * against is precisely the route nobody remembered: the previous guard was
 * applied route by route, and the six that got the *optional* variant were
 * the six that collapsed to a shared anonymous scope.
 *
 * So this walks `src/app/api/mobile/**` rather than importing a list, and a
 * new route file is covered the moment it exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE_ROUTES = join(process.cwd(), 'src', 'app', 'api', 'mobile');

/** The HTTP verbs Next treats as route handlers. */
const HANDLER = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...routeFiles(path));
    else if (entry === 'route.ts') found.push(path);
  }
  return found.sort();
}

const files = routeFiles(MOBILE_ROUTES);

/**
 * The two feedback routes reach the guard through `resolveFeedbackScope`,
 * which calls `requireMobileUser` itself. They are named here rather than
 * waved through by a pattern, and the indirection is asserted separately
 * below — otherwise "it calls some function" would satisfy this test.
 */
const GUARDED_VIA_SCOPE = new Set([
  join(MOBILE_ROUTES, 'feedback', 'history', 'route.ts'),
  join(MOBILE_ROUTES, 'feedback', '[id]', 'revoke', 'route.ts'),
]);

test('every mobile route file exists and is enumerated', () => {
  // Thirty-six today: UC-3.2 (#186) added `POST|DELETE /api/mobile/calendar/
  // busy`. It is the route somebody's calendar travels over, so the guard is
  // the thing that decides whether busy time is filed under the account that
  // owns it — and the `DELETE`, which is "disconnect and remove what you
  // have", must not be reachable by anybody but that account.
  // Thirty-five before that: UC-3.1 (#185) added `PUT|DELETE /api/mobile/commitments/
  // {id}/device-calendar-link` and `GET|PUT /api/mobile/settings/calendar`. The
  // link route is the one whose *refusal* is load-bearing rather than its
  // success — it is what stops a second device writing a duplicate event — so
  // it matters that it authenticates first: an unauthenticated caller must not
  // learn whether a commitment id is linked.
  // Thirty-three before that: UC-3.0 (#183) added `POST /api/mobile/capture/share`,
  // Thirty-six today: UC-3.0 (#183) added `POST /api/mobile/capture/share`,
  // the one route that takes bytes. It checks its feature flag and its declared
  // body size before it authenticates — deliberately, so an unauthenticated
  // 25 MB upload costs a header read rather than a full receive — but the guard
  // is still the first thing that touches the body, and the loop below still
  // holds it to one `requireMobileUser` per handler. UC-3.11 (#196) added
  // `/settings/reminders` and UC-3.0b (#184) `POST /api/mobile/devices` and
  // `DELETE /api/mobile/devices/{id}`.
  // Thirty-two before that: UC-3.15 (#201) added `GET /api/mobile/activity` and
  // `GET /api/mobile/activity/summary`.
  // Thirty before that: UC-3.10a (#194) added the three `/plans/{date}` routes
  // and `/settings/plan`.
  // Twenty-six before that: UC-2.5 (#165) added `POST /api/mobile/capture/clarify`.
  // Twenty-five before that: UC-2.7b (#168) added the describe pair.
  // Twenty-three before that: UC-1.5 (#149) added `DELETE /api/mobile/account`,
  // UC-2.1 (#161) the two consent routes, UC-2.7a (#167) the profile pair and
  // the two memory routes, and UC-2.9 (#170) the recommendation consent route.
  // The number is asserted so that a route added without a thought about
  // authentication shows up here as well as in the loop.
  // Thirty-eight after this lane merged with #185's: the three added here are
  // `POST /api/mobile/devices`, `DELETE /api/mobile/devices/{installationId}`
  // and `GET|PUT /api/mobile/settings/reminders`, on top of main's thirty-five.
  // The number is a census, not a guarantee: it is here so that adding a route
  // is a decision somebody takes rather than a file that appears.
  // Thirty-nine after #415: `GET|PUT /api/mobile/settings/categories`. It is a
  // display preference, but it is also what the extraction prompt is built from
  // — an unauthenticated write would choose which categories somebody else's
  // captures are sorted into.
  // Forty after #186 merged on top: `POST|DELETE /api/mobile/calendar/busy`,
  // the route somebody's calendar travels over. Its DELETE is "disconnect and
  // remove what you hold", and it must not be reachable by anyone but the
  // account that owns the source.
  assert.equal(files.length, 40, `found:\n${files.join('\n')}`);
});

test('every mobile route handler runs an authentication guard before anything else', () => {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const handlers = source.match(HANDLER) ?? [];
    assert.ok(handlers.length > 0, `${file} exports no route handler`);

    if (GUARDED_VIA_SCOPE.has(file)) {
      const scopeCalls = source.split('await resolveFeedbackScope(request)').length - 1;
      assert.equal(
        scopeCalls,
        handlers.length,
        `${file} has ${handlers.length} handler(s) but ${scopeCalls} resolveFeedbackScope call(s)`,
      );
      continue;
    }

    const guardCalls = source.split('await requireMobileUser(request').length - 1;
    assert.equal(
      guardCalls,
      handlers.length,
      `${file} has ${handlers.length} handler(s) but ${guardCalls} requireMobileUser call(s)`,
    );
    assert.match(
      source,
      /import \{[^}]*requireMobileUser[^}]*\} from '[^']*lib\/auth\/mobileAuth'/,
      `${file} must import requireMobileUser from lib/auth/mobileAuth`,
    );
  }
});

test('no mobile route can still reach the retired optional guard', () => {
  for (const file of [...files, join(process.cwd(), 'lib', 'feedbackHistory', 'feedbackHistoryRoutes.ts')]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /optionalMobilePilotAuth|requireMobilePilotAuth/, `${file} still references the retired guard`);
    assert.doesNotMatch(source, /services\/mobile\/auth/, `${file} still imports the deleted guard module`);
  }
});

test('no mobile route can produce the anonymous participant', () => {
  // `'anonymous'` was a real participant id this codebase wrote data under,
  // shared by every unauthenticated caller.
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /'anonymous'|"anonymous"/, `${file} still has an anonymous fallback`);
  }
});

test('the feedback scope resolver is itself guarded', () => {
  const source = readFileSync(join(process.cwd(), 'lib', 'feedbackHistory', 'feedbackHistoryRoutes.ts'), 'utf8');
  assert.match(source, /await requireMobileUser\(request\)/);
  // The scope is derived from the uid, so there is no undefined case left for
  // it to collapse into the shared default scope with.
  assert.match(source, /export function feedbackScopeIdFor\(uid: string\)/);
});
