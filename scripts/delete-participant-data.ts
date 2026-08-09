import { getPilotTrustStore } from '../lib/pilot/pilotTrustStore';
import { requirePilotParticipantId } from '../lib/pilot/closedPilotControls';
import { deleteParticipantDomainState, participantStateFile } from '../lib/services/mobile/participantState';

async function main() {
  const participantId = process.argv[2];
  if (!participantId) {
    console.error('Usage: npx ts-node scripts/delete-participant-data.ts <participant_id>');
    process.exit(1);
  }

  try {
    requirePilotParticipantId(participantId);
    const store = getPilotTrustStore();
    const now = new Date().toISOString();
    store.apply(participantId, { type: 'delete', at: now });

    const participantFile = participantStateFile(participantId);
    await deleteParticipantDomainState(participantId);
    console.log(`Deleted participant-scoped domain and idempotency state for [${participantId}] at ${participantFile}`);

    console.log(`Successfully deleted participant [${participantId}] data.`);
  } catch (err) {
    console.error('Error deleting participant data:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
