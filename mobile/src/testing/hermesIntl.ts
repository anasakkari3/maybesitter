/**
 * Hermes' `timeZoneName` parts, reproduced so Jest can see them.
 *
 * On a device, `formatToParts` with `timeZoneName: 'longOffset'` does not
 * return one `"GMT+03:00"` part the way V8 does. Hermes splits it, and puts
 * the *digits* under `literal`:
 *
 *   { type: 'timeZoneName', value: 'GMT' }
 *   { type: 'literal',      value: '+'   }
 *   { type: 'literal',      value: '03'  }
 *   { type: 'literal',      value: ':'   }
 *   { type: 'timeZoneName', value: '00'  }
 *
 * So `parts.find(p => p.type === 'timeZoneName').value` is `"GMT"`, any offset
 * regex misses, and a zone conversion silently falls back to UTC. Captured from
 * a real iPhone 17 Pro simulator (iOS 26.5) on 2026-09-14; see the audit at
 * `audit/product-reality/2026-09-14`.
 *
 * Jest runs on Node, whose `Intl` is correct, which is exactly why this bug
 * shipped past a green suite. Any test that would catch it has to ask for the
 * device's `Intl`, not the host's.
 */
type Part = { type: string; value: string };

const OFFSET_NAME = /^GMT([+-])(\d{2}):(\d{2})$/;

/** One V8-shaped part list, as Hermes would have returned it. */
function asHermesParts(parts: Part[]): Part[] {
  return parts.flatMap((part) => {
    const match = part.type === 'timeZoneName' ? OFFSET_NAME.exec(part.value) : null;
    if (!match) return [part];
    return [
      { type: 'timeZoneName', value: 'GMT' },
      { type: 'literal', value: match[1]! },
      { type: 'literal', value: match[2]! },
      { type: 'literal', value: ':' },
      { type: 'timeZoneName', value: match[3]! },
    ];
  });
}

/**
 * Runs `body` with `Intl.DateTimeFormat` reporting parts the way Hermes does.
 *
 * Only `formatToParts` is touched: everything else stays the real thing, so a
 * test still exercises real zone maths rather than a fixture of it.
 */
export function withHermesIntl<T>(body: () => T): T {
  const Real = Intl.DateTimeFormat;

  const Patched = function PatchedDateTimeFormat(
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    const real = new Real(...args);
    const formatToParts = real.formatToParts.bind(real);
    return {
      format: real.format.bind(real),
      formatRange: real.formatRange?.bind(real),
      formatRangeToParts: real.formatRangeToParts?.bind(real),
      resolvedOptions: real.resolvedOptions.bind(real),
      formatToParts: (date?: Date | number) => asHermesParts(formatToParts(date) as Part[]),
    } as unknown as Intl.DateTimeFormat;
  } as unknown as typeof Intl.DateTimeFormat;

  Patched.supportedLocalesOf = Real.supportedLocalesOf.bind(Real);

  Intl.DateTimeFormat = Patched;
  try {
    return body();
  } finally {
    Intl.DateTimeFormat = Real;
  }
}
