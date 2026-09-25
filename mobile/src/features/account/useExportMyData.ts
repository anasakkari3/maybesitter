import { useCallback, useRef, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { getAccountExport } from '../../api/endpoints/accountExport';
import { InputTooLargeError } from '../../api/errors';
import { shareExportFile, type ShareFile } from '../../lib/dataExportFile';

/**
 * "Export my data" (#174 step 7): fetch, hand to the share sheet, forget.
 *
 * The export is held in a local variable for the length of one press and
 * nowhere else — not the query cache, not state. What stays behind is the
 * phase, so the row can say what happened.
 */
export type ExportPhase = 'idle' | 'preparing' | 'failed' | 'tooLarge';

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
      setPhase(error instanceof InputTooLargeError ? 'tooLarge' : 'failed');
    } finally {
      running.current = false;
    }
  }, [t, share]);

  return { phase, start };
}

/** The line under the title for each phase. */
export function exportPhaseCopy(phase: ExportPhase, t: {
  exportDataBody: string; exportDataPreparing: string; exportDataFailed: string; exportDataTooLarge: string;
}): string {
  switch (phase) {
    case 'preparing': return t.exportDataPreparing;
    case 'failed': return t.exportDataFailed;
    case 'tooLarge': return t.exportDataTooLarge;
    default: return t.exportDataBody;
  }
}
