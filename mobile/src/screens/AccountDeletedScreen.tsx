import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useApp } from '../state/AppContext';
import { useAccountDeletion } from '../features/account/AccountDeletionProvider';
import { Card, Pill, Txt } from '../ui/primitives';

/**
 * The last screen of the account's life (UC-1.5 #149).
 *
 * The user is owed proof, and "the server returned a receipt" is not proof
 * they received — so the receipt id is on screen, selectable and copyable,
 * with nothing else competing for attention.
 *
 * It renders **outside** `AuthGate`: the Firebase user is already gone, so the
 * gate is showing sign-in behind this. That is deliberate. Tapping Done drops
 * the receipt and reveals the signed-out app, with nothing of the deleted
 * account left in memory.
 *
 * It cannot restore anything. It holds three strings — an id, a timestamp and
 * per-step outcomes — and every store it could have read from was cleared
 * before it mounted.
 */
export function AccountDeletedScreen() {
  const { t, p } = useApp();
  const { receipt, acknowledgeReceipt } = useAccountDeletion();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!receipt) return;
    await Clipboard.setStringAsync(receipt.receiptId);
    setCopied(true);
  }, [receipt]);

  if (!receipt) return null;

  return (
    <View testID="account-deleted" style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 20, flexGrow: 1, justifyContent: 'center' }}>
        <Txt size={26} weight={600}>{t.accountDeletedTitle}</Txt>
        <Txt size={15} color={p.mu}>{t.accountDeletedBody}</Txt>

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={12} color={p.mu}>{t.accountDeletedReceiptLabel}</Txt>
          {/* `latin` and selectable: it is an opaque id the user may need to
              read out or paste into a support conversation. */}
          <Txt size={15} weight={600} latin selectable testID="receipt-id">
            {receipt.receiptId}
          </Txt>
          <Pill
            label={copied ? t.accountDeletedCopied : t.accountDeletedCopy}
            kind="soft"
            size={14}
            pad={10}
            onPress={() => void copy()}
          />
        </Card>

        <Pill label={t.accountDeletedContinue} kind="accent" onPress={acknowledgeReceipt} />
      </ScrollView>
    </View>
  );
}
