import { backupPilotData } from '../lib/operations/pilotDataBackup';

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  try {
    const result = backupPilotData({
      sourceDir: process.env.MAYBESITTER_DATA_DIR || '',
      backupRoot: valueAfter('--backup-root') || process.env.MAYBESITTER_PILOT_BACKUP_DIR || '',
      label: valueAfter('--label'),
    });
    console.log(`Backup created successfully at: ${result.backupPath}`);
  } catch (err) {
    console.error('Backup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
