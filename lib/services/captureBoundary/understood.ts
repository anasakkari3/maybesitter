import {
  UNDERSTOOD_TEXT_MAX,
  type CaptureAppLocale,
  type CaptureProposalContract,
  type CaptureUnderstoodPoint,
} from '../../../src/contracts/v1/captureContracts';
import { claimsSaved } from '../captureChat/chatReply';

export interface CaptureSourceOrdinals {
  items: Record<string, number>;
  seeds: Record<string, number>;
}

/** A complete URL-like run, removed without throwing away the words around it. */
const URL_RUN = /(?<![a-z0-9-])(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|[a-z][a-z0-9+.-]*:\/\/[^\s]*|www\.[^\s]*|webcal:[^\s]*|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9-])(?:[/?#][^\s]*)?)/gi;
const FILE_EXTENSION = /\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|txt|jpg|jpeg|png|heic|mp3|mp4|zip)$/i;
const CAPITALISED_HONORIFIC = /^(?:Mr|Dr|Mrs|Ms)\.[A-Z][A-Za-z0-9-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/** Arabic/Hebrew marks, tatweel, and invisible/bidi marks folded by the client. */
const FOLDED_AWAY = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7\u0640\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
/** Only these marks are removed from the line shown to the person. */
const INVISIBLE_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
/** Folded marks inside an ASCII host must not leave a partial host behind. */
const HOST_OBFUSCATING_MARKS = /(?<=[A-Za-z0-9.-])[\u064B-\u065F\u0670\u06D6-\u06ED\u0591-\u05C7\u0640]+(?=[A-Za-z0-9.-])/g;

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

function keptAsPlainWords(run: string): boolean {
  const lower = run.toLowerCase();
  if (run.includes('://') || lower.startsWith('www.') || lower.startsWith('webcal:')) return false;
  if (run.includes('@') || /[/?#]/.test(run)) return false;
  return FILE_EXTENSION.test(run) || CAPITALISED_HONORIFIC.test(run);
}

function foldedForClientChecks(source: string): string {
  return source
    .replace(FOLDED_AWAY, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\s+/g, ' ');
}

function hasLink(source: string): boolean {
  return Array.from(foldedForClientChecks(source).matchAll(URL_RUN))
    .some((match) => !keptAsPlainWords(match[0]));
}

function claimsSavedAsClient(source: string): boolean {
  const withLatinScriptEdges = source
    .replace(/([A-Za-z])(?=[\u0621-\u06FF\u0590-\u05FF])/g, '$1 ')
    .replace(/([\u0621-\u06FF\u0590-\u05FF])(?=[A-Za-z])/g, '$1 ');
  return claimsSaved(withLatinScriptEdges);
}

function lineFor(source: string, locale: CaptureAppLocale): string {
  const visible = source.replace(INVISIBLE_BIDI, '').replace(HOST_OBFUSCATING_MARKS, '');
  // The stored words as they are: a joining «و» was dropped once, where the
  // item or seed was made (`withoutClauseJoiner`), so the line and the card agree.
  const plain = visible
    .replace(CONTROL, ' ')
    .replace(URL_RUN, (run) => keptAsPlainWords(run) ? run : ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain || claimsSavedAsClient(plain)) return FALLBACK[locale];
  const clipped = clippedLine(plain);
  if (hasLink(clipped) || claimsSavedAsClient(clipped)) return FALLBACK[locale];
  return clipped;
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
      understood.push({ kind: 'commitment', itemId: item.itemId, text: lineFor(item.title, locale) });
      continue;
    }
    const seed = seedByRef.get(ref);
    if (seed) understood.push({ kind: seed.kind, seedItemId: seed.seedItemId, text: lineFor(seed.summary, locale) });
  }
  return { ...contract, understood };
}
