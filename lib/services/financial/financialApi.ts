/**
 * The edge of the financial feature: what a request may say, and what a
 * response may contain.
 *
 * ── Why `observedAt` is not in the body ──────────────────────────
 *
 * The instant a manual value was stated is what the precedence rule uses to
 * decide which of two things the user said is the newer one. A client that
 * supplied it could hand itself the newest timestamp in the collection and
 * pin a field permanently, so the server stamps it. The client says what; the
 * server says when.
 *
 * ── Why every string has a length ────────────────────────────────
 *
 * A label is the only free text this feature stores. A cap here is not
 * tidiness: an unbounded string arriving at a route is the shape of the
 * capture ReDoS that shipped with a limit enforced only on the phone.
 */
import { randomUUID } from 'node:crypto';
import {
  FINANCIAL_OBLIGATION_CATEGORIES,
  isFinancialFieldId,
  type FinancialFieldId,
  type FinancialFieldValue,
  type FinancialManualKind,
  type FinancialObligationCategory,
} from '../../../src/contracts/v1/financialContracts';
import type { ManualFieldRow, ManualObligationRow } from './manualFinancialInputs';

export const FINANCIAL_LABEL_MAX_LENGTH = 120;
/** Well beyond any real balance, well inside exact integer arithmetic. */
export const FINANCIAL_AMOUNT_LIMIT = 1_000_000_000_000;
export const FINANCIAL_RECURRING_COUNT_LIMIT = 1_000;

const CURRENCY = /^[A-Za-z]{3}$/;

/** Which fields hold an amount, which hold a count, which hold text. */
const STRING_FIELDS: ReadonlySet<FinancialFieldId> = new Set<FinancialFieldId>(['currency', 'next_income_at']);
const COUNT_FIELDS: ReadonlySet<FinancialFieldId> = new Set<FinancialFieldId>(['recurring_count']);

export class FinancialValidationError extends Error {}

export function financialValidationResponse(error: FinancialValidationError): Response {
  return Response.json({ success: false, error: error.message }, { status: 400 });
}

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FinancialValidationError('expected an object');
  }
  return body as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new FinancialValidationError(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new FinancialValidationError(`${name} must not be empty`);
  if (trimmed.length > max) throw new FinancialValidationError(`${name} must be at most ${max} characters`);
  return trimmed;
}

function instant(value: unknown, name: string): string {
  const raw = text(value, name, 40);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new FinancialValidationError(`${name} must be an instant`);
  return new Date(parsed).toISOString();
}

function minorUnits(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new FinancialValidationError(`${name} must be an integer number of minor units`);
  }
  if (Math.abs(value) > FINANCIAL_AMOUNT_LIMIT) {
    throw new FinancialValidationError(`${name} is out of range`);
  }
  return value;
}

function currencyCode(value: unknown, name: string): string {
  const raw = text(value, name, 3);
  if (!CURRENCY.test(raw)) throw new FinancialValidationError(`${name} must be a three-letter currency code`);
  return raw.toUpperCase();
}

function category(value: unknown): FinancialObligationCategory {
  const raw = text(value, 'category', 32);
  if (!(FINANCIAL_OBLIGATION_CATEGORIES as readonly string[]).includes(raw)) {
    throw new FinancialValidationError('category is not one this product knows');
  }
  return raw as FinancialObligationCategory;
}

function manualKind(value: unknown): FinancialManualKind {
  if (value !== 'statement' && value !== 'correction') {
    throw new FinancialValidationError('kind must be "statement" or "correction"');
  }
  return value;
}

export function parseManualFieldRow(body: unknown, now: string): ManualFieldRow {
  const input = record(body);
  const raw = text(input.field, 'field', 64);
  if (!isFinancialFieldId(raw)) throw new FinancialValidationError('field is not one this product knows');
  const field: FinancialFieldId = raw;

  let value: FinancialFieldValue;
  if (field === 'currency') {
    value = currencyCode(input.value, 'value');
  } else if (STRING_FIELDS.has(field)) {
    value = instant(input.value, 'value');
  } else if (COUNT_FIELDS.has(field)) {
    const count = minorUnits(input.value, 'value');
    if (count < 0 || count > FINANCIAL_RECURRING_COUNT_LIMIT) {
      throw new FinancialValidationError('value is out of range');
    }
    value = count;
  } else {
    value = minorUnits(input.value, 'value');
  }

  return { field, kind: manualKind(input.kind), value, observedAt: now };
}

export function parseManualObligationRow(body: unknown, now: string): ManualObligationRow {
  const input = record(body);
  return {
    /*
     * A bare uuid, with no `manual-` prefix. The prefix carried no information
     * the row does not already have — its provenance says who stated it — and
     * it kept the id out of the fixture exporter's uuid normalisation, so
     * every run rewrote the fixture with a different one and a real shape
     * change would have been one line in a diff full of noise.
     */
    obligationId: input.obligationId === undefined
      ? randomUUID()
      : text(input.obligationId, 'obligationId', 64),
    label: text(input.label, 'label', FINANCIAL_LABEL_MAX_LENGTH),
    category: category(input.category),
    dueAt: instant(input.dueAt, 'dueAt'),
    amountMinorUnits: minorUnits(input.amountMinorUnits, 'amountMinorUnits'),
    currency: currencyCode(input.currency, 'currency'),
    recurring: input.recurring === true,
    observedAt: now,
  };
}

export function requireFinancialFieldId(value: unknown): FinancialFieldId {
  const raw = text(value, 'field', 64);
  if (!isFinancialFieldId(raw)) throw new FinancialValidationError('field is not one this product knows');
  return raw;
}
