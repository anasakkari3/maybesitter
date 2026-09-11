import { applyTrustAction } from '../lib/pilot/pilotTrustStore';
import { requirePilotParticipantId } from '../lib/pilot/closedPilotControls';

async function main() {
  const participantId = process.argv[2];
  if (!participantId) {
    console.error('Usage: npx ts-node scripts/revoke-participant.ts <participant_id>');
    process.exit(1);
  }

  try {
    requirePilotParticipantId(participantId);
    const now = new Date().toISOString();
    const state = await applyTrustAction(participantId, { type: 'revoke', at: now });
    console.log(`Revoked participant [${participantId}] at ${now}`);
    console.log('Updated Trust State:', state);
  } catch (err) {
    console.error('Error revoking participant:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
