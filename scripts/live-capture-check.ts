/**
 * The capture proposal pipeline against the real model, on the literal UAT
 * inputs of the first phone run (closure lane CL1, 2026-09-26).
 *
 * Opt-in, and inert without it:
 *
 *   MAYBESITTER_LIVE_CAPTURE_CHECK=1 \
 *     node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/live-capture-check.ts
 *
 * It needs Application Default Credentials for the `maybesitter-app` project.
 * Every capture here is a handful of Vertex calls (one per clause, at most five
 * per capture), so a full run costs cents. It is **not** part of `npm test`:
 * the deterministic regressions for the same inputs replay recorded model
 * answers (`tests/extraction/uatCaptureRegressions.test.ts`).
 *
 * What it runs is `proposeCapture` with exactly the dependencies
 * `proposeMobileCapture` — the function `/api/mobile/capture` calls — gives it
 * for an account whose AI consent is granted: the durable proposal store, the
 * participant's own state, `guardedMobileExtract`, and `captureLlmProvider`
 * (consent gate, cost guard, metered call, log). Storage is in-memory, so
 * nothing is written anywhere real. The one addition is a wrapper around the
 * provider *function* that remembers what it returned, for `--raw`; the
 * funnel analytics `proposeMobileCapture` also writes are the only thing
 * skipped. Confirming goes through `confirmMobileCapture` itself.
 *
 * `--raw` additionally prints each clause the model was sent and the JSON it
 * answered with. That is the user's text and the model's answer, printed to
 * this terminal only: it exists to root-cause an extraction, and nothing in
 * the production path can reach it.
 */
process.env.MAYBESITTER_STORAGE_BACKEND ??= 'memory';
process.env.MAYBESITTER_LLM_PROVIDER ??= 'gemini';
process.env.MAYBESITTER_LLM_MODEL ??= 'gemini-2.5-flash';
process.env.MAYBESITTER_VERTEX_LOCATION ??= 'europe-west1';
process.env.MAYBESITTER_GCP_PROJECT ??= 'maybesitter-app';

const ENABLED = process.env.MAYBESITTER_LIVE_CAPTURE_CHECK === '1';
const RAW = process.argv.includes('--raw');

/** Saturday 26 Sep 2026, 10:00 in Jerusalem — the UAT morning. */
const REFERENCE_TIME = '2026-09-26T07:00:00.000Z';
const TIMEZONE = 'Asia/Jerusalem';

const CASES: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: 'D1/A3 six commitments',
    text: 'سجّل موعد دكتور يوم الأحد. وبدي أدفع فاتورة الكهربا قبل آخر الشهر، ولازم أرد على إيميل سامي بخصوص المشروع، وذكرني أتصل بأمي بكرا المسا، وكمان عندي تمرين بالجيم يوم الثلاثاء الساعة 7 المسا، وبدي أخلص تقرير الشغل قبل الخميس.',
  },
  { name: 'D2 buy medicine at 5', text: 'لازم أشتري دوا من الصيدلية اليوم الساعة 5 المسا' },
  { name: 'D2 deadline before Thursday', text: 'بدي أخلص تقرير الشغل قبل الخميس الساعة 5 المسا' },
  { name: 'D2 en at 5pm', text: 'buy medicine from the pharmacy today at 5pm' },
  { name: 'D2 he at 5', text: 'לקנות תרופה בבית מרקחת היום ב-17:00' },
];

async function main(): Promise<void> {
  if (!ENABLED) {
    console.log('live capture check: skipped (set MAYBESITTER_LIVE_CAPTURE_CHECK=1 to call the real model)');
    return;
  }
  const { setAiConsent } = await import('../lib/consents/aiConsentService.ts');
  const { AI_CONSENT_VERSION } = await import('../src/contracts/v1/consentContracts.ts');
  const { confirmMobileCapture } = await import('../lib/services/mobile/mobileCaptureService.ts');
  const { proposeCapture, createStorageCaptureProposalStore } = await import('../lib/services/captureBoundary/index.ts');
  const { guardedMobileExtract } = await import('../lib/services/mobile/safety.ts');
  const { captureLlmProvider } = await import('../lib/llm/captureProvider.ts');
  const { applyParticipantCommands, getParticipantStateSnapshot } = await import('../lib/services/mobile/participantState.ts');
  const { buildDailyPlanInput } = await import('../lib/services/dailyPlan/buildDailyPlan.ts');

  const store = createStorageCaptureProposalStore();
  const taps: Array<{ clause: string; text: string }> = [];

  for (let index = 0; index < CASES.length; index += 1) {
    const testCase = CASES[index]!;
    const uid = `live-capture-check-${index}`;
    await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
    taps.length = 0;
    const metered = captureLlmProvider(uid);
    const proposal = await proposeCapture(testCase.text, {
      now: new Date(REFERENCE_TIME),
      timezone: TIMEZONE,
      scopeId: uid,
      requestedEngine: 'model',
    }, {
      store,
      persistence: {
        persistAtomically: async (commands) => applyParticipantCommands(uid, commands),
        snapshot: () => getParticipantStateSnapshot(uid),
      },
      extractor: guardedMobileExtract,
      llmEngine: 'gemini',
      llmProvider: async (prompt: string) => {
        const text = await metered(prompt);
        const lines = prompt.split('\n');
        taps.push({ clause: lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1] ?? '', text });
        return text;
      },
    });
    console.log(`\n=== ${testCase.name}`);
    console.log(`input: ${testCase.text}`);
    console.log(`status=${proposal.status} engine=${proposal.provenance.executedEngine} fallbackUsed=${proposal.provenance.fallbackUsed} modelCalls=${taps.length} items=${proposal.items.length}`);
    for (const item of proposal.items) {
      console.log(`  - ${JSON.stringify({ title: item.title, resolvedTime: item.resolvedTime, resolvedDate: item.resolvedDate, dateEstimated: item.dateEstimated, priority: item.priority, priorityEstimated: item.priorityEstimated, needsClarification: item.needsClarification, ...(item.clarification ? { ask: item.clarification.questionKey, askDate: item.clarification.params?.date } : {}) })}`);
    }
    if (RAW) {
      for (const tap of taps) {
        console.log(`  [raw] sent: ${tap.clause}`);
        console.log(`  [raw] got:  ${tap.text.replace(/\s+/g, ' ')}`);
      }
    }

    // What the planner makes of every confirmed timed item: kind, and whether
    // it is pinned where the user said or floated ahead of it as a deadline.
    const timed = proposal.items.filter((item) => item.resolvedTime && !item.needsClarification);
    if (timed.length > 0) {
      await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: timed.map((item) => item.itemId) }, { participantId: uid });
      const state = await getParticipantStateSnapshot(uid);
      for (const commitment of Object.values(state.commitments)) {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(commitment.timeSpec.dueAt ?? REFERENCE_TIME));
        const input = buildDailyPlanInput({
          uid,
          date,
          timezone: TIMEZONE,
          commitments: [commitment],
          profile: null,
          busyBlocks: [],
          builtAt: REFERENCE_TIME,
        });
        const pinned = input.constraints.fixedEvents.map((event) => event.interval);
        const floating = input.constraints.items.map((item) => ({ deadlineAt: item.deadlineAt }));
        console.log(`  planner: kind=${commitment.timeSpec.kind} dueAt=${commitment.timeSpec.dueAt} pinned=${JSON.stringify(pinned)} floating=${JSON.stringify(floating)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('live capture check failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
