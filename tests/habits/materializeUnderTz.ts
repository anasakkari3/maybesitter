/**
 * Materializes the four-week habit horizon and prints the ids, one per line.
 *
 * Run as a child process under several `TZ` values by
 * `habitMaterialization.test.ts`. It exists as a file rather than as an
 * inline `-e` script so that it goes through the same loader and the same
 * modules the suite does — a second copy of the call would be a second thing
 * to keep in step.
 */
import { materializeHabitOccurrences } from '../../lib/habits/materialize.ts';
import { MARCH_MONDAY, MARCH_SUNDAY, habit } from './habitSupport.ts';

const result = materializeHabitOccurrences(habit(), {
  fromLocalDate: MARCH_MONDAY,
  toLocalDate: MARCH_SUNDAY,
});
process.stdout.write(`${result.occurrences.map((entry) => entry.occurrenceId).join('\n')}\n`);
