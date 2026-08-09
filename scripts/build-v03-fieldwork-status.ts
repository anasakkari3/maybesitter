/**
 * Reads the two #54 field trackers, validates every cell, and reports fieldwork status.
 *
 * With --emit-interviews / --emit-recruitment it also writes the privacy-safe coded JSONL that
 * `npm run research:v03-report` consumes, so the coded evidence is always derived from the
 * trackers rather than hand-written.
 *
 *   npm run research:v03-intake -- \
 *     --interviews <interview-evidence-tracker.csv> \
 *     --recruitment <recruitment-tracker.csv> \
 *     --status evaluation-reports/v03-fieldwork-status.json \
 *     --emit-interviews <coded-interviews.jsonl> \
 *     --emit-recruitment <coded-recruitment.jsonl>
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildFieldworkStatus,
  exportableRecruitmentRows,
  parseInterviewTracker,
  parseRecruitmentTracker,
  sampleRows,
  toInterviewRecord,
  toRecruitmentRecord,
  type TrackerIssue,
} from '../lib/research/v03FieldIntake';

const args = process.argv.slice(2);
let interviewsPath = '';
let recruitmentPath = '';
let statusPath = 'evaluation-reports/v03-fieldwork-status.json';
let emitInterviewsPath = '';
let emitRecruitmentPath = '';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--interviews' && args[index + 1]) interviewsPath = args[++index];
  else if (args[index] === '--recruitment' && args[index + 1]) recruitmentPath = args[++index];
  else if (args[index] === '--status' && args[index + 1]) statusPath = args[++index];
  else if (args[index] === '--emit-interviews' && args[index + 1]) emitInterviewsPath = args[++index];
  else if (args[index] === '--emit-recruitment' && args[index + 1]) emitRecruitmentPath = args[++index];
  else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
if (!interviewsPath || !recruitmentPath) throw new Error('--interviews and --recruitment are required');

function reportIssues(label: string, filePath: string, issues: readonly TrackerIssue[]): void {
  for (const issue of issues) {
    process.stderr.write(`${filePath}:${issue.line} [${label}.${issue.column}] ${issue.message}\n`);
  }
}

function writeAtomic(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, filePath);
}

const interviewTracker = parseInterviewTracker(readFileSync(interviewsPath, 'utf8'));
const recruitmentTracker = parseRecruitmentTracker(readFileSync(recruitmentPath, 'utf8'));
reportIssues('interview', interviewsPath, interviewTracker.issues);
reportIssues('recruitment', recruitmentPath, recruitmentTracker.issues);
if (interviewTracker.issues.length || recruitmentTracker.issues.length) {
  process.stderr.write('Tracker validation failed; no status or coded evidence was written.\n');
  process.exit(1);
}

const status = buildFieldworkStatus(interviewTracker.rows, recruitmentTracker.rows);
writeAtomic(statusPath, `${JSON.stringify(status, null, 2)}\n`);

if (emitInterviewsPath) {
  const lines = sampleRows(interviewTracker.rows).map((row) => JSON.stringify(toInterviewRecord(row)));
  writeAtomic(emitInterviewsPath, lines.length ? `${lines.join('\n')}\n` : '');
}
if (emitRecruitmentPath) {
  const lines = exportableRecruitmentRows(recruitmentTracker.rows, interviewTracker.rows)
    .map((row) => JSON.stringify(toRecruitmentRecord(row, interviewTracker.rows)));
  writeAtomic(emitRecruitmentPath, lines.length ? `${lines.join('\n')}\n` : '');
}

process.stdout.write(
  `Wrote ${statusPath}\n`
  + `  interviews in sample: ${status.progress.interviews.sample}/30–40 `
  + `(commercial ${status.cohortIntegrity.commercialInterviews}, fast-research ${status.cohortIntegrity.fastResearchInterviews})\n`
  + `  accepted pilot participants: ${status.progress.recruitment.accepted}/25–40\n`
  + `  problem-evidence decision: ${status.report.problemEvidence.decision}\n`
  + `  reportable: ${status.decisionReadiness.ready ? 'yes' : 'no'}\n`,
);
for (const blocker of status.blockers) process.stdout.write(`  ! ${blocker}\n`);
for (const requirement of status.decisionReadiness.unmetRequirements) process.stdout.write(`  · ${requirement}\n`);
for (const action of status.nextActions) process.stdout.write(`  → ${action}\n`);

// Unmet requirements are the normal mid-fieldwork state. Integrity blockers are not.
if (status.blockers.length) process.exitCode = 1;
