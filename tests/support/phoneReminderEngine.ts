/**
 * The phone's reminder engine, loaded as it ships, for server tests that have
 * to check a claim against what the phone will actually ring (CL5a I-3).
 *
 * The server decides when a meeting's prep step is reminded; only the phone
 * rings (`mobile/src/features/reminders/softAwarenessEngine.ts`). A server test
 * that compared the claim to its own model of the phone would prove nothing, so
 * these run the phone's `desiredRequests` itself.
 *
 * Loaded by a computed specifier on purpose: a static import would put the
 * mobile modules into the root `tsc` program, which excludes `mobile/` and
 * targets ES5. The shapes below are the few fields these tests touch.
 *
 * What is loaded is the phone's pure planning — `reminderPlan.ts` (which
 * `softAwarenessEngine.ts` re-exports and calls), `reminderInputs.ts` and the
 * pure half of the awareness store — because the Backend CI job installs only
 * the root packages: no React Native, no AsyncStorage, no zod (CL5a round 3,
 * C-1). `importsOutsideTheRoot` is the guard that keeps it that way.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';


export interface PhoneReminderCommitment {
  readonly id: string;
  readonly startsAt: string | null;
  readonly status: string;
  readonly priority: 'must' | 'should' | 'nice';
  readonly allDay: boolean;
  readonly postponedUntil: string | null;
}

export interface PhoneReminderSettings {
  readonly softEnabled: boolean;
  readonly softLeadMinutes: number;
  readonly intensity: 'none' | 'softAwareness' | 'followUp' | 'strongReminder';
  readonly escalationCeiling: 'soft' | 'followUp' | 'hard';
  readonly hardEnabled: boolean;
  readonly mustThroughQuietHours: boolean;
}

export interface PhoneReminderEngine {
  /** Every ring the phone would schedule, earliest first, in epoch ms. */
  ringsFor(input: {
    commitments: readonly PhoneReminderCommitment[];
    now: Date;
    settings: PhoneReminderSettings;
    quietHours: { start: string; end: string } | null;
    timeZone: string;
  }): number[];
  /** `toReminderCommitments`, on commitments as the list routes return them. */
  toReminderCommitments(items: readonly unknown[]): PhoneReminderCommitment[];
  /** `toEngineSettings`, `quietWindowOf` and `quietTimeZone`, on the settings route's DTO. */
  fromSettingsDto(dto: unknown, intensity: PhoneReminderSettings['intensity']): {
    settings: PhoneReminderSettings;
    quietHours: { start: string; end: string } | null;
    timeZone: string;
  };
}

/** The mobile files these tests load, relative to `mobile/src/`. */
const ENTRY_POINTS = [
  'features/reminders/reminderPlan.ts',
  'features/reminders/reminderInputs.ts',
  'lib/deviceSettings/awareness.ts',
] as const;

const MOBILE_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../mobile/src');

/** The specifiers a module really imports at run time: type-only imports are gone once it is transpiled. */
function runtimeImportsOf(file: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: file,
  });
  return ts.preProcessFile(outputText, true, true).importedFiles.map((imported) => imported.fileName);
}

function resolveMobile(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const found = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (found) return found;
  throw new Error(`${specifier} (from ${from}) resolves to no file`);
}

/**
 * Every run-time import, anywhere under what these tests load, that is not a
 * relative path inside the repository — as `file: specifier`. Empty is the
 * only answer that loads in the Backend CI job; a package here loads on a
 * machine with `mobile/node_modules` and fails there (C-1).
 */
export function importsOutsideTheRoot(): { visited: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages: string[] = [];
  const queue = ENTRY_POINTS.map((path) => resolve(MOBILE_SRC, path));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImportsOf(file)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) queue.push(resolveMobile(file, specifier));
      else packages.push(`${file.slice(MOBILE_SRC.length + 1)}: ${specifier}`);
    }
  }
  return { visited: Array.from(seen, (file) => file.slice(MOBILE_SRC.length + 1)).sort(), packages };
}

let loaded: Promise<PhoneReminderEngine> | null = null;

async function load(): Promise<PhoneReminderEngine> {
  const base = new URL('../../mobile/src/', import.meta.url);
  const specifier = (path: string) => new URL(path, base).href;
  const [engine, inputs, awareness] = await Promise.all(ENTRY_POINTS.map((path) => import(specifier(path))));
  return {
    ringsFor(input) {
      const { desired } = engine.desiredRequests({
        ...input,
        awareness: awareness.EMPTY_AWARENESS,
        copy: { title: '', body: '' },
        hardCopy: { title: '', body: '' },
        exactAlarms: true,
      }) as { desired: Array<{ at: number }> };
      return desired.map((request) => request.at).sort((left, right) => left - right);
    },
    toReminderCommitments: (items) => inputs.toReminderCommitments(items),
    fromSettingsDto: (dto, intensity) => ({
      settings: inputs.toEngineSettings(dto, intensity),
      quietHours: inputs.quietWindowOf(dto),
      timeZone: inputs.quietTimeZone(dto),
    }),
  };
}

export function phoneReminderEngine(): Promise<PhoneReminderEngine> {
  loaded ??= load();
  return loaded;
}
