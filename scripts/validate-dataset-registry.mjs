#!/usr/bin/env node
/**
 * Gate command for the dataset registry.
 *
 * Validates, in order:
 *   1. data/registry/dataset-registry.json against the registry contract
 *   2. data/registry/locked-artifacts.ledger.json against the registry
 *   3. every data/registry/reports/*.report.json against the registry + ledger
 *   4. optionally, the bytes on disk, when --verify is given
 *
 * Because the Gemma artifacts live outside this repository, byte-level
 * verification needs an explicit checkout path per registered repository:
 *
 *   npm run validate:registry -- --verify maybesitter-gemma=../maybesitter-gemma-gold-calibration
 *
 * Repeat --verify for each repository. Repositories that are not supplied are
 * reported as unverified rather than silently passing.
 *
 * Exit codes: 0 clean, 1 validation errors, 2 usage/IO problem.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { validateDatasetRegistry } from '../lib/evaluation/registry/validateRegistry.ts';
import { validateLockedArtifactLedger } from '../lib/evaluation/registry/validateLockLedger.ts';
import { validateEvaluationReport } from '../lib/evaluation/registry/validateEvaluationReport.ts';
import { verifyRegistryArtifacts } from '../lib/evaluation/registry/verifyArtifacts.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(repoRoot, 'data/registry/dataset-registry.json');
const LEDGER_PATH = path.join(repoRoot, 'data/registry/locked-artifacts.ledger.json');
const REPORTS_DIR = path.join(repoRoot, 'data/registry/reports');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`${RED}cannot read ${path.relative(repoRoot, filePath)}: ${error.message}${RESET}`);
    process.exit(2);
  }
}

function parseVerifyFlags(argv) {
  const roots = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--verify') continue;
    const value = argv[index + 1];
    index += 1;
    if (!value || !value.includes('=')) {
      console.error(`${RED}--verify expects <repository>=<path>${RESET}`);
      process.exit(2);
    }
    const separator = value.indexOf('=');
    roots.set(value.slice(0, separator), path.resolve(repoRoot, value.slice(separator + 1)));
  }
  return roots;
}

function makeReader(roots) {
  return (repository, _revision, relativePath) => {
    const root = roots.get(repository);
    if (root === undefined) return null;

    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;

    const bytes = readFileSync(absolute);
    const text = bytes.toString('utf8');
    const isJsonl = relativePath.endsWith('.jsonl');

    return {
      checksum: { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') },
      recordCount: isJsonl ? (text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length) : null,
      byteSize: bytes.length,
    };
  };
}

function report(label, result) {
  for (const issue of result.issues) {
    const color = issue.severity === 'error' ? RED : YELLOW;
    console.log(`${color}${issue.severity.toUpperCase()} ${issue.code}${RESET} ${issue.path}\n    ${issue.message}`);
  }
  const errors = result.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = result.issues.length - errors;
  const status = errors === 0 ? `${GREEN}ok${RESET}` : `${RED}${errors} error(s)${RESET}`;
  console.log(`${label}: ${status}${warnings > 0 ? ` ${DIM}(${warnings} warning(s))${RESET}` : ''}`);
  return errors === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const verifyRoots = parseVerifyFlags(argv);

  const registryJson = readJson(REGISTRY_PATH);
  let ok = report('registry', validateDatasetRegistry(registryJson));
  if (!ok) {
    console.error(`${RED}registry is invalid; skipping ledger, report, and byte checks${RESET}`);
    process.exit(1);
  }

  const ledgerJson = readJson(LEDGER_PATH);
  ok = report('lock ledger', validateLockedArtifactLedger(ledgerJson, registryJson)) && ok;

  const reportFiles = existsSync(REPORTS_DIR)
    ? readdirSync(REPORTS_DIR).filter((name) => name.endsWith('.report.json')).sort()
    : [];

  for (const name of reportFiles) {
    const reportJson = readJson(path.join(REPORTS_DIR, name));
    ok =
      report(
        `report ${name}`,
        validateEvaluationReport(reportJson, { registry: registryJson, ledger: ledgerJson }),
      ) && ok;
  }
  if (reportFiles.length === 0) {
    console.log(`${DIM}no evaluation reports registered${RESET}`);
  }

  const registeredRepositories = new Set(
    registryJson.entries.flatMap((entry) => entry.artifacts.map((a) => a.location.repository)),
  );

  if (verifyRoots.size === 0) {
    console.log(
      `${YELLOW}bytes not verified.${RESET} ${DIM}Pass --verify <repository>=<path> for: ${[...registeredRepositories].join(', ')}${RESET}`,
    );
  } else {
    for (const repository of registeredRepositories) {
      if (!verifyRoots.has(repository)) {
        console.log(`${YELLOW}bytes not verified for ${repository}${RESET}`);
      }
    }
    ok =
      report(
        'artifact bytes',
        verifyRegistryArtifacts(registryJson, makeReader(verifyRoots), {
          repositories: [...verifyRoots.keys()],
        }),
      ) && ok;
  }

  process.exit(ok ? 0 : 1);
}

main();
