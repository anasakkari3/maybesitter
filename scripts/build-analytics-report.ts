import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAnalyticsEvent } from '../lib/analytics/privacySafeEvents';
import { buildProductMetricsReport } from '../lib/analytics/productMetrics';

function main(): void {
  const args = process.argv.slice(2);
  let eventsPath = 'evaluation-data/v02-analytics-events.jsonl';
  let reportPath = 'evaluation-reports/v02-analytics-report.json';
  let reportAt = new Date().toISOString();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--events' && args[i + 1]) eventsPath = args[++i];
    else if (args[i] === '--report' && args[i + 1]) reportPath = args[++i];
    else if (args[i] === '--at' && args[i + 1]) reportAt = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (Number.isNaN(Date.parse(reportAt))) throw new Error('--at must be an ISO timestamp');

  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => {
    const event = JSON.parse(line) as unknown;
    const validation = validateAnalyticsEvent(event);
    if (!validation.valid) throw new Error(`${eventsPath}:${index + 1} rejected: ${validation.errors.join('; ')}`);
    return event;
  });

  const report = {
    version: 'v1',
    generatedAt: new Date().toISOString(),
    reportAt,
    source: eventsPath,
    eventCount: events.length,
    metrics: buildProductMetricsReport(events, new Date(reportAt)),
  };

  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Wrote ${reportPath} from ${events.length} events\n`);
}

main();
