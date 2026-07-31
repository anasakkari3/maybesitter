#!/usr/bin/env node
/**
 * Converts a legacy `expanded-structured-evaluator-v4` report into the governed
 * EvaluationReport contract (lib/evaluation/registry/contracts.ts).
 *
 * Legacy reports carry a `reproducibility` block with the dataset, model,
 * adapter, prompt, and schema-snapshot checksums. This script re-expresses that
 * block as explicit model/data/config fingerprints, and resolves the dataset and
 * schema-snapshot paths to registered artifact ids by matching the registry on
 * path and checksum, so a migrated report is bound to governed artifacts rather
 * than to loose file paths.
 *
 * Usage:
 *   node scripts/migrate-evaluation-report.mjs <legacy-report.json> \
 *     --report-id <id> [--created-at <iso>] [--out <path>]
 *
 * Exits non-zero if the migrated report does not validate against the registry.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const METRIC_KEYS = [
  'cases',
  'initialJsonSyntaxValidityPercent',
  'initialProductionSchemaValidityPercent',
  'jsonSyntaxValidityPercent',
  'productionSchemaValidityPercent',
  'jsonSchemaValidityPercent',
  'exactFullObjectMatchPercent',
  'exactExpectedFieldsPercent',
  'intentAccuracyPercent',
  'intentMacroF1Percent',
  'slotPrecisionPercent',
  'slotRecallPercent',
  'slotF1Percent',
  'dateTimeExactPercent',
  'nullFieldAccuracyPercent',
  'clarificationAccuracyPercent',
  'falseActionCreationRatePercent',
  'injectionPassRatePercent',
  'medianLatencyMs',
  'p95LatencyMs',
  'peakMemoryGB',
  'repairRatePercent',
  'repairSuccessRatePercent',
  'fallbackRatePercent',
  'failureCount',
];

const SLICE_KEYS = {
  languageExactPercent: 'languageExactPercent',
  languageDateTimeExactPercent: 'languageDateTimeExactPercent',
};

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(value) {
  return { algorithm: 'sha256', value: createHash('sha256').update(value).digest('hex') };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      flags[token.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function findArtifactByPath(registry, artifactPath, expectedChecksum) {
  for (const entry of registry.entries) {
    for (const artifact of entry.artifacts) {
      if (artifact.location.path !== artifactPath) continue;
      if (expectedChecksum && artifact.checksum.value !== expectedChecksum) continue;
      return { entry, artifact };
    }
  }
  return null;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const legacyPath = positional[0];

  if (!legacyPath) {
    console.error('usage: migrate-evaluation-report.mjs <legacy-report.json> --report-id <id> [--out <path>]');
    process.exit(2);
  }
  if (!flags['report-id']) {
    console.error('--report-id is required; it names the run in the governed report');
    process.exit(2);
  }

  const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
  const repro = legacy.reproducibility;
  if (!repro) {
    console.error(`${legacyPath} has no reproducibility block; nothing to fingerprint`);
    process.exit(2);
  }

  const registry = JSON.parse(
    readFileSync(path.join(repoRoot, 'data/registry/dataset-registry.json'), 'utf8'),
  );

  const dataset = findArtifactByPath(registry, repro.dataset, repro.datasetSha256);
  if (!dataset) {
    console.error(
      `evaluated dataset ${repro.dataset} (${repro.datasetSha256}) is not registered; register it before migrating the report`,
    );
    process.exit(1);
  }

  let contractSnapshot = null;
  if (repro.schemaSnapshot) {
    const snapshot = findArtifactByPath(registry, repro.schemaSnapshot, repro.schemaSnapshotSha256);
    if (!snapshot) {
      console.error(`schema snapshot ${repro.schemaSnapshot} is not registered`);
      process.exit(1);
    }
    contractSnapshot = {
      artifactId: snapshot.artifact.id,
      checksum: { algorithm: 'sha256', value: repro.schemaSnapshotSha256 },
    };
  }

  const configInput = {
    evaluatorVersion: repro.version,
    seed: repro.seed,
    maxTokens: repro.maxTokens,
    repairEnabled: repro.repairEnabled,
    limit: repro.limit ?? null,
    decoding: {},
  };

  const metrics = {};
  for (const key of METRIC_KEYS) {
    if (key in legacy) metrics[key] = legacy[key] ?? null;
  }

  const slices = {};
  for (const [legacyKey, sliceName] of Object.entries(SLICE_KEYS)) {
    const slice = legacy[legacyKey];
    if (slice && Object.keys(slice).length > 0) {
      slices[sliceName] = Object.fromEntries(
        Object.entries(slice).map(([name, value]) => [name, value ?? null]),
      );
    }
  }

  const report = {
    contractVersion: '1.0.0',
    reportId: flags['report-id'],
    createdAt: flags['created-at'] ?? new Date().toISOString(),
    dataset: {
      datasetId: dataset.entry.id,
      datasetVersion: dataset.entry.version,
      artifactId: dataset.artifact.id,
      checksum: { algorithm: 'sha256', value: repro.datasetSha256 },
    },
    model: {
      id: repro.model,
      runtime: repro.model.includes('/mlx/') ? 'mlx' : 'unknown',
      checksum: { algorithm: 'sha256', value: repro.modelConfigSha256 },
      adapter: repro.adapter
        ? { id: repro.adapter, checksum: { algorithm: 'sha256', value: repro.adapterSha256 } }
        : null,
      promptChecksum: { algorithm: 'sha256', value: repro.promptSha256 },
    },
    config: {
      checksum: checksum(canonicalJson(configInput)),
      seed: repro.seed,
      maxTokens: repro.maxTokens,
      decoding: configInput.decoding,
      repairEnabled: repro.repairEnabled,
      limit: repro.limit ?? null,
    },
    contractSnapshot,
    metrics,
    ...(Object.keys(slices).length > 0 ? { slices } : {}),
    notes: `Migrated from the legacy ${repro.version} report at ${path.basename(legacyPath)}. Decoding parameters were not recorded by the legacy evaluator, so they are empty rather than guessed. Per-case output stays in ${legacy.caseResults ?? 'the legacy report'}.`,
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (flags.out) {
    const outPath = path.resolve(repoRoot, flags.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized, 'utf8');
    console.log(`wrote ${path.relative(repoRoot, outPath)}`);
  } else {
    process.stdout.write(serialized);
  }
}

main();
