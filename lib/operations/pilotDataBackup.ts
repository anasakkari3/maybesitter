import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MANIFEST_NAME = 'pilot-backup-manifest.json';
const DATA_DIR_NAME = 'data';

export interface BackupPilotDataOptions {
  sourceDir: string;
  backupRoot: string;
  label?: string;
  now?: Date;
}

export interface BackupPilotDataResult {
  backupPath: string;
  dataPath: string;
  manifestPath: string;
}

export interface RestorePilotDataOptions {
  backupPath: string;
  targetDir: string;
  replaceExisting?: boolean;
}

export interface RestorePilotDataResult {
  restoredTo: string;
  sourceBackup: string;
}

function assertAbsoluteDirectoryInput(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (!path.isAbsolute(trimmed)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(trimmed);
}

function assertExistingDirectory(value: string, label: string): string {
  const resolved = assertAbsoluteDirectoryInput(value, label);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function isNestedPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertNotSameOrNested({
  candidate,
  parent,
  candidateLabel,
  parentLabel,
}: {
  candidate: string;
  parent: string;
  candidateLabel: string;
  parentLabel: string;
}): void {
  if (candidate === parent) throw new Error(`${candidateLabel} must not equal ${parentLabel}`);
  if (isNestedPath(candidate, parent)) {
    throw new Error(`${candidateLabel} must not be nested inside ${parentLabel}`);
  }
}

function timestampLabel(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function backupLabel(options: BackupPilotDataOptions): string {
  const raw = options.label?.trim() || timestampLabel(options.now ?? new Date());
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    throw new Error('backup label may contain only letters, numbers, dots, underscores, and hyphens');
  }
  return raw.startsWith('pilot-backup-') ? raw : `pilot-backup-${raw}`;
}

function assertPilotDataLooksRestorable(dataPath: string): void {
  const participantsPath = path.join(dataPath, 'participants');
  const trustPath = path.join(dataPath, 'pilot-trust.json');
  if (!existsSync(participantsPath) && !existsSync(trustPath)) {
    throw new Error('backup is incomplete: expected participants/ or pilot-trust.json');
  }
  if (existsSync(participantsPath) && !statSync(participantsPath).isDirectory()) {
    throw new Error('backup is corrupt: participants is not a directory');
  }
  if (existsSync(trustPath) && !statSync(trustPath).isFile()) {
    throw new Error('backup is corrupt: pilot-trust.json is not a file');
  }
}

function assertTargetWritable(targetDir: string, replaceExisting: boolean): void {
  if (!existsSync(targetDir)) return;
  if (!statSync(targetDir).isDirectory()) throw new Error(`restore target is not a directory: ${targetDir}`);
  const entries = readdirSync(targetDir).filter((entry) => entry !== '.DS_Store');
  if (entries.length > 0 && !replaceExisting) {
    throw new Error('restore target is not empty; pass --replace-existing to overwrite it');
  }
}

export function backupPilotData(options: BackupPilotDataOptions): BackupPilotDataResult {
  const sourceDir = assertExistingDirectory(options.sourceDir, 'MAYBESITTER_DATA_DIR');
  const backupRoot = assertAbsoluteDirectoryInput(options.backupRoot, 'backup root');
  assertNotSameOrNested({
    candidate: backupRoot,
    parent: sourceDir,
    candidateLabel: 'backup root',
    parentLabel: 'MAYBESITTER_DATA_DIR',
  });

  const backupPath = path.join(backupRoot, backupLabel(options));
  assertNotSameOrNested({
    candidate: backupPath,
    parent: sourceDir,
    candidateLabel: 'backup path',
    parentLabel: 'MAYBESITTER_DATA_DIR',
  });
  if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);

  const dataPath = path.join(backupPath, DATA_DIR_NAME);
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(backupPath, { recursive: false });
  try {
    cpSync(sourceDir, dataPath, { recursive: true });
    const manifestPath = path.join(backupPath, MANIFEST_NAME);
    writeFileSync(manifestPath, `${JSON.stringify({
      version: 'v1',
      createdAt: (options.now ?? new Date()).toISOString(),
      sourceDir,
      dataDirName: DATA_DIR_NAME,
      includesEnvironmentSecrets: false,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { backupPath, dataPath, manifestPath };
  } catch (error) {
    rmSync(backupPath, { recursive: true, force: true });
    throw error;
  }
}

export function restorePilotData(options: RestorePilotDataOptions): RestorePilotDataResult {
  const backupPath = assertExistingDirectory(options.backupPath, 'backup source');
  const targetDir = assertAbsoluteDirectoryInput(options.targetDir, 'MAYBESITTER_DATA_DIR');
  const dataPath = path.join(backupPath, DATA_DIR_NAME);
  const manifestPath = path.join(backupPath, MANIFEST_NAME);

  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error('backup is incomplete: missing pilot-backup-manifest.json');
  }
  const sourceData = assertExistingDirectory(dataPath, 'backup data');
  assertPilotDataLooksRestorable(sourceData);

  assertNotSameOrNested({
    candidate: targetDir,
    parent: backupPath,
    candidateLabel: 'restore target',
    parentLabel: 'backup source',
  });
  assertNotSameOrNested({
    candidate: backupPath,
    parent: targetDir,
    candidateLabel: 'backup source',
    parentLabel: 'restore target',
  });
  assertTargetWritable(targetDir, Boolean(options.replaceExisting));

  if (existsSync(targetDir) && options.replaceExisting) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceData, targetDir, { recursive: true });
  return { restoredTo: targetDir, sourceBackup: backupPath };
}

