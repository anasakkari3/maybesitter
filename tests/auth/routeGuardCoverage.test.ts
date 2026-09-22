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
  // Forty-two today: the football fixtures branch merged main (forty) and
  // brings two of its own from Task 11, `GET|PUT /api/mobile/football` and `DELETE /api/mobile/football/fixtures/{commitmentId}`
  // -- the dismiss route in particular is the one whose failure mode is
  // silent rather than loud: an unauthenticated caller who could reach it
  // would learn, from a 404-vs-200 timing difference alone, whether an
  // arbitrary commitment id belongs to somebody who follows football at all.
  // On main, UC-3.2 (#186) added `POST|DELETE /api/mobile/calendar/
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
  // Fifty total: origin/main's forty-eight routes plus football's two routes
  // (GET|PUT /api/mobile/football and DELETE /api/mobile/football/fixtures/{commitmentId}).
  // Fifty-one after #477: `POST /api/mobile/plans/{date}/build`, which writes a
  // plan into the caller's own account and so must know whose account it is.
  // Fifty-five after #525: the four `/api/mobile/watchers` routes. Two of them
  // are the reason the census matters here. `GET /watchers/{id}/history` is a
  // read of what somebody's watchers have observed about them — a timeline of
  // when their recovery dropped or their match moved — and an unauthenticated
  // caller reaching it would learn that from ids alone. `POST
  // /watchers/{id}/pause` is the control that stops a watcher acting at all,
  // so its guard is what keeps one account from silencing another's.
  // Fifty-eight after #519: the three Seed routes — `GET|POST /api/mobile/seeds`,
  // `PATCH|DELETE /api/mobile/seeds/{id}` and `POST /api/mobile/seeds/{id}/promote`.
  // A seed is a sentence somebody wrote about something they have not decided
  // to do, and the promote route is a door from one of those onto a real
  // commitment in somebody's account; all three must know whose account.
  // Fifty-nine after #527: `GET /api/mobile/trust/background-activity`. It is
  // a read of everything this app is watching for one person — which
  // providers, on what subjects, when it last looked — which is a profile of
  // somebody's life assembled in one response, and the most valuable thing on
  // this list to reach without a token.
  // Sixty after #527: `GET|PATCH /api/mobile/settings/monitoring`. It reads
  // and writes the global background monitoring pause control, which silences
  // effects across all watchers for the account.
  // Sixty-four after #520: the four `/api/mobile/habits` routes — `GET|POST
  // /habits`, `PATCH|DELETE /habits/{id}`, and `POST /habits/{id}/occurrences/
  // {occurrenceId}/complete` and `.../skip`. The two occurrence routes are the
  // reason the census matters here: each takes a decision about one dated piece
  // of somebody's week, and an unauthenticated caller reaching either would be
  // able to mark another person's habits done — which is both a write to their
  // record and, from the 404-vs-200 difference alone, a read of which habit and
  // occurrence ids are real.
  // Sixty-five after #526: `POST /api/mobile/goals/{goalId}/execution/generate`.
  // It writes nothing, which is what makes the guard the whole of its
  // protection: the goal id is a memory id, and an unauthenticated caller who
  // could reach this would learn from the 404-vs-200 difference whether a
  // given id names a real goal — and, on a 200, read that goal's own sentence
  // back out of the graph's titles.
  // Sixty-six after #527's attribution slice: `GET /api/mobile/trust/
  // background-activity/attribution`. It answers "which monitor decided this,
  // on what evidence, and under whose permission" over every background action
  // one account has had taken for it — the causal history of somebody's
  // autonomous work in one response, and a read that must know whose it is
  // before it returns a row.
  assert.equal(files.length, 66, `found:\n${files.join('\n')}`);
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
