import { execFileSync } from 'node:child_process';

export type ControlAction =
  | { action: 'init' }
  | { action: 'kill'; capability: 'email' | 'calendar' }
  | { action: 'enable'; capability: 'email' | 'calendar'; expectedEpoch: number };

export async function callM5aControl(action: ControlAction): Promise<void> {
  const audience = process.env.MAYBESITTER_INTERNAL_AUDIENCE?.replace(/\/$/, '');
  if (!audience) throw new Error('MAYBESITTER_INTERNAL_AUDIENCE is required');
  const token = process.env.M5A_CONTROLS_ID_TOKEN?.trim() || execFileSync(
    'gcloud', ['auth', 'print-identity-token', `--audiences=${audience}`], { encoding: 'utf8' },
  ).trim();
  const response = await fetch(`${audience}/api/internal/m5a-controls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`M5a control request failed (${response.status}): ${text}`);
  process.stdout.write(`${text}\n`);
}

export function requestedCapability(value: string | undefined): 'email' | 'calendar' {
  if (value !== 'email' && value !== 'calendar') throw new Error('capability must be email or calendar');
  return value;
}
