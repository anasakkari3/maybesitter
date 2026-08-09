import { cpSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

function main() {
  const baseDir = process.env.MAYBESITTER_DATA_DIR || join(process.cwd(), '.maybesitter');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(baseDir, 'backups', `pilot-backup-${timestamp}`);

  try {
    if (!existsSync(baseDir)) {
      console.log(`Base directory ${baseDir} does not exist. Nothing to backup.`);
      return;
    }

    mkdirSync(backupDir, { recursive: true });
    cpSync(baseDir, backupDir, { recursive: true, filter: (src) => !src.includes('/backups') });

    console.log(`Backup created successfully at: ${backupDir}`);
  } catch (err) {
    console.error('Backup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
