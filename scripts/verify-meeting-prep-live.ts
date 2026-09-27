/**
 * «حضّرني» against the real model (closure lane CL5a). Opt-in, paid, local.
 *
 *   MAYBESITTER_LIVE_MEETING_PREP=1 MAYBESITTER_LLM_PROVIDER=gemini \
 *   MAYBESITTER_GCP_PROJECT=maybesitter-app MAYBESITTER_VERTEX_LOCATION=europe-west1 \
 *   MAYBESITTER_LLM_MODEL=gemini-2.5-flash \
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/verify-meeting-prep-live.ts ["<notes>"]
 *
 * Application Default Credentials, in-memory storage, one throwaway uid. The
 * real service runs with the real gated, metered provider; the only thing this
 * adds is a call budget (`MAYBESITTER_LIVE_MEETING_PREP_MAX_CALLS`, default 3)
 * — past it the wrapper throws and the service falls back to rules like it
 * would for any provider error. Then the proposal is confirmed through the
 * capture confirm and the commitments and reminder it created are printed,
 * and the same notes are run again with consent off (no model call).
 *
 * Prints the model's raw answer: this is a developer's terminal, not a log.
 */
import { createMemoryStorage } from '../lib/storage/memoryAdapter';
import { setStorageForTests } from '../lib/storage';
import { setAiConsent } from '../lib/consents/aiConsentService';
import { AI_CONSENT_VERSION } from '../src/contracts/v1/consentContracts';
import { shareLlmProvider, type ShareStructuredGenerator } from '../lib/llm/shareProvider';
import { prepareMeeting } from '../lib/services/mobile/meetingPrepService';
import { confirmMobileCapture } from '../lib/services/mobile/mobileCaptureService';
import { getParticipantStateSnapshot } from '../lib/services/mobile/participantState';

const DEFAULT_NOTES = [
  'اجتماع بكرا مع مدير القسم عن ميزانية الربع الجاي، وبدو يشوف ليش المصاريف زادت.',
  'بدي أراجع جدول المصاريف تبع آخر ٣ شهور وأطبع التقرير قبل ما أفوت.',
  'بعد الاجتماع لازم أبعت الملخص لسامي يوم الأحد الصبح.',
].join('\n');

async function main(): Promise<void> {
  if (process.env.MAYBESITTER_LIVE_MEETING_PREP !== '1') {
    console.log('Set MAYBESITTER_LIVE_MEETING_PREP=1 to run this against the real model. It costs money.');
    return;
  }
  const notes = process.argv[2] ?? DEFAULT_NOTES;
  const budget = Number(process.env.MAYBESITTER_LIVE_MEETING_PREP_MAX_CALLS ?? '3');
  setStorageForTests(createMemoryStorage());
  const uid = `livePrep${Date.now()}`;
  await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });

  let calls = 0;
  const real = shareLlmProvider(uid, { purpose: 'meeting_prep' });
  const generate: ShareStructuredGenerator = async (request) => {
    calls += 1;
    if (calls > budget) throw new Error(`live budget of ${budget} calls spent`);
    const response = await real(request);
    console.log(`[vertex] model=${response.model} latencyMs=${response.latencyMs} tokens=${response.promptTokens}/${response.outputTokens}`);
    console.log(`[vertex] raw=${response.text}`);
    return response;
  };

  // Tomorrow 10:00 in Jerusalem, a 45-minute meeting.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  const startAt = new Date(`${day}T07:00:00.000Z`).toISOString(); // 10:00 IDT (UTC+3)
  const endAt = new Date(Date.parse(startAt) + 45 * 60_000).toISOString();

  console.log(`notes:\n${notes}\n\nblock: ${startAt} → ${endAt} (Asia/Jerusalem)\n`);
  const { proposal, prep } = await prepareMeeting(uid, { notes, startAt, endAt, timezone: 'Asia/Jerusalem' }, { now, generate });
  console.log(`── proposal ${proposal.status} provenance=${JSON.stringify(proposal.provenance)}`);
  for (const item of proposal.items) {
    console.log(`  • ${item.title}   [${item.resolvedTime ?? 'no time'}]${item.itemId === prep.itemId ? '  ← prep step' : ''}`);
  }
  console.log(`── prep: remindAt=${prep.remindAt} dueAt=${prep.dueAt} leadMinutes=${prep.leadMinutes} adjustment=${prep.adjustment}`);

  const confirmed = await confirmMobileCapture(
    { proposalId: proposal.proposalId, itemIds: proposal.items.map((item) => item.itemId) },
    { participantId: uid },
  );
  console.log(`── confirm: success=${confirmed.success} persisted=${confirmed.persisted.length}`);
  const state = await getParticipantStateSnapshot(uid);
  for (const commitment of Object.values(state.commitments)) {
    const reminders = Object.values(state.reminders).filter((reminder) => reminder.commitmentId === commitment.id);
    console.log(`  ✓ ${commitment.status} ${commitment.title} dueAt=${commitment.timeSpec.dueAt ?? '-'} allDay=${commitment.timeSpec.allDay} reminders=${reminders.map((r) => r.scheduledFor).join(',') || '-'}`);
  }

  const rulesUid = `${uid}Rules`;
  const rules = await prepareMeeting(rulesUid, { notes, startAt, endAt, timezone: 'Asia/Jerusalem' }, { now, generate });
  console.log(`\n── consent off: provenance=${JSON.stringify(rules.proposal.provenance)}`);
  for (const item of rules.proposal.items) console.log(`  • ${item.title}   [${item.resolvedTime ?? 'no time'}]`);
  console.log(`\nlive Vertex calls: ${calls}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
