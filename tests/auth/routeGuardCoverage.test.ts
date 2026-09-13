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
  // Twenty-two today: UC-1.5 (#149) added `DELETE /api/mobile/account`,
  // UC-2.1 (#161) the two consent routes, and UC-2.7a (#167) the profile pair
  // and the two memory routes. The number is asserted so that a route added
  // without a thought about authentication shows up here as well as in the loop.
  assert.equal(files.length, 22, `found:\n${files.join('\n')}`);
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
