import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { getPilotTrustStore } from '../lib/pilot/pilotTrustStore';
import { requirePilotParticipantId } from '../lib/pilot/closedPilotControls';

function main() {
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

    const baseDir = process.env.MAYBESITTER_DATA_DIR || join(process.cwd(), '.maybesitter');
    const participantFile = join(baseDir, 'participants', `${participantId}-state.json`);

    if (existsSync(participantFile)) {
      rmSync(participantFile, { force: true });
      console.log(`Deleted state file for [${participantId}] at ${participantFile}`);
    } else {
      console.log(`No active state file found for [${participantId}] at ${participantFile}`);
    }

    console.log(`Successfully deleted participant [${participantId}] data.`);
  } catch (err) {
    console.error('Error deleting participant data:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
