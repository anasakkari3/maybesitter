import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import {
  useClearFinancialField,
  useConnectFinancialSource,
  useDisconnectFinancialSource,
  useFinancialConnection,
  useFinancialContext,
  useRemoveFinancialObligation,
  useSaveFinancialObligation,
  useSaveFinancialField,
} from '../../api/queries';
import { CurrencyRequiredError } from '../../api/errors';
import type {
  FinancialConflict,
  FinancialObligation,
  FinancialProvenance,
  FinancialState,
} from '../../api/schemas/financial';
import { fill, ltr } from '../../i18n/strings';
import { formatRelativeDay, formatTime } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import type { Locale } from '../../i18n/locale';
import { Btn, Card, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { Screen, ScreenScroll } from '../../ui/screen';
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
 * The currencies offered when the account has none (live P2, 2026-09-29).
 *
 * The ones this cohort is paid in, in that order. None is preselected: a
 * currency picked for the person is a number filed in the wrong money, and no
 * later sync would say so. Anything else can still arrive with a bill, whose
 * form takes any three-letter code.
 */
const CURRENCY_COPY = {
  ILS: 'financialCurrencyILS',
  JOD: 'financialCurrencyJOD',
  USD: 'financialCurrencyUSD',
  EUR: 'financialCurrencyEUR',
} as const;
type OfferedCurrency = keyof typeof CURRENCY_COPY;
const OFFERED_CURRENCIES = Object.keys(CURRENCY_COPY) as OfferedCurrency[];

/** One currency in the single-choice row: said by name, with its code beside it. */
function CurrencyChoice({ code, selected, onPress }: { code: OfferedCurrency; selected: boolean; onPress: () => void }) {
  const { t, p } = useApp();
  const name = t[CURRENCY_COPY[code]];
  return (
    <Btn
      testID={`financial-currency-${code}`}
      label={`${name} (${code})`}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      scaleTo={0.97}
      style={{
        minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
        borderWidth: 1, borderColor: selected ? p.ink : p.ln, backgroundColor: selected ? p.ink : p.sf,
      }}
    >
      <Txt size={14} weight={selected ? 600 : 400} color={selected ? p.onInk : p.tx}>{name}</Txt>
      <Txt size={12} latin color={selected ? p.onInk : p.mu}>{code}</Txt>
    </Btn>
  );
}

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

/**
 * When the picture was true: the phone's own day and clock, the way every
 * other instant in the app reads («آخر تحديث: اليوم · 10:22»), never a UTC
 * stamp — the first UAT read «بتاريخ 2026-09-28 07:22» at 10:22 local (N20).
 */
function asOfText(instant: string, locale: Locale, timeZone: string): string {
  const at = new Date(instant);
  return `${formatRelativeDay(at, { locale, timeZone })} · ${ltr(formatTime(at, { locale, timeZone }))}`;
}

/** A bill's or an income's day: a civil date the form sends at noon UTC, so read in UTC. */
function day(instant: string): string {
  return ltr(new Date(instant).toISOString().slice(0, 10));
}

/** Where a value came from, said in words beside the value itself. */
function Origin({ provenance, testID }: { provenance: FinancialProvenance; testID: string }) {
  const { t, p } = useApp();
  return (
    <Txt size={12} color={p.mu} testID={testID}>
      {provenance.origin === 'computed'
        ? `${t[ORIGIN_COPY.computed]} · ${provenance.contributingSources.map(source => t[ORIGIN_COPY[source]]).join(' + ')}`
        : t[ORIGIN_COPY[provenance.origin]]}
    </Txt>
  );
}

/*
 * Module-level, not declared inside the screen: a component created during
 * render is a new type on every render, so React unmounts and remounts its
 * subtree each time the screen re-renders (the `react-hooks` lint rule, and
 * the reason). Neither of these holds state, so nothing was lost — but the
 * remount was real, and the rule is not one to carry a warning for.
 */
function Line({ label, amount, testID }: {
  label: string;
  amount: { minorUnits: number; currency: string; provenance: FinancialProvenance } | null;
  testID: string;
}) {
  const { t } = useApp();
  return (
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
}

export function FinancialContextScreen({ onBack }: { onBack: () => void }) {
  const { t, p, rtl, lang } = useApp();
  const timeZone = useTimeZone();
  // A TextInput is not mirrored by the root's `direction` the way a Text is:
  // it takes the physical edge (first iPhone run, L7).
  const inputAlign = { textAlign: rtl ? 'right' as const : 'left' as const, writingDirection: rtl ? 'rtl' as const : 'ltr' as const };
  const context = useFinancialContext();
  const connection = useFinancialConnection();
  const connect = useConnectFinancialSource();
  const disconnect = useDisconnectFinancialSource();
  const saveField = useSaveFinancialField();
  const saveObligation = useSaveFinancialObligation();
  const removeObligation = useRemoveFinancialObligation();
  const clearField = useClearFinancialField();
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);
  /**
   * A figure was refused for want of a currency — by the server, or here
   * before sending. Sticky until a figure saves: picking a currency must not
   * take the picker away while the account still has none on record.
   */
  const [currencyAsked, setCurrencyAsked] = useState(false);
  const [pickedCurrency, setPickedCurrency] = useState<OfferedCurrency | null>(null);
  const [billLabel, setBillLabel] = useState('');
  const [billAmount, setBillAmount] = useState('');
  /** `null` until the person types one: the field then shows the account's own currency, or nothing. */
  const [billCurrencyTyped, setBillCurrencyTyped] = useState<string | null>(null);
  const [billDate, setBillDate] = useState('');

  const state: FinancialState | null = context.data?.state ?? null;
  const connected = connection.data?.connected === true;
  // A bill used to start in USD, and a bill's currency becomes the account's
  // when it has none — so saving one quietly decided the person's money.
  const billCurrency = billCurrencyTyped ?? state?.currency ?? '';
  // Asked before the figure, not after a refusal (live P2, 2026-09-29): an
  // amount with no currency behind it is refused 409 `currency_required`.
  const needsCurrency = (state !== null && state.currency === null) || currencyAsked;

  const saveCorrection = async () => {
    setFailed(false);
    if (needsCurrency && pickedCurrency === null) { setCurrencyAsked(true); return; }
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
      // The currency first, as its own statement: the figure is refused
      // without one, and the person picked it here for exactly this.
      if (needsCurrency && pickedCurrency !== null) {
        await saveField.mutateAsync({ field: 'currency', kind: 'statement', value: pickedCurrency });
      }
      // A correction, not a statement: the user is overruling a reading the
      // source produced, and that is the thing no later sync undoes.
      await saveField.mutateAsync({
        field: 'cash_available',
        kind: 'correction',
        value: Math.round(major * 100),
      });
      setDraft('');
      setCurrencyAsked(false);
    } catch (error) {
      if (error instanceof CurrencyRequiredError) setCurrencyAsked(true);
      else setFailed(true);
    }
  };

  const saveBill = async () => {
    setFailed(false);
    const amount = billAmount.trim();
    const currency = billCurrency.trim().toUpperCase();
    const due = billDate.trim();
    if (!billLabel.trim() || !/^\d+(\.\d{1,2})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      setFailed(true);
      return;
    }
    const dueAt = new Date(`${due}T12:00:00.000Z`);
    if (Number.isNaN(dueAt.getTime()) || dueAt.toISOString().slice(0, 10) !== due) {
      setFailed(true);
      return;
    }
    try {
      await saveObligation.mutateAsync({
        label: billLabel.trim(),
        category: 'other',
        dueAt: dueAt.toISOString(),
        amountMinorUnits: Math.round(Number(amount) * 100),
        currency,
        recurring: false,
      });
      setBillLabel('');
      setBillAmount('');
      setBillCurrencyTyped(null);
      setBillDate('');
    } catch {
      setFailed(true);
    }
  };

  return (
    <Screen pinned={<SettingsHeader title={t.financialTitle} onBack={onBack} />}>
      <ScreenScroll bottom={80}>

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

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={15} weight={600}>{t.financialAddBillTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.financialAddBillBody}</Txt>
          <TextInput testID="financial-bill-label" value={billLabel} onChangeText={setBillLabel} placeholder={t.financialAddBillLabel} placeholderTextColor={p.mu}
            style={{ minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln, paddingHorizontal: 14, color: p.tx, ...inputAlign }} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput testID="financial-bill-amount" value={billAmount} onChangeText={setBillAmount} keyboardType="decimal-pad" placeholder={t.financialAddBillAmount} placeholderTextColor={p.mu}
              style={{ flex: 1, minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln, paddingHorizontal: 14, color: p.tx, ...inputAlign }} />
            <TextInput testID="financial-bill-currency" value={billCurrency} onChangeText={setBillCurrencyTyped} autoCapitalize="characters" maxLength={3} placeholder="USD" placeholderTextColor={p.mu}
              style={{ width: 82, minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln, paddingHorizontal: 14, color: p.tx, ...inputAlign }} />
          </View>
          <TextInput testID="financial-bill-date" value={billDate} onChangeText={setBillDate} keyboardType="numbers-and-punctuation" placeholder={t.financialAddBillDate} placeholderTextColor={p.mu}
            style={{ minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln, paddingHorizontal: 14, color: p.tx, ...inputAlign }} />
          <Btn label={t.financialAddBillSave} testID="financial-bill-save" onPress={() => void saveBill()}
            disabled={saveObligation.isPending || !billLabel.trim() || !billAmount.trim() || !billCurrency.trim() || !billDate.trim()}
            style={{ minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.ac }}>
            <Txt size={15} weight={600} color="#FFFFFF">{t.financialAddBillSave}</Txt>
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
                {fill(t.financialAsOf, { when: asOfText(state.asOf, lang, timeZone) })}
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
          {needsCurrency ? (
            <View style={{ gap: 8 }} testID="financial-currency-picker">
              <Txt size={14} weight={600}>{t.financialCurrencyTitle}</Txt>
              <Txt size={13} color={p.mu} lh={1.5}>{t.financialCurrencyBody}</Txt>
              <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {OFFERED_CURRENCIES.map(code => (
                  <CurrencyChoice
                    key={code}
                    code={code}
                    selected={pickedCurrency === code}
                    onPress={() => setPickedCurrency(code)}
                  />
                ))}
              </View>
            </View>
          ) : null}
          <TextInput
            testID="financial-correction-input"
            value={draft}
            onChangeText={setDraft}
            keyboardType="numeric"
            placeholder={t.financialCorrectPlaceholder}
            placeholderTextColor={p.mu}
            style={{
              minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: p.ln,
              paddingHorizontal: 14, color: p.tx, ...inputAlign,
            }}
          />
          <Btn
            label={t.financialCorrectSave}
            testID="financial-correction-save"
            onPress={() => void saveCorrection()}
            disabled={saveField.isPending || draft.trim().length === 0 || (needsCurrency && pickedCurrency === null)}
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
          <LiveRegion>
            {currencyAsked && pickedCurrency === null
              ? <Txt size={13} color={p.wm} weight={600} lh={1.5} testID="financial-currency-required">{t.financialCurrencyRequired}</Txt>
              : null}
          </LiveRegion>
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
                {obligation.amount.provenance.origin === 'manual' ? <Btn label={t.financialRemoveBill} testID={`financial-obligation-remove-${obligation.obligationId}`}
                  disabled={removeObligation.isPending} onPress={() => void removeObligation.mutateAsync(obligation.obligationId).catch(() => setFailed(true))}
                  style={{ minHeight: 44, justifyContent: 'center' }}><Txt size={13} color={p.wm}>{t.financialRemoveBill}</Txt></Btn> : null}
              </View>
            ))}
          </Card>
        ) : null}

        <Txt size={12} color={p.mu} lh={1.5}>{t.financialPrivacyNote}</Txt>
      </ScreenScroll>
    </Screen>
  );
}
