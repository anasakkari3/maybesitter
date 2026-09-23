import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import {
  useClearFinancialField,
  useConnectFinancialSource,
  useDisconnectFinancialSource,
  useFinancialConnection,
  useFinancialContext,
  useSaveFinancialField,
} from '../../api/queries';
import type {
  FinancialConflict,
  FinancialObligation,
  FinancialProvenance,
  FinancialState,
} from '../../api/schemas/financial';
import { ltr } from '../../i18n/strings';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from './SettingsChrome';

const BAND_COPY = {
  comfortable: 'financialBandComfortable',
  tight: 'financialBandTight',
  negative: 'financialBandNegative',
  unknown: 'financialBandUnknown',
} as const;

const ORIGIN_COPY = {
  provider: 'financialFromSource',
  manual: 'financialFromYou',
  computed: 'financialComputed',
} as const;

const CATEGORY_COPY = {
  rent: 'financialCategoryRent',
  card: 'financialCategoryCard',
  loan: 'financialCategoryLoan',
  subscription: 'financialCategorySubscription',
  utility: 'financialCategoryUtility',
  tuition: 'financialCategoryTuition',
  other: 'financialCategoryOther',
} as const;

/**
 * Minor units into something a person recognises.
 *
 * Two decimals for every currency here, which is true of the ones this feature
 * can reach and is stated rather than assumed — a zero-decimal currency would
 * need the exponent from the source, and the place to get it is the provider,
 * not a table on the phone. Wrapped in `ltr` because a number beside Arabic
 * text otherwise drags its sign and separators to the wrong side.
 */
function money(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(minorUnits);
  const major = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return ltr(`${sign}${major.toLocaleString('en-US')}.${cents} ${currency}`);
}

function day(instant: string): string {
  return ltr(new Date(instant).toISOString().slice(0, 10));
}

export function FinancialContextScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const context = useFinancialContext();
  const connection = useFinancialConnection();
  const connect = useConnectFinancialSource();
  const disconnect = useDisconnectFinancialSource();
  const saveField = useSaveFinancialField();
  const clearField = useClearFinancialField();
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);

  const state: FinancialState | null = context.data?.state ?? null;
  const connected = connection.data?.connected === true;

  /** Where a value came from, said in words beside the value itself. */
  const Origin = ({ provenance, testID }: { provenance: FinancialProvenance; testID: string }) => (
    <Txt size={12} color={p.mu} testID={testID}>
      {provenance.origin === 'computed'
        ? `${t[ORIGIN_COPY.computed]} · ${provenance.contributingSources.map(source => t[ORIGIN_COPY[source]]).join(' + ')}`
        : t[ORIGIN_COPY[provenance.origin]]}
    </Txt>
  );

  const Line = ({ label, amount, testID }: {
    label: string;
    amount: { minorUnits: number; currency: string; provenance: FinancialProvenance } | null;
    testID: string;
  }) => (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <Txt size={14}>{label}</Txt>
        <Txt size={15} weight={600} testID={testID}>
          {amount === null ? t.financialUnknown : money(amount.minorUnits, amount.currency)}
        </Txt>
      </View>
      {amount === null ? null : <Origin provenance={amount.provenance} testID={`${testID}-origin`} />}
    </View>
  );

  const saveCorrection = async () => {
    setFailed(false);
    const typed = draft.trim();
    /*
     * The empty string is the case worth spelling out: `Number('')` is 0, not
     * NaN, so a bare `Number.isFinite` check would take an empty field as a
     * deliberate "I have nothing" and file a correction of zero — a number no
     * later sync would ever undo. The button is disabled while the field is
     * empty, but a disabled button is a UI state and this is the value.
     */
    if (typed.length === 0 || !/^-?\d+(\.\d{1,2})?$/.test(typed)) { setFailed(true); return; }
    const major = Number(typed);
    if (!Number.isFinite(major)) { setFailed(true); return; }
    try {
      // A correction, not a statement: the user is overruling a reading the
      // source produced, and that is the thing no later sync undoes.
      await saveField.mutateAsync({
        field: 'cash_available',
        kind: 'correction',
        value: Math.round(major * 100),
      });
      setDraft('');
    } catch {
      setFailed(true);
    }
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 80, gap: 14 }}>
        <SettingsHeader title={t.financialTitle} onBack={onBack} />

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.financialSourceTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.financialSourceBody}</Txt>
          <Txt size={13} testID="financial-connection-state">
            {connected ? t.financialSourceSandbox : t.financialSourceNone}
          </Txt>
          <Btn
            label={connected ? t.financialDisconnect : t.financialConnect}
            testID="financial-connect-toggle"
            onPress={() => void (connected ? disconnect.mutateAsync() : connect.mutateAsync()).catch(() => setFailed(true))}
            disabled={connect.isPending || disconnect.isPending}
            style={{
              minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
              backgroundColor: connected ? p.bg : p.ac, borderWidth: 1, borderColor: connected ? p.ln : p.ac,
            }}
          >
            <Txt size={15} weight={600} color={connected ? p.tx : '#FFFFFF'}>
              {connected ? t.financialDisconnect : t.financialConnect}
            </Txt>
          </Btn>
        </Card>

        <Card pad={18} style={{ gap: 12 }}>
          <Txt size={15} weight={600}>{t.financialPictureTitle}</Txt>
          {context.isLoading ? (
            <Txt size={13} color={p.mu} testID="financial-loading">{t.financialLoading}</Txt>
          ) : context.isError || state === null ? (
            <Txt size={13} color={p.mu} testID="financial-unavailable">{t.financialUnavailable}</Txt>
          ) : (
            <View style={{ gap: 12 }}>
              <Txt size={14} weight={600} color={state.bufferBand === 'comfortable' ? p.tx : p.wm} testID="financial-band">
                {t[BAND_COPY[state.bufferBand]]}
              </Txt>
              <Line label={t.financialCashAvailable} amount={state.cashAvailable} testID="financial-cash" />
              <Line label={t.financialDueBeforeIncome} amount={state.obligationsBeforeNextIncome} testID="financial-due" />
              <Line label={t.financialFreeBuffer} amount={state.freeBuffer} testID="financial-buffer" />
              <Line label={t.financialFixedMonthly} amount={state.fixedMonthlyObligations} testID="financial-fixed" />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <Txt size={14}>{t.financialNextIncome}</Txt>
                <Txt size={15} weight={600} testID="financial-next-income">
                  {state.nextIncomeAt === null ? t.financialUnknown : day(state.nextIncomeAt.at)}
                </Txt>
              </View>
              {/* When the picture was true. Never implied to be "now". */}
              <Txt size={12} color={p.mu} testID="financial-as-of">
                {t.financialAsOf} {ltr(new Date(state.asOf).toISOString().slice(0, 16).replace('T', ' '))}
              </Txt>
            </View>
          )}
        </Card>

        {state !== null && state.conflicts.length > 0 ? (
          <Card pad={18} style={{ gap: 10 }} testID="financial-conflicts">
            <Txt size={15} weight={600}>{t.financialConflictsTitle}</Txt>
            {/*
              Rendered, always. The whole point of recording a conflict rather
              than resolving it quietly is that the person sees both numbers
              and is told which one is being used.
            */}
            {state.conflicts.map((conflict: FinancialConflict) => (
              <View key={conflict.field} style={{ gap: 2 }} testID={`financial-conflict-${conflict.field}`}>
                <Txt size={13}>{t.financialConflictBody}</Txt>
                <Txt size={13} color={p.mu}>
                  {t.financialFromSource}: {ltr(String(conflict.providerValue))} · {t.financialFromYou}: {ltr(String(conflict.manualValue))}
                </Txt>
                <Txt size={13} color={p.ac} testID={`financial-conflict-${conflict.field}-using`}>
                  {conflict.resolvedTo === 'manual' ? t.financialUsingYours : t.financialUsingSource}
                </Txt>
              </View>
            ))}
          </Card>
        ) : null}

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.financialCorrectTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.financialCorrectBody}</Txt>
          <TextInput
            testID="financial-correction-input"
            value={draft}
            onChangeText={setDraft}
            keyboardType="numeric"
            placeholder={t.financialCorrectPlaceholder}
            placeholderTextColor={p.mu}
            style={{
              minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln,
              paddingHorizontal: 14, color: p.tx, textAlign: 'left',
            }}
          />
          <Btn
            label={t.financialCorrectSave}
            testID="financial-correction-save"
            onPress={() => void saveCorrection()}
            disabled={saveField.isPending || draft.trim().length === 0}
            style={{
              minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
              backgroundColor: p.ac,
            }}
          >
            <Txt size={15} weight={600} color="#FFFFFF">{t.financialCorrectSave}</Txt>
          </Btn>
          {state !== null && state.cashAvailable?.provenance.origin === 'manual' ? (
            <Btn
              label={t.financialCorrectUndo}
              testID="financial-correction-undo"
              onPress={() => void clearField.mutateAsync('cash_available').catch(() => setFailed(true))}
              disabled={clearField.isPending}
              style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Txt size={14} color={p.ac}>{t.financialCorrectUndo}</Txt>
            </Btn>
          ) : null}
          {failed ? <Txt size={13} color={p.wm} testID="financial-save-failed">{t.financialSaveFailed}</Txt> : null}
        </Card>

        {state !== null && state.upcomingObligations.length > 0 ? (
          <Card pad={18} style={{ gap: 10 }} testID="financial-obligations">
            <Txt size={15} weight={600}>{t.financialUpcomingTitle}</Txt>
            {state.upcomingObligations.map((obligation: FinancialObligation) => (
              <View
                key={obligation.obligationId}
                style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}
                testID={`financial-obligation-${obligation.obligationId}`}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  {/*
                    A detected bill has no name here, and that is deliberate:
                    the source's name for it is the merchant line off the
                    transaction, which never leaves the server. Only words the
                    user typed themselves appear as a label.
                  */}
                  <Txt size={14}>{obligation.label ?? t[CATEGORY_COPY[obligation.category]]}</Txt>
                  <Txt size={12} color={p.mu}>{day(obligation.dueAt)}</Txt>
                </View>
                <Txt size={14} weight={600}>{money(obligation.amount.minorUnits, obligation.amount.currency)}</Txt>
              </View>
            ))}
          </Card>
        ) : null}

        <Txt size={12} color={p.mu} lh={1.5}>{t.financialPrivacyNote}</Txt>
      </ScrollView>
    </ScreenIn>
  );
}
