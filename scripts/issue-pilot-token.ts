import { generatePilotToken, getRequiredTokenSecret } from '../lib/pilot/pilotTokenService';
import { requirePilotParticipantId } from '../lib/pilot/closedPilotControls';

function main() {
  const participantId = process.argv[2];
  if (!participantId) {
    console.error('Usage: MAYBESITTER_PILOT_TOKEN_SECRET=<secret> npx ts-node scripts/issue-pilot-token.ts <participant_id>');
    process.exit(1);
  }

  try {
    requirePilotParticipantId(participantId);
    const secret = getRequiredTokenSecret();
    const token = generatePilotToken(participantId, secret);
    console.log(`Issued Pilot Token for [${participantId}]:`);
    console.log(token);
  } catch (err) {
    console.error('Error issuing token:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
