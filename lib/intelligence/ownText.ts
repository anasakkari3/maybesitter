export interface OwnTextResult {
  readonly own: string;
  readonly boundary: 'quote_header' | 'no_quote' | 'unknown';
}

const QUOTE_HEADERS = [
  /^On .+ wrote:\s*$/im,
  /^في .+ كتب .+:\s*$/im,
  /^בתאריך .+ נכתב:\s*$/im,
  /^-{5,}\s*Forwarded message\s*-+\s*$/im,
  /^From:\s*.+$/im,
];

/** Conservative extraction: recognised mail-client boundaries only; ambiguous separators fail closed. */
export function ownTextOf(text: string): OwnTextResult {
  if (typeof text !== 'string') return { own: '', boundary: 'unknown' };
  let first = -1;
  for (const pattern of QUOTE_HEADERS) {
    const match = pattern.exec(text);
    if (match && (first < 0 || match.index < first)) first = match.index;
  }
  if (first >= 0) return { own: text.slice(0, first).trim(), boundary: 'quote_header' };
  if (/^\s*>/m.test(text) || /(^|\n)\s*={3,}.+={3,}\s*(\n|$)/.test(text)) {
    return { own: '', boundary: 'unknown' };
  }
  return { own: text.trim(), boundary: 'no_quote' };
}
