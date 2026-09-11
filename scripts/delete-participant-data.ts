import { applyTrustAction } from '../lib/pilot/pilotTrustStore';
import { requirePilotParticipantId } from '../lib/pilot/closedPilotControls';
import { deleteParticipantDomainState } from '../lib/services/mobile/participantState';
import { userDoc } from '../lib/storage';

async function main() {
  const participantId = process.argv[2];
  if (!participantId) {
    console.error('Usage: npx ts-node scripts/delete-participant-data.ts <participant_id>');
    process.exit(1);
  }

  try {
    requirePilotParticipantId(participantId);
    const now = new Date().toISOString();
    await applyTrustAction(participantId, { type: 'delete', at: now });

    // The trust record itself stays, marked deleted: it is what makes a later
    // request read `deleted` rather than looking like a participant nobody has
    // ever seen.
    await deleteParticipantDomainState(participantId);
    console.log(`Deleted participant-scoped domain and idempotency state for [${participantId}] under ${userDoc(participantId)}`);

    console.log(`Successfully deleted participant [${participantId}] data.`);
  } catch (err) {
    console.error('Error deleting participant data:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
