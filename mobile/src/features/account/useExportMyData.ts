import { useCallback, useRef, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { getAccountExport } from '../../api/endpoints/accountExport';
import { InputTooLargeError, QuotaExceededError } from '../../api/errors';
import { shareExportFile, type ShareFile } from '../../lib/dataExportFile';

/**
 * "Export my data" (#174 step 7): fetch, hand to the share sheet, forget.
 *
 * The export is held in a local variable for the length of one press and
 * nowhere else — not the query cache, not state. What stays behind is the
 * phase, so the row can say what happened.
 */
export type ExportPhase = 'idle' | 'preparing' | 'failed' | 'tooLarge' | 'rateLimited';

export function useExportMyData(share?: ShareFile | undefined) {
  const { t } = useApp();
  const [phase, setPhase] = useState<ExportPhase>('idle');
  // A second press while the first is still running does nothing: one export,
  // one sheet.
  const running = useRef(false);

  const start = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase('preparing');
    try {
      const exported = await getAccountExport();
      await shareExportFile(
        JSON.stringify(exported, null, 2),
        { dialogTitle: t.exportDataShareTitle, exportedAt: exported.exportedAt },
        share,
      );
      setPhase('idle');
    } catch (error) {
      // 413 is the account over the server's cap; 429 is the daily limit
      // (`export_rate_limited`, three a day). Anything else: try again.
      setPhase(
        error instanceof InputTooLargeError ? 'tooLarge'
          : error instanceof QuotaExceededError ? 'rateLimited'
            : 'failed',
      );
    } finally {
      running.current = false;
    }
  }, [t, share]);

  return { phase, start };
}

/** The line under the title for each phase. */
export function exportPhaseCopy(phase: ExportPhase, t: {
  exportDataBody: string; exportDataPreparing: string; exportDataFailed: string; exportDataTooLarge: string;
  exportDataRateLimited: string;
}): string {
  switch (phase) {
    case 'preparing': return t.exportDataPreparing;
    case 'failed': return t.exportDataFailed;
    case 'tooLarge': return t.exportDataTooLarge;
    case 'rateLimited': return t.exportDataRateLimited;
    default: return t.exportDataBody;
  }
}
