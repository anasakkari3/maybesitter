import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const ARABIC_LETTER = /[ء-غف-ي]/;
const ARABIC_INDIC_DIGIT = /[٠-٩۰-۹]/;

describe('production Arabic copy', () => {
  it('does not ship internal roadmap copy', () => {
    for (const bundle of [ar, en, he] as Record<string, unknown>[]) {
      expect(bundle).not.toHaveProperty('settingsNote');
    }
    expect(Object.values(ar).join('\n')).not.toMatch(/الجولة القادمة|تُصمَّم|roadmap/i);
  });

  // POLISH-MOBILE sweep: no promise of a later build, and no planner jargon
  // («نافذة حداثة», "freshness window") on a screen the person reads.
  it('promises nothing for later and speaks no internal jargon', () => {
    expect(Object.values(ar).join('\n')).not.toMatch(/(^|[^ت])(قريبًا|قريباً)|نافذة حداثة/); // «تقريباً» is 'about'
    expect(Object.values(en).join('\n')).not.toMatch(/coming soon|freshness window/i);
    expect(Object.values(he).join('\n')).not.toMatch(/חלון טריות/);
  });

  it('pins the audited critical repairs', () => {
    // Parcels (and flights) are not offered anywhere until a provider is
    // approved (closure CL7, council ruling): the key is gone, not renamed.
    // #687 had corrected «طرد» to «شحنة» here; CL7 removed the row itself.
    expect(ar).not.toHaveProperty('xPackage');
    expect(ar.captureClipboardBody).toContain('قبل ما تختار «استخدم النص»');
    expect(ar.memoryDeleteAllAlso).toContain('اللي اتعلّمناه');
    expect(ar.memoryWhyNoObservations).toBe('ما في إشي اتراقب وطلع منه هاد.');
    expect(ar.notifGentleBody).toContain('حاططله وقت');
    expect(ar.undonePartialTitle).toBe('رجعنا جزء منها');
    expect(ar.widgetSaveFailed).toContain('على هالتلفون');
    expect(ar.obConsentSaving).toBe('عم نحفظ…');
    expect(ar.shareAnalyzing).toBe('عم نقرا الإشي اللي شاركته…');
    expect(ar.financialAddBillTitle).toBe('أضف فاتورة غير ظاهرة بالمصدر');
    expect(ar.icsFeedsApplyMove).toBe('انقل التزامي لنفس الوقت');
    expect(ar.feedbackHistoryTitle).toBe('شو تعلّم منك');
    expect(ar.sourcesBody).toBe('مصادر بتضيف التزامات لأيامك تلقائيًا.');
    expect(ar.widgetShowTitlesBody).not.toMatch(/آيفون|iPhone|iOS/);
  });

  it('uses the canonical labels for core actions', () => {
    expect(ar.editItemSave).toBe('احفظ');
    expect(ar.nextStepEditSave).toBe('احفظ');
    expect(ar.accept).toBe('اقبل');
    expect(ar.planAccept).toBe('اقبل الخطة');
    expect(ar.editClose).toBe('إغلاق');
    expect(ar.detailsEdit).toBe('عدّل');
    expect(ar.notNow).toBe('مش هلّق');
    expect(ar.rowPostpone).toBe('مش هلّق');
  });

  it('uses the agreed vocabulary and Latin digits', () => {
    const copy = Object.entries(ar)
      .filter(([key, value]) => typeof value === 'string' && key !== 'suggestionNote' && key !== 'authTitle')
      .map(([, value]) => value)
      .join('\n');

    expect(copy).not.toMatch(ARABIC_INDIC_DIGIT);
    expect(copy).not.toMatch(/مايبي سيتر|هلأ|(?<!هلّ)هلق|أيمتى|إيمتى|(^|\s)لسا(?=\s|[.،؟!])/m);
    expect(copy).not.toMatch(/(^|\s)يلي(?=\s|[.،؟!])|الإشيا|الزق|دوس|طُلّ/);
    expect(copy).not.toMatch(/كمان مرة|مرة تانية|حوالين|(^|\s)متل(?=\s|[.،؟!])|لأنو/);
    expect(copy).not.toMatch(/(^|\s)(?:ما فينا|فينا|فيك)(?=\s|[.،؟!])|(^|\s)النت(?=\s|[.،؟!])/m);
    expect(copy).not.toMatch(/خطّة|هذي|موديل/);
    expect(ar.icsFeedsHelp).toContain('Moodle (مودل)');
    expect(`${ar.obRecBody}\n${ar.financialPrivacyNote}`).toMatch(/نموذج ذكاء اصطناعي/);
    expect(ar.suggestionNote).toBe('هذا اقتراح. لم يتغيّر أي شيء بعد.');
  });
});

function tsxFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : tsxFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('Arabic UI copy ownership', () => {
  it('keeps Arabic user-facing strings in locale files', () => {
    const sourceRoot = path.resolve(__dirname, '../..');
    const violations: string[] = [];

    for (const file of tsxFiles(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const relative = path.relative(sourceRoot, file);

      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
          const value = node.getText(ast).replace(/^['"`]|['"`]$/g, '').trim();
          const allowedLanguageEndonym = relative === 'features/capture/voice/VoiceLanguageChip.tsx'
            && value === 'عربي';
          if (ARABIC_LETTER.test(value) && !allowedLanguageEndonym) {
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
            violations.push(`${relative}:${line}: ${value}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(violations).toEqual([]);
  });
});
