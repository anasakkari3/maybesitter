import { describe, expect, it } from '@jest/globals';
import { meetingPrepResponseSchema } from '../../../api/schemas/meetings';
import { reminderSettingsResponseSchema } from '../../../api/schemas/reminders';
import type { Commitment } from '../../../api/schemas/common';
import { planFor } from '../../reminders/policy';
import { toEngineSettings, toReminderCommitments } from '../../reminders/reminderInputs';
import preparedFixture from '../../../api/__fixtures__/meetings.prepared.json';
import preparedGeminiFixture from '../../../api/__fixtures__/meetings.preparedGemini.json';
import preparedNoReminderFixture from '../../../api/__fixtures__/meetings.preparedNoReminder.json';
import settingsFixture from '../../../api/__fixtures__/reminders.settingsDefault.json';
import commitmentFixture from '../../../api/__fixtures__/commitments.one.json';

/**
 * When the phone rings for a confirmed prep step (CL5a I-1).
 *
 * The phone's reminder engine rings at `timeSpec.dueAt − softLeadMinutes` and
 * reads nothing else (`reminderInputs.ts`, `startOf`). The server's promise is
 * "a reminder an hour before the meeting", so the prep step it proposes must be
 * *due* one lead after that hour. This runs the engine the phone runs on the
 * step as the route recorded it — confirming copies `prep.dueAt` and
 * `prep.remindAt` onto the commitment unchanged (the server's pipeline test
 * holds that half) — with the account's default settings, as recorded.
 */
const MINUTE = 60_000;

function confirmedPrepStep(fixture: unknown): { commitment: Commitment; startAt: string } {
  const { prep } = meetingPrepResponseSchema.parse(fixture);
  const base = commitmentFixture as Commitment;
  const commitment: Commitment = {
    ...base,
    id: prep.itemId,
    status: 'active',
    postponedUntil: null,
    timeSpec: { ...base.timeSpec, kind: 'due_by', dueAt: prep.dueAt, remindAt: prep.remindAt, endAt: null, allDay: false },
  };
  return { commitment, startAt: prep.startAt };
}

describe('the prep step rings an hour before the meeting', () => {
  it.each([
    ['rules', preparedFixture],
    ['model', preparedGeminiFixture],
  ])('%s: the first local reminder is at the start minus 60 minutes', (_engine, fixture) => {
    const { commitment, startAt } = confirmedPrepStep(fixture);
    const dto = reminderSettingsResponseSchema.parse(settingsFixture).reminderSettings;
    const settings = toEngineSettings(dto, 'softAwareness');
    const [reminder] = toReminderCommitments([commitment]);
    const planned = planFor(reminder!, settings);
    expect(planned.length).toBeGreaterThan(0);
    const first = Math.min(...planned.map((stage) => stage.at));
    expect((Date.parse(startAt) - first) / MINUTE).toBe(60);
  });

  it('the recorded prep step is the first item, and is due at the meeting, not before it', () => {
    for (const fixture of [preparedFixture, preparedGeminiFixture]) {
      const { proposal, prep } = meetingPrepResponseSchema.parse(fixture);
      expect(prep.itemId).toBe(proposal.items[0]!.itemId);
      expect(Date.parse(prep.dueAt)).toBeLessThanOrEqual(Date.parse(prep.startAt));
      expect(prep.remindAt).not.toBeNull();
      expect(Date.parse(prep.dueAt)).toBeGreaterThan(Date.parse(prep.remindAt!));
    }
  });
});

describe('a meeting too close for a reminder (CL5a I-3)', () => {
  it('the recorded response claims none, and the phone, run on it, schedules none', () => {
    const { commitment } = confirmedPrepStep(preparedNoReminderFixture);
    const { prep, proposal } = meetingPrepResponseSchema.parse(preparedNoReminderFixture);
    expect(prep.remindAt).toBeNull();
    expect(prep.silentBecause).toBe('too_close');
    // Shown in review at the time it is due, which is the meeting's start.
    expect(proposal.items[0]!.resolvedTime).toBe(prep.dueAt);
    expect(prep.dueAt).toBe(prep.startAt);
    // The account the fixture was recorded under has the default settings: a
    // one-hour lead and the soft ceiling. Twenty minutes out, the phone has
    // nothing left to ring — "now" is the moment the request was answered.
    const dto = reminderSettingsResponseSchema.parse(settingsFixture).reminderSettings;
    const settings = toEngineSettings({ ...dto, escalationCeiling: 'soft' }, 'softAwareness');
    const [reminder] = toReminderCommitments([commitment]);
    const now = Date.parse(prep.startAt) - 20 * MINUTE;
    expect(planFor(reminder!, settings).filter((stage) => stage.at > now)).toEqual([]);
  });
});
