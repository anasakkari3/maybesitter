/**
 * The only thing this feature writes down.
 *
 * Everything else — balances, cadence, the buffer, the band — is computed at
 * read time from the connection and thrown away. What persists is what the
 * person typed, because nothing else can recover it.
 *
 * ── One row per field ────────────────────────────────────────────
 *
 * A field row's document id is derived from the field name, so stating a value
 * again replaces the previous one rather than appending to a history. That is
 * what the precedence rule wants — only the newest manual entry decides — and
 * it gives the undo path a gesture: delete the row and the field goes back to
 * whatever the provider says.
 *
 * ── Scope is the account ─────────────────────────────────────────
 *
 * Every path is built with `userSubDoc(uid, …)` from this store's own uid,
 * which is fixed at construction and never taken from a caller's argument.
 * There is no method that accepts a uid, so there is no method that can be
 * handed the wrong one.
 */
import {
  isFinancialFieldId,
  type FinancialFieldId,
} from '../../../src/contracts/v1/financialContracts';
import { FINANCIAL_INPUTS, docIdForKey, userCol, userSubDoc } from '../../storage/paths';
import type { StorageAdapter } from '../../storage/storageAdapter';
import {
  EMPTY_MANUAL_FINANCIAL_INPUTS,
  type ManualFieldRow,
  type ManualFinancialInputs,
  type ManualObligationRow,
} from './manualFinancialInputs';

type StoredFieldRow = ManualFieldRow & { readonly rowType: 'field' };
type StoredObligationRow = ManualObligationRow & { readonly rowType: 'obligation' };
type StoredRow = StoredFieldRow | StoredObligationRow;

/** Free text never becomes a document id; the raw value stays in a field. */
function fieldDocId(field: FinancialFieldId): string {
  return docIdForKey(`financial-field:${field}`);
}

function obligationDocId(obligationId: string): string {
  return docIdForKey(`financial-obligation:${obligationId}`);
}

export class StoredManualFinancialStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
  ) {}

  private path(docId: string): string {
    return userSubDoc(this.uid, FINANCIAL_INPUTS, docId);
  }

  async read(): Promise<ManualFinancialInputs> {
    const rows = await this.storage.list<StoredRow>(userCol(this.uid, FINANCIAL_INPUTS));
    const fields: ManualFieldRow[] = [];
    const obligations: ManualObligationRow[] = [];

    for (const { data } of rows) {
      if (data.rowType === 'field') {
        // A row naming a field this build does not know is skipped rather than
        // surfaced. It is either a rollback or a forgery, and in both cases
        // resolving it would mean acting on a field id nothing validates.
        if (!isFinancialFieldId(data.field)) continue;
        const { rowType: _rowType, ...row } = data;
        fields.push(row);
      } else {
        const { rowType: _rowType, ...row } = data;
        obligations.push(row);
      }
    }

    if (fields.length === 0 && obligations.length === 0) return EMPTY_MANUAL_FINANCIAL_INPUTS;
    return {
      fields: Object.freeze(fields.sort((a, b) => a.field.localeCompare(b.field))),
      obligations: Object.freeze(
        obligations.sort((a, b) => a.obligationId.localeCompare(b.obligationId)),
      ),
    };
  }

  async putField(row: ManualFieldRow): Promise<void> {
    await this.storage.set<StoredFieldRow>(this.path(fieldDocId(row.field)), { ...row, rowType: 'field' });
  }

  /** The undo: the field goes back to whatever the provider says about it. */
  async deleteField(field: FinancialFieldId): Promise<void> {
    await this.storage.delete(this.path(fieldDocId(field)));
  }

  async putObligation(row: ManualObligationRow): Promise<void> {
    await this.storage.set<StoredObligationRow>(this.path(obligationDocId(row.obligationId)), {
      ...row,
      rowType: 'obligation',
    });
  }

  async deleteObligation(obligationId: string): Promise<void> {
    await this.storage.delete(this.path(obligationDocId(obligationId)));
  }
}
