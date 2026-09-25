import React from 'react';
import { useApp } from '../../state/AppContext';
import { ProductRow } from '../../ui/product';
import { capabilities as cap } from '../product/capabilities';
import type { ShareFile } from '../../lib/dataExportFile';
import { exportPhaseCopy, useExportMyData } from './useExportMyData';

/**
 * The «تصدير بياناتي» row (#174 step 7). One press: the server builds the
 * export, the phone opens the share sheet on it, and the file is gone when the
 * sheet closes. The row's own line says when it is working or why it failed,
 * so the state is in the words and not only in a colour.
 */
export function ExportDataRow({ share }: { share?: ShareFile | undefined } = {}) {
  const { t } = useApp();
  const { phase, start } = useExportMyData(share);
  return (
    <ProductRow
      id="export-my-data"
      title={t.xExport}
      body={exportPhaseCopy(phase, t)}
      icon="file"
      status={cap.export}
      onPress={() => void start()}
    />
  );
}
