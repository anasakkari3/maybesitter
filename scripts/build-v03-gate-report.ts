import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildV03GateReport, type V03GateInput } from '../lib/evaluation/v03PilotGate';

const args = process.argv.slice(2);
let inputPath = '';
let reportPath = 'evaluation-reports/v03-pilot-gate.json';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--input' && args[index + 1]) inputPath = args[++index];
  else if (args[index] === '--report' && args[index + 1]) reportPath = args[++index];
  else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
if (!inputPath) throw new Error('--input is required');

const input = JSON.parse(readFileSync(inputPath, 'utf8')) as V03GateInput;
const report = buildV03GateReport(input);
mkdirSync(path.dirname(reportPath), { recursive: true });
const temporaryPath = `${reportPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
renameSync(temporaryPath, reportPath);
process.stdout.write(`Wrote ${reportPath}: ${report.decision}\n`);
