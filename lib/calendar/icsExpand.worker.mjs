/**
 * The worker `classifyIcsBounded` starts (UC-3.4, #188). It only expands
 * recurrences; see `icsExpand.mjs`. Any failure is reported without detail —
 * the input is somebody's calendar.
 */
import { parentPort, workerData } from 'node:worker_threads';
import ICAL from 'ical.js';
import { expandRecurrences } from './icsExpand.mjs';

try {
  parentPort.postMessage({ ok: true, expansion: expandRecurrences(ICAL, workerData.text, workerData.request) });
} catch {
  parentPort.postMessage({ ok: false });
}
