/**
 * The shell is only a fix while every screen goes through it.
 *
 * F1 and F2 were not one screen's bug: twenty-one screens had each written
 * the same wrong three lines, because there was nothing to write instead.
 * A shell that the twenty-second screen can quietly bypass would let both
 * defects back in the next time someone copies a neighbouring file — which
 * is exactly how they spread the first time.
 *
 * So this reads the source. Two rules, each with its own allow-list, and an
 * allow-list entry has to say why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const SRC = path.join(__dirname, '..', '..');

/**
 * Comments out. Every rule below is about what a screen *renders*, and these
 * files explain themselves at length — the shell's own doc comment names
 * `<SettingsHeader>` while rendering none.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n'"`]*\/\/.*$/gm, '');
}

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== '__mocks__' && entry.name !== '__fixtures__') walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push({ rel: path.relative(SRC, full), text: code(fs.readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(SRC);
  return out;
}

const ALL = sources();

/**
 * Who may read the top inset, and why. Everything else gets it from the
 * frame `Screen` puts it on.
 */
const MAY_READ_TOP_INSET: Record<string, string> = {
  'ui/screen.tsx': 'the shell — this is where the inset lives',
  'ui/taskHeader.tsx': 'a task header is already pinned above its own scroller; it is the frame for capture/review/share',
  'auth/VerifyEmailBanner.tsx': 'draws above the shell, over the status bar, and clears it itself',
  'features/language/LanguageStep.tsx': 'pre-sign-in, full bleed, no scroller to escape under the island',
  'features/onboarding/OnboardingChrome.tsx': 'pre-sign-in chrome, its own frame',
  'screens/SignInScreen.tsx': 'pre-sign-in, full bleed',
  'screens/SavedScreen.tsx': 'a confirmation frame that owns the inset outside its receipt scroller',
};

describe('the safe-area top has exactly one owner', () => {
  it('is read only by the shell and the frames that predate it', () => {
    const readers = ALL.filter((f) => /insets\.top/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(readers).toEqual(Object.keys(MAY_READ_TOP_INSET).sort());
  });

  it('every exception says why it is one', () => {
    for (const [file, reason] of Object.entries(MAY_READ_TOP_INSET)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(SRC, file))).toBe(true);
    }
  });
});

/** The modules that define the headers, rather than using them. */
const DEFINES_A_HEADER = ['ui/chrome.tsx', 'features/settings/SettingsChrome.tsx'];

describe('every screen with a header is framed by the shell', () => {
  it('renders <Screen> wherever it renders a header', () => {
    const offenders = ALL
      .filter((f) => !DEFINES_A_HEADER.includes(f.rel))
      .filter((f) => /<(BackHeader|SettingsHeader|ScreenHeader)\b/.test(f.text))
      .filter((f) => !/<Screen\b/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('no screen renders a header inside a scroller it built itself', () => {
    const offenders = ALL
      .filter((f) => !DEFINES_A_HEADER.includes(f.rel))
      .filter((f) => {
        const header = f.text.search(/<(BackHeader|SettingsHeader|ScreenHeader)\b/);
        if (header < 0) return false;
        // A header that appears after an opening <ScrollView/<SectionList/
        // <FlatList and before its close is inside the thing that scrolls.
        const before = f.text.slice(0, header);
        const opens = (before.match(/<(ScrollView|SectionList|FlatList)\b/g) ?? []).length;
        const closes = (before.match(/<\/(ScrollView|SectionList|FlatList)>/g) ?? []).length;
        return opens > closes;
      })
      .map((f) => f.rel)
      .sort();
    expect(offenders).toEqual([]);
  });
});
