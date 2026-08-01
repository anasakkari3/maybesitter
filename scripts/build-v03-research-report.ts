import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildV03ResearchReport,
  type BehavioralInterviewRecord,
  type PilotRecruitmentRecord,
} from '../lib/research/v03BehavioralResearch';

function readJsonl<T>(filePath: string): T[] {
  const contents = readFileSync(filePath, 'utf8').trim();
  if (!contents) return [];
  return contents.split('\n').map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${filePath}:${index + 1} is not valid JSON`); }
  });
}

const args = process.argv.slice(2);
let interviewsPath = '';
let recruitmentPath = '';
let reportPath = 'evaluation-reports/v03-behavioral-research.json';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--interviews' && args[index + 1]) interviewsPath = args[++index];
  else if (args[index] === '--recruitment' && args[index + 1]) recruitmentPath = args[++index];
  else if (args[index] === '--report' && args[index + 1]) reportPath = args[++index];
  else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
if (!interviewsPath || !recruitmentPath) throw new Error('--interviews and --recruitment are required');

const report = buildV03ResearchReport(
  readJsonl<BehavioralInterviewRecord>(interviewsPath),
  readJsonl<PilotRecruitmentRecord>(recruitmentPath),
);
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Wrote ${reportPath}: ${report.problemEvidence.decision}\n`);
