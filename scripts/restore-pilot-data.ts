import { restorePilotData } from '../lib/operations/pilotDataBackup';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function main() {
  try {
    const result = restorePilotData({
      backupPath: valueAfter('--backup') || process.env.MAYBESITTER_PILOT_BACKUP_PATH || '',
      targetDir: process.env.MAYBESITTER_DATA_DIR || '',
      replaceExisting: hasFlag('--replace-existing'),
    });
    console.log(`Pilot data restored successfully to: ${result.restoredTo}`);
  } catch (err) {
    console.error('Restore failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
