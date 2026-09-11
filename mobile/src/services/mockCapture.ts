// Stand-in for POST /api/mobile/capture, reproducing the design's five routes:
// two commitments in one sentence, a missing time, an ambiguous day, a big
// task, and "nothing found". Swap for the real client when the backend returns
// sentence spans, ambiguity and size (see "fields that don't exist yet").
import type { Strings, Lang } from '../i18n/strings';
import type { ExampleKey, Part, Proposal } from '../state/types';
import { TODAY } from '../state/seed';

export const exampleKeys: ExampleKey[] = ['doctor', 'report', 'sami', 'study', 'hi'];

export function exampleText(key: ExampleKey, t: Strings): string {
  switch (key) {
    case 'doctor': return t.exDoctor;
    case 'report': return t.exReport;
    case 'sami': return t.exSami;
    case 'study': return t.exStudy;
    case 'hi': return t.exHi;
  }
}

type Kind = ExampleKey | 'generic';

function detectKind(input: string, t: Strings): Kind {
  const exact = exampleKeys.find(k => exampleText(k, t).trim() === input.trim());
  if (exact) return exact;
  const lo = input.toLowerCase();
  if (/دكتور|doctor/.test(lo) && /شغل|work/.test(lo)) return 'doctor';
  if (/تقرير|report/.test(lo)) return 'report';
  if (/سامي|sami/.test(lo)) return 'sami';
  if (/امتحان|exam|study|أدرس/.test(lo)) return 'study';
  if (/كيفك|how are you|hello|مرحبا/.test(lo)) return 'hi';
  return 'generic';
}

export type CaptureResult =
  | { kind: 'hi' }
  | { kind: Exclude<Kind, 'hi'>; parts: Part[]; proposals: Proposal[] };

export function analyzeText(input: string, t: Strings, _lang: Lang): CaptureResult {
  const kind = detectKind(input, t);
  const tomorrow = TODAY + 1;
  switch (kind) {
    case 'hi':
      return { kind };
    case 'doctor':
      return {
        kind,
        parts: [{ text: t.doctorPart, c: 0 }, { text: t.joinPart, c: -1 }, { text: t.workPart, c: 1 }],
        proposals: [
          { id: 'p1', title: t.pDoctor, day: tomorrow, h: 9, m: 0, imp: 'must', c: 0 },
          { id: 'p2', title: t.pWork, day: tomorrow, h: 11, m: 0, imp: 'should', c: 1 },
        ],
      };
    case 'report':
      return { kind, parts: [{ text: input, c: 0 }], proposals: [{ id: 'p1', title: t.pReport, day: tomorrow, h: null, m: 0, imp: 'must', c: 0, needsTime: true }] };
    case 'sami':
      return { kind, parts: [{ text: input, c: 0 }], proposals: [{ id: 'p1', title: t.pSami, day: TODAY, h: 16, m: 0, imp: 'should', c: 0, ambiguous: true }] };
    case 'study':
      return { kind, parts: [{ text: input, c: 0 }], proposals: [{ id: 'p1', title: t.pStudy, day: TODAY + 2, h: 17, m: 0, imp: 'must', c: 0, big: true }] };
    default:
      return {
        kind,
        parts: [{ text: input, c: 0 }],
        proposals: [{ id: 'p1', title: input.length > 40 ? input.slice(0, 38) + '…' : input, day: tomorrow, h: 10, m: 0, imp: 'should', c: 0 }],
      };
  }
}
