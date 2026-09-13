import { readFileSync } from 'node:fs';
import { classifyMessageKind, createsNothing } from '../src/extraction/messageKind.ts';

const rows = readFileSync('evaluation-data/capture-messy-multilingual-v1.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

let wrongNothing: string[] = [];   // should create nothing, classifier says request
let wrongRequest: string[] = [];   // should create something, classifier says otherwise

for (const r of rows) {
  const kind = classifyMessageKind(r.message);
  const mustCreateNothing = r.expected.createsNothing === true;
  if (mustCreateNothing && !createsNothing(kind)) wrongNothing.push(`${r.id} [${kind}] ${r.message}`);
  if (!mustCreateNothing && createsNothing(kind)) wrongRequest.push(`${r.id} [${kind}] ${r.message}`);
}
console.log(`safety cases misread as requests: ${wrongNothing.length}`);
wrongNothing.forEach(s => console.log('  ' + s));
console.log(`\ncommitments misread as non-requests: ${wrongRequest.length}`);
wrongRequest.forEach(s => console.log('  ' + s));
