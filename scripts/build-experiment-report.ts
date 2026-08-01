import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAnalyticsEvent } from '../lib/analytics/privacySafeEvents';
import { buildExperimentReport } from '../lib/experiments/experimentReport';

function main(): void {
  const args = process.argv.slice(2);
  let eventsPath = 'evaluation-data/v03-experiment-events.jsonl';
  let reportPath = 'evaluation-reports/v03-experiment-report.json';
  let generatedAt = new Date().toISOString();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--events' && args[i + 1]) eventsPath = args[++i];
    else if (args[i] === '--report' && args[i + 1]) reportPath = args[++i];
    else if (args[i] === '--at' && args[i + 1]) generatedAt = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('--at must be an ISO timestamp');

  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => {
    const event = JSON.parse(line) as unknown;
    const validation = validateAnalyticsEvent(event);
    if (!validation.valid) throw new Error(`${eventsPath}:${index + 1} rejected: ${validation.errors.join('; ')}`);
    return event;
  });

  const report = buildExperimentReport(events, new Date(generatedAt));
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`Wrote ${reportPath} from ${events.length} events\n`);
  for (const line of report.summary) process.stdout.write(`  ${line}\n`);
  process.stdout.write(`  personalization approved: ${report.personalizationApproved}\n`);
}

main();
