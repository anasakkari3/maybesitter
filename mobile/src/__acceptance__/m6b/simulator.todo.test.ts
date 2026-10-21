import { describe, it } from '@jest/globals';
import { NOW, ZONE } from './harness';

process.env.TZ = ZONE;
// The device checklist uses this same instant; Jest todos do not execute hooks.
const PINNED_CLOCK = NOW.toISOString();
void PINNED_CLOCK;

describe('M6a-2 device-only acceptance', () => {
  it.todo('R2 layout: needs simulator — seeded 4-fact account has no overlap or clipping at default size and AX5 in ar/en/he');
  it.todo('R2 accessibility: needs simulator — translation action and panel controls expose the fact-aware label and remain reachable with VoiceOver/TalkBack');
  it.todo("R2 ready proposal: needs simulator and Gemini (owner's yes) — proposal direction, Keep, and Save match the real provider response");
});

