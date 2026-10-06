import {
  UNDERSTOOD_TEXT_MAX,
  type CaptureAppLocale,
  type CaptureProposalContract,
  type CaptureUnderstoodPoint,
} from '../../../src/contracts/v1/captureContracts';
import { hasActionEvidence } from '../../../src/extraction/clauseSplitter';
import { detectUnresolvedIntent } from '../../../src/extraction/unresolvedIntent';

export interface CaptureSourceOrdinals {
  items: Record<string, number>;
  seeds: Record<string, number>;
}

/** A complete URL-like run, removed without throwing away the words around it. */
const URL_RUN = /(?:\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s]*)?)/gi;
// Kept deliberately broader than the generated lines. If the person's title
// itself claims that the assistant saved something, the understanding falls
// back to neutral fixed copy rather than repeating the claim.
const SAVED_CLAIM = /\b(?:i|we)(?:'ve| have| just| already| now| will|'ll)*\s+(?:added|saved|scheduled|booked|created|stored|recorded|logged|set|remind)\b|(?:ضفت|أضفت|حفظت|سجلت|حطيت|جدولت|انضاف|انحفظ|انسجل|رح\s*(?:ا|أ)?ذكرك)|(?:הוספתי|שמרתי|קבעתי|רשמתי|נשמר|נוסף|אזכיר)/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const FALLBACK: Readonly<Record<CaptureAppLocale, string>> = {
  ar: 'نقطة بدها مراجعة',
  en: 'A point to review',
  he: 'נקודה לבדיקה',
};

function clippedLine(plain: string): string {
  if (plain.length <= UNDERSTOOD_TEXT_MAX) return plain;
  let clipped = '';
  for (const character of plain) {
    if (clipped.length + character.length > UNDERSTOOD_TEXT_MAX - 1) break;
    clipped += character;
  }
  return `${clipped.trimEnd()}…`;
}

function withoutSplitJoiner(source: string, followsAnotherPoint: boolean): string {
  if (!followsAnotherPoint) return source;
  const joined = /^(?:and\s+|و|ו)/i.exec(source);
  if (!joined) return source;
  const remainder = source.slice(joined[0].length).trimStart();
  if (!remainder || (!hasActionEvidence(remainder) && !detectUnresolvedIntent(remainder))) return source;
  return remainder;
}

function lineFor(source: string, locale: CaptureAppLocale, followsAnotherPoint: boolean): string {
  const plain = withoutSplitJoiner(source, followsAnotherPoint)
    .replace(CONTROL, ' ')
    .replace(URL_RUN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain || SAVED_CLAIM.test(plain)) return FALLBACK[locale];
  return clippedLine(plain);
}

function refOf(point: CaptureUnderstoodPoint): string {
  return point.kind === 'commitment' ? `i:${point.itemId}` : `s:${point.seedItemId}`;
}

function existingOrder(contract: CaptureProposalContract): string[] | null {
  const points = contract.understood;
  if (!points) return null;
  const expected = [
    ...contract.items.map((item) => `i:${item.itemId}`),
    ...contract.seeds.map((seed) => `s:${seed.seedItemId}`),
  ];
  const actual = points.map(refOf);
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((ref) => actual.includes(ref))
    ? actual
    : null;
}

/**
 * The one proposal-understanding finalizer. Existing refs define the order
 * after a clarification; otherwise every ref needs a persisted source ordinal.
 * A legacy proposal without either carries no understanding rather than a
 * confidently wrong interleaved order.
 */
export function finalizeUnderstood(
  contract: CaptureProposalContract,
  locale: CaptureAppLocale,
  ordinals?: CaptureSourceOrdinals,
): CaptureProposalContract {
  const itemByRef = new Map(contract.items.map((item) => [`i:${item.itemId}`, item]));
  const seedByRef = new Map(contract.seeds.map((seed) => [`s:${seed.seedItemId}`, seed]));
  const refs = existingOrder(contract) ?? (() => {
    if (!ordinals) return null;
    const entries = [
      ...contract.items.map((item) => ({ ref: `i:${item.itemId}`, ordinal: ordinals.items[item.itemId] })),
      ...contract.seeds.map((seed) => ({ ref: `s:${seed.seedItemId}`, ordinal: ordinals.seeds[seed.seedItemId] })),
    ];
    if (entries.some((entry) => !Number.isFinite(entry.ordinal))) return null;
    return entries.sort((a, b) => a.ordinal! - b.ordinal!).map((entry) => entry.ref);
  })();
  if (!refs) {
    const { understood: _legacy, ...rest } = contract;
    return rest;
  }
  const understood: CaptureUnderstoodPoint[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    const item = itemByRef.get(ref);
    if (item) {
      understood.push({ kind: 'commitment', itemId: item.itemId, text: lineFor(item.title, locale, index > 0) });
      continue;
    }
    const seed = seedByRef.get(ref);
    if (seed) understood.push({ kind: seed.kind, seedItemId: seed.seedItemId, text: lineFor(seed.summary, locale, index > 0) });
  }
  return { ...contract, understood };
}
