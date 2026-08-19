/**
 * Structural accessibility guards on `src/components/RecommendationReview.tsx`.
 *
 * ══ READ THIS BEFORE TREATING A GREEN RUN AS AN ACCESSIBILITY PASS ══════
 *
 * **What this file does.** It reads the component's source text and asserts that
 * the markup it emits carries the affordances an assistive technology needs:
 * every interactive element is a real `<button>` with an accessible name, every
 * `aria-labelledby` points at an id that exists in the same file, a polite live
 * region exists, `dir` is set from the view model so right-to-left locales
 * render right-to-left, and no non-interactive element carries a click handler.
 *
 * **What this file does not do, and cannot.** It does not render anything. It
 * therefore proves nothing about:
 *
 *   - **focus order** — that Tab reaches the confirm button before the next
 *     card. It *does* now check that a focus-restoration path exists when the
 *     confirmation panel unmounts, because that was a real defect readable from
 *     the JSX: confirming or cancelling unmounted the button holding focus and
 *     dropped it to `<body>`. Checking the path exists is not checking it works;
 *   - **what a screen reader actually announces** — whether NVDA, JAWS or
 *     VoiceOver reads the live region at the right moment, in the right voice,
 *     without interrupting itself;
 *   - **visual state** — focus rings, contrast, and reflow at 400% zoom.
 *     Whether `sr-only` is off-screen rather than `display: none` used to be
 *     listed here as unprovable; it is not, and it is now checked — the project
 *     does not override Tailwind's clip-based `.sr-only`, which is a one-line
 *     guard against silently muting the live region;
 *   - **runtime behaviour** — that pressing a verdict actually stages it, or
 *     that the confirm button is reachable at all.
 *
 * A green run here means *the markup carries the affordances*. It does not mean
 * the component passes an accessibility audit, and it must not be reported as
 * one.
 *
 * **Why it is written this way.** This repo has no DOM test infrastructure —
 * no testing-library, no jsdom, no playwright, no cypress, no vitest, no jest;
 * Node's built-in runner only. Adding a browser test stack is a large dependency
 * change that is out of scope for this issue and was not reviewed as part of it.
 * The honest response is the one taken here: move everything that can be wrong
 * into `lib/recommendation/review/present.ts`, which is pure and tested for real
 * in `reviewContract.test.ts`, and check by reading the source that what remains
 * is a faithful map from a view model to elements. The style follows the
 * repo's existing structural guards — `tests/planning/planningBoundaries.test.ts`
 * and `tests/decomposition/boundaryImportClosure.test.ts` — which likewise
 * assert properties no behavioural test in their suites would catch.
 *
 * **Deferred work.** Driving this component in a real browser with a real
 * assistive technology — focus order, announcement timing, and a manual audit
 * against WCAG — is recorded as deferred in
 * `docs/architecture/recommendation-review.md`. It needs a browser test stack
 * and a decision about which one, which is a separate change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const componentPath = join(repoRoot, 'src', 'components', 'RecommendationReview.tsx');
const source = readFileSync(componentPath, 'utf8');

/** The source with block and line comments removed, so prose cannot satisfy a check. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The name of the JSX element an attribute at `index` belongs to.
 *
 * Walking backwards to the opening `<` rather than matching a whole tag with
 * `<tag[^>]*>`, because JSX attribute values contain `>` — an arrow function in
 * an `onClick` is the common case — and a `[^>]*` tag matcher silently stops in
 * the middle of one. Sprint 06 recorded the general form of this: a pattern that
 * never matched the edge it existed to forbid went on reporting a clean result.
 */
function owningElement(at: number): string | null {
  for (let index = at; index >= 0; index -= 1) {
    if (code[index] !== '<') continue;
    const match = /^<\s*([A-Za-z][\w.]*)/.exec(code.slice(index, index + 40));
    return match === null ? null : match[1];
  }
  return null;
}

function occurrences(pattern: RegExp): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match = scanner.exec(code);
  while (match !== null) {
    found.push({ index: match.index, text: match[0] });
    match = scanner.exec(code);
  }
  return found;
}

/**
 * Every match of `pattern`, as an array.
 *
 * `String.prototype.matchAll` returns an iterator, and this repo compiles to ES5
 * without `downlevelIteration`, so spreading one is a compile error rather than
 * a runtime surprise. An explicit `exec` loop is what the repo's other
 * structural guards use.
 */
function allMatches(pattern: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match = scanner.exec(code);
  while (match !== null) {
    found.push(match);
    match = scanner.exec(code);
  }
  return found;
}

/** Raw attribute values, keeping `{expr}` and `"literal"` distinguishable but comparable. */
function attributeValues(name: string): string[] {
  const values: string[] = [];
  const scanner = new RegExp(`${name}=(\\{[^}]*\\}|"[^"]*")`, 'g');
  let match = scanner.exec(code);
  while (match !== null) {
    values.push(match[1]);
    match = scanner.exec(code);
  }
  return values;
}

/* ── Interactive elements ────────────────────────────────────────── */

test('a11y: every interactive control is a real button with a type and a name', () => {
  const buttons = allMatches(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g);
  assert.ok(buttons.length >= 3, `expected verdict, confirm and cancel buttons, found ${buttons.length}`);
  for (const button of buttons) {
    const attributes = button[1];
    const children = button[2];
    // `type="button"` because a button inside a form defaults to `submit`, and a
    // verdict press that submitted a form would navigate away from the offer
    // before anything was confirmed.
    assert.match(attributes, /type="button"/, 'a button has no explicit type');
    const hasAriaLabel = /aria-label=/.test(attributes);
    const hasChild = children.trim().length > 0;
    assert.ok(hasAriaLabel || hasChild, 'a button has neither an aria-label nor a child to name it');
  }
});

test('a11y: no click handler sits on a non-interactive element', () => {
  // A `div` with an `onClick` is unreachable by keyboard and invisible to a
  // screen reader's list of controls. It is the single most common way a UI
  // becomes keyboard-inoperable while looking finished.
  const interactive = new Set(['button', 'a', 'input', 'select', 'textarea']);
  for (const handler of occurrences(/on(?:Click|MouseDown|MouseUp)=/)) {
    const element = owningElement(handler.index);
    assert.ok(element !== null, 'a click handler belongs to no element');
    assert.ok(
      interactive.has((element as string).toLowerCase()),
      `a click handler sits on <${element}>, which is not interactive`,
    );
  }
});

test('a11y: nothing takes itself out of, or jumps ahead in, the tab order', () => {
  // A positive `tabIndex` moves an element ahead of everything with tabIndex 0,
  // which is the whole rest of the page. It produces a tab order that depends on
  // which components happen to be mounted.
  for (const match of allMatches(/tabIndex=\{(-?\d+)\}/g)) {
    assert.ok(Number(match[1]) <= 0, `tabIndex ${match[1]} jumps the document tab order`);
  }
  assert.ok(!/tabindex=/i.test(code.replace(/tabIndex=/g, '')), 'lowercase tabindex is not applied by React');
});

/* ── Names and relationships ─────────────────────────────────────── */

test('a11y: every aria-labelledby points at an id that exists in this file', () => {
  const ids = new Set(attributeValues('id'));
  const labelledBy = attributeValues('aria-labelledby');
  assert.ok(labelledBy.length >= 3, 'expected the section, the card and the button group to be labelled');
  assert.ok(ids.size >= 2, 'expected at least a section heading id and a card heading id');
  for (const target of labelledBy) {
    assert.ok(ids.has(target), `aria-labelledby=${target} names an id this file never renders`);
  }
});

test('a11y: the section, each card, and each button group carry a name', () => {
  // `role="group"` without a name is a group a screen reader announces as
  // "group" and nothing else, which is worse than no grouping at all.
  for (const role of occurrences(/role="group"/)) {
    const element = owningElement(role.index);
    assert.ok(element !== null);
    const tagStart = code.lastIndexOf('<', role.index);
    const tagText = code.slice(tagStart, code.indexOf('>', role.index) + 1);
    assert.match(tagText, /aria-label(ledby)?=/, 'a role="group" carries no accessible name');
  }
  assert.match(code, /<section[\s\S]{0,200}?aria-labelledby=/, 'the section carries no accessible name');
  assert.match(code, /<article[\s\S]{0,200}?aria-labelledby=/, 'an option card carries no accessible name');
});

test('a11y: headings descend in document order without skipping a level', () => {
  // The earlier version sorted the *set* of distinct levels and checked the set
  // was contiguous, which is insensitive to the order they appear in — an
  // `h3` mutated to `h5` survived it, because {2,4,5} sorted still looked fine
  // once 3 appeared elsewhere. A screen reader reads the outline in document
  // order, so the check has to be in document order too.
  const levels = allMatches(/<h([1-6])\b/g).map((match) => Number(match[1]));
  assert.ok(levels.length >= 4, 'expected a surface, group, card and why heading');
  assert.equal(levels[0], 2, 'the surface heading should be an h2 under the page h1');
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(
      levels[index] - levels[index - 1] <= 1,
      `heading outline jumps from h${levels[index - 1]} to h${levels[index]} at position ${index}`,
    );
    assert.ok(levels[index] >= 2, 'the surface must not emit an h1');
  }
});

test('a11y: focus is restored when the confirmation panel unmounts', () => {
  // Confirming or cancelling unmounts the div holding the button that currently
  // has focus. With nothing to catch it, focus falls to `<body>` and a keyboard
  // user restarts from the top of the document after every decision — the most
  // common way a two-step confirmation becomes unusable without being broken.
  assert.match(code, /useRef<HTMLButtonElement \| null>/, 'no ref is kept for the control that opened the panel');
  assert.match(code, /openerRef\.current = element/, 'the opening control is never recorded');
  assert.match(code, /opener\.focus\(\)/, 'focus is never returned to the opening control');
  // Both exits must go through the restoring path, not just the confirm one.
  const closers = allMatches(/onClick=\{closeStaged\}/g);
  assert.ok(closers.length >= 1, 'cancel does not use the focus-restoring handler');
  assert.match(code, /const confirm = \(\) => \{[\s\S]*?closeStaged\(\);/, 'confirm does not restore focus');
  assert.ok(!/setStaged\(null\);\s*\}\s*;?\s*$/m.test(code.replace(/const closeStaged[\s\S]*?\};/, '')), 'a bare setStaged(null) exit remains');
});

test('a11y: a control that opens the confirmation panel announces that it does', () => {
  // A disclosure with no `aria-expanded` is a button a screen reader announces
  // identically whether the panel is open or shut.
  assert.match(code, /aria-expanded=\{/, 'no verdict control exposes its expanded state');
  // Only the confirming verdicts open anything, so the others must not claim to.
  assert.match(code, /action\.requiresConfirmation\s*\?[\s\S]{0,200}?:\s*undefined/, 'aria-expanded is set on controls that open nothing');
});

test('a11y: staging a decision announces the prompt, not the notice already on screen', () => {
  // `notice ?? (staged ? view.confirmNotice : '')` had two defects: `??` only
  // falls through on null/undefined, so a server notice permanently swallowed
  // later staged announcements; and `confirmNotice` is the same sentence already
  // rendered statically above the cards, so the live region said nothing new.
  assert.match(
    code,
    /const announcement = staged !== null \? view\.confirmPrompt : notice \?\? ''/,
    'the live region does not announce the confirmation prompt when a decision is staged',
  );
});

test('a11y: the live region is clipped, not display:none', () => {
  // `display: none` and `visibility: hidden` remove a node from the
  // accessibility tree, so a live region styled that way is silent while looking
  // correct. The component uses Tailwind's `sr-only`, which is clip-based; the
  // risk is a project stylesheet overriding it.
  assert.match(code, /className="sr-only"/, 'the live region is not visually hidden');
  const globals = readFileSync(join(repoRoot, 'src', 'app', 'globals.css'), 'utf8');
  assert.ok(!/\.sr-only\b/.test(globals), 'the project overrides .sr-only; check it is still clip-based, not display:none');
});

test('a11y: the component renders no caller-chosen identifier', () => {
  // This is the check that was missing entirely. Every earlier id-leak test read
  // the *view model*; none read what the component prints. Two mutations went
  // green because of it, one of them `{view.recommendationId}` inside a card
  // heading — and the component is where the Sprint 07 leak actually landed.
  const forbidden = /\b(recommendationId|commitmentId|proposalId|itemId|scopeId)\b/;
  // Every JSX expression rendered as a child, i.e. `>{expr}<` or `{expr}` on its
  // own between tags — not attributes, which are checked separately.
  const rendered = allMatches(/[>}]\s*\{([^{}]+)\}\s*[<{]/g).map((match) => match[1]);
  assert.ok(rendered.length >= 6, `expected several rendered expressions, found ${rendered.length}`);
  for (const expression of rendered) {
    assert.ok(!forbidden.test(expression), `the component renders an identifier: {${expression.trim()}}`);
  }
  // `subject` is the object every identifier lives in. Rendering any part of it
  // is the same leak one indirection away.
  assert.ok(!/\{[^{}]*\bsubject\b[^{}]*\}/.test(code), 'the component renders the action subject');
});

/* ── The live region ─────────────────────────────────────────────── */

test('a11y: exactly one polite live region exists and it is never assertive', () => {
  const regions = attributeValues('aria-live');
  assert.equal(regions.length, 1, `expected one live region, found ${regions.length}`);
  assert.equal(regions[0], '"polite"');
  // `assertive` interrupts whatever the reader is saying. A confirmation notice
  // is not an emergency, and interrupting mid-sentence loses the sentence.
  assert.ok(!/aria-live="assertive"/.test(code));
});

/* ── Direction ───────────────────────────────────────────────────── */

test('a11y: every rendered section sets its direction from the view model', () => {
  const sections = occurrences(/<section\b/);
  assert.ok(sections.length >= 1);
  for (const section of sections) {
    const tagText = code.slice(section.index, code.indexOf('>', section.index) + 1);
    assert.match(tagText, /dir=\{view\.direction\}/, 'a section does not set dir from the view model');
  }
  // Not a hardcoded value: Arabic and Hebrew are two of the three locales this
  // product ships, so `dir="ltr"` in the markup is a bug in two thirds of it.
  assert.ok(!/dir="(ltr|rtl)"/.test(code), 'direction is hardcoded rather than taken from the locale');
});

/* ── The component decides nothing ───────────────────────────────── */

test('a11y: the component holds no copy of its own', () => {
  // Every string it renders arrives on the view model, so all three locales are
  // covered by reviewContract.test.ts rather than by a rendering test that does
  // not exist here.
  assert.ok(!/from '.*copy'/.test(code), 'the component imports the copy table');
  assert.ok(!/_COPY\b/.test(code), 'the component references a copy table');
  assert.ok(!/REVIEW_CHROME/.test(code), 'the component references chrome copy');
  // No bare JSX text: every rendered string is an expression from the view model.
  const jsxText = allMatches(/>\s*([A-Za-z][A-Za-z ,.'-]{6,})\s*</g).map((match) => match[1]);
  assert.deepEqual(jsxText, [], `the component renders literal text: ${jsxText.join(' | ')}`);
});

test('a11y: the component reads no clock, no randomness and no network', () => {
  const forbidden = [
    /\bDate\.now\s*\(/,
    /\bnew\s+Date\s*\(/,
    /\bMath\.random\s*\(/,
    /randomUUID/,
    /\bfetch\s*\(/,
    /localStorage/,
    /window\./,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(code), `the component matches ${pattern}`);
  }
});

test('a11y: the component decides nothing about confirmation', () => {
  // The rule for which verdicts need confirming lives in `CONFIRMING_VERDICTS`
  // and reaches the component only as `action.requiresConfirmation`. A component
  // that named the verdicts itself would be a second copy of that rule, and the
  // one nothing in this repo can test.
  assert.match(code, /action\.requiresConfirmation/);
  for (const verdict of ['accept', 'edit', 'defer', 'dismiss', 'done']) {
    assert.ok(!new RegExp(`'${verdict}'`).test(code), `the component names the verdict ${verdict} itself`);
  }
  // Exactly one piece of state: the staged decision. That is the two-step
  // confirmation, and nothing else in here is stateful.
  // Counting call sites, not the import: `useState` appears twice in the file
  // and only one of them is state.
  assert.equal(occurrences(/useState\s*[<(]/).length, 1);
});

test('a11y: the component imports only React and the review contract types', () => {
  const specifiers = allMatches(/from\s*'([^']+)'/g).map((match) => match[1]);
  assert.deepEqual(
    [...specifiers].sort(),
    ['../../lib/recommendation/review/reviewContract', 'react'],
  );
  // Type-only, so the component cannot reach the presenter's runtime — and
  // therefore cannot reach anything the presenter imports either.
  assert.match(code, /import type \{[\s\S]*?\} from '\.\.\/\.\.\/lib\/recommendation\/review\/reviewContract'/);
});

test('a11y: the confirm step is rendered separately from the verdict controls', () => {
  // The acceptance criterion is that nothing persists before explicit
  // confirmation. In the markup that means a second, distinct control: a verdict
  // press must not be able to reach `stage: 'confirmed'`.
  assert.match(code, /stage:\s*'unconfirmed'/);
  assert.match(code, /stage:\s*'confirmed'/);
  const staged = code.indexOf("stage: 'confirmed'");
  const confirmFn = code.indexOf('const confirm =');
  assert.ok(confirmFn >= 0 && staged > confirmFn, 'the confirmed stage is not emitted from the confirm handler');
  assert.match(code, /view\.confirmLabel/, 'the confirm button has no label from the view model');
  assert.match(code, /view\.cancelLabel/, 'there is no way back from a staged decision');
});
