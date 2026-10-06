/**
 * The capture chat against what the real model answered (chat UAT round 2,
 * 2026-09-30).
 *
 * Every answer here is Gemini's own (gemini-2.5-flash on Vertex, europe-west1),
 * captured locally for these exact conversations with the repo's own prompt
 * builder and provider, and replayed: scripted answers written to pass hid a
 * real-model failure once already («لا خلّي التانية الساعة 7»). The captures
 * were made on 2026-09-30 (a Wednesday); their days are moved onto the same
 * days from today — Friday stays a Friday — so the replay never goes stale.
 *
 * What is held:
 *   - «…الاول … عال ٤ والثاني … عال٦» then «لا خلّي التانية الساعة 7»: Friday
 *     16:00 and 19:00, nothing asked — however the model answered the edit
 *     (retitled the second «خلّي التانية», moved the first to 09:00);
 *   - «عندي تدريب كل سبت من 10 لـ 4» and "every Saturday from 10 to 4": one
 *     item, Saturday 10:00–16:00, the weekly block offered and confirmable,
 *     no hour asked — whether the model gave the hour, only a wall clock, or
 *     nothing;
 *   - the earlier cases still hold: dentist and Sara, then "make the dentist
 *     5pm"; «لازم أتصل بالبنك» then «بكرا الساعة 10 الصبح»; "meeting with Sara
 *     on Sunday morning" settled at 09:00 with a reply that does not ask;
 *   - the reply never claims a change and asks for it at once, and never asks
 *     for an hour the card already shows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { safeChatReply } from '../../lib/services/captureChat/chatReply.ts';
import { chatItemEvidence } from '../../lib/services/captureBoundary/chatEvidence.ts';
import { instantFromLocal, localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { resolveWeekdayDate } from '../../src/extraction/weekdayLexicon.ts';
import { LLMUnavailableError, type LLMProviderFunction } from '../../src/extraction/llm/index.ts';
import { renderRefModelAnswer } from './captureChatModelFixtures.ts';

const BASE = 'http://localhost:3000';
const TZ = 'Asia/Jerusalem';

function localDate(offsetDays: number): string {
  const today = localTimeSpecFor(new Date(), TZ)!.date;
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
}
const weekday = (name: string): string => resolveWeekdayDate(name, new Date(), TZ)!.date;
const FRIDAY = weekday('Friday');
const SATURDAY = weekday('Saturday');
const SUNDAY = weekday('Sunday');
const TOMORROW = localDate(1);
/** The captured days (2026-09-30 was a Wednesday), and the same days from today. */
const DAYS: Record<string, string> = {
  '2026-10-01': TOMORROW,
  '2026-10-02': FRIDAY,
  '2026-10-03': SATURDAY,
  '2026-10-04': SUNDAY,
  // The r11 live recording was made on Tuesday 2026-10-06. Keep relative
  // "tomorrow" tomorrow and named weekdays on the same weekday from today.
  '2026-10-07': TOMORROW,
  '2026-10-08': weekday('Thursday'),
  '2026-10-12': weekday('Monday'),
};
const at = (date: string, time: string): string => instantFromLocal(date, time, TZ)!.toISOString();

/** A captured answer with its days moved (see the header). Nothing else is touched. */
function rebased(answer: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(answer)) as {
    items?: Array<Record<string, unknown>>;
    added?: Array<Record<string, unknown>>;
    open?: Array<{ fields?: Record<string, unknown> }>;
  };
  const items = [...(copy.items ?? []), ...(copy.added ?? []), ...(copy.open ?? []).flatMap((operation) => operation.fields ? [operation.fields] : [])];
  for (const item of items) {
    const spec = item.localTimeSpec as { date?: string; time?: string | null } | null;
    const shift = (instant: unknown): unknown => {
      if (typeof instant !== 'string') return instant;
      const local = localTimeSpecFor(new Date(instant), TZ)!;
      return at(DAYS[local.date] ?? local.date, local.time);
    };
    item.dueAt = shift(item.dueAt);
    item.remindAt = shift(item.remindAt);
    if (spec?.date) spec.date = DAYS[spec.date] ?? spec.date;
  }
  return copy;
}

/** Gemini's answers, in the order of the conversation they were captured in. */
function replay(answers: readonly unknown[]): { provider: LLMProviderFunction; calls: () => number } {
  let calls = 0;
  return { provider: async (prompt) => renderRefModelAnswer(rebased(answers[calls++]), prompt), calls: () => calls };
}

/** Replay a live turn that fell back to rules as a model outage, without shifting later answers. */
function replayLive(records: readonly { modelAnswers: string[] }[]): { provider: LLMProviderFunction; calls: () => number } {
  const queue = records.flatMap((record) => record.modelAnswers.length > 0
    ? record.modelAnswers.map((answer) => JSON.parse(answer) as unknown)
    : [null]);
  let calls = 0;
  return {
    provider: async (prompt) => {
      const answer = queue[calls++];
      if (answer === null) throw new LLMUnavailableError('recorded_live_fallback');
      return renderRefModelAnswer(rebased(answer), prompt);
    },
    calls: () => calls,
  };
}

let auth: FakeAuthControls | null = null;
function begin(provider: LLMProviderFunction): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  setCaptureChatDependenciesForTests({ llmProviderFor: () => provider });
}
function end(): void {
  setCaptureChatDependenciesForTests(null);
  resetStorageForTests();
  auth?.restore();
  auth = null;
}
function post(path: string, uid: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Item = {
  itemId: string; title: string; resolvedTime: string | null; resolvedDate?: string; needsClarification: boolean;
  timeEstimated?: boolean; clarification?: { questionKey: string } | null;
  endTime?: string | null;
  weeklyBlock?: { title: string; weekdays: number[]; start: string; end: string };
};
type Body = {
  conversationId: string;
  reply: string;
  engine: string;
  proposal: {
    proposalId: string;
    items: Item[];
    seeds?: Array<{ kind: string; summary: string }>;
    removedItems?: Array<{ kind: string; text: string }>;
  } | null;
};

async function conversation(
  uidLabel: string,
  messages: readonly string[],
  locale?: 'ar' | 'en' | 'he',
  expectedEngines?: readonly string[],
): Promise<Body[]> {
  const uid = uidFor(uidLabel);
  const bodies: Body[] = [];
  for (const message of messages) {
    const response = await chatPost(post('/api/mobile/capture/chat', uid, {
      ...(bodies.length ? { conversationId: bodies[bodies.length - 1]!.conversationId } : {}),
      message, timezone: TZ, referenceTime: new Date().toISOString(),
      ...(locale ? { locale } : {}),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as Body;
    assert.equal(body.engine, expectedEngines?.[bodies.length] ?? 'model', `the replay did not reach the boundary: ${body.reply}`);
    bodies.push(body);
  }
  return bodies;
}

const settled = (item: Item | undefined, date: string, time: string, label: string) => {
  assert.ok(item, `${label}: no item`);
  assert.equal(item.needsClarification, false, `${label} was asked: ${JSON.stringify(item)}`);
  assert.equal(item.resolvedTime, at(date, time), `${label}: ${JSON.stringify(item)}`);
};
const asksNothing = (reply: string) => assert.doesNotMatch(reply, /[?؟]/, `the reply asks: ${reply}`);

// Captured from Gemini on 2026-09-30 (see the header). Raw, as the model answered.
const REAL = {
 "engagementsFirstMoved": [
  {
   "reply": "تمام، ذكرني بخطبة صاحبك الأول يوم الجمعة الساعة ٤، والثاني يوم الجمعة الساعة ٦. أكّد من تحت.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الاول",
     "person": "صاحبي الاول",
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": "2026-10-02T13:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الثاني",
     "person": "صاحبي الثاني",
     "dueAt": "2026-10-02T15:00:00Z",
     "remindAt": "2026-10-02T15:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "18:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    }
   ]
  },
  {
   "reply": "تمام، عدّلت خطبة صاحبك التاني للساعة ٧. أكّد من تحت.",
   "action": "update",
   "items": [
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الاول",
     "person": "صاحبي الاول",
     "dueAt": "2026-10-02T09:00:00.000Z",
     "remindAt": "2026-10-02T09:00:00.000Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "09:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 0.8,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الثاني",
     "person": "صاحبي الثاني",
     "dueAt": "2026-10-02T16:00:00.000Z",
     "remindAt": "2026-10-02T16:00:00.000Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "19:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 0.8,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "engagementsRetitled": [
  {
   "reply": "تمام، ذكرني بخطبة صاحبك الأول يوم الجمعة الساعة ٤، والثاني يوم الجمعة الساعة ٦. أكّد من تحت.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "ذكرني",
     "title": "ذكرني بخطبة صاحبي الأول",
     "person": "صاحبي الأول",
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": "2026-10-02T13:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "ذكرني",
     "title": "ذكرني بخطبة صاحبي الثاني",
     "person": "صاحبي الثاني",
     "dueAt": "2026-10-02T15:00:00Z",
     "remindAt": "2026-10-02T15:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "18:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    }
   ]
  },
  {
   "reply": "تمام، غيرت وقت خطبة صاحبك الثاني للجمعة الساعة ٧. أكّد من تحت.",
   "action": "update",
   "items": [
    {
     "type": "task",
     "action": "ذكرني",
     "title": "ذكرني بخطبة صاحبي الأول",
     "person": null,
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": "2026-10-02T13:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "خلّي",
     "title": "خلّي التانية",
     "person": null,
     "dueAt": "2026-10-02T16:00:00Z",
     "remindAt": "2026-10-02T16:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "19:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "engagements": [
  {
   "reply": "تمام، ذكرني بخطبة صاحبك الأول يوم الجمعة الساعة ٤، والثاني يوم الجمعة الساعة ٦. أكّد من تحت.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الاول",
     "person": "صاحبي الاول",
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": "2026-10-02T13:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "ذكرني",
     "title": "خطبة صاحبي الثاني",
     "person": "صاحبي الثاني",
     "dueAt": "2026-10-02T15:00:00Z",
     "remindAt": "2026-10-02T15:00:00Z",
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "18:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": "social",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": true,
     "explicitPressureRequest": false
    }
   ]
  },
  {
   "reply": "تمام، خليت خطبة صاحبك التاني يوم الجمعة الساعة ٧. أكّد من تحت.",
   "action": "update",
   "items": [
    {
     "type": "task",
     "action": "خطبة",
     "title": "خطبة صاحبي الاول",
     "person": "صاحبي الاول",
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "خطبة",
     "title": "خطبة صاحبي الثاني",
     "person": "صاحبي الثاني",
     "dueAt": "2026-10-02T16:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "19:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "weeklyArWallClockOnly": [
  {
   "reply": "تمام، تدريب كل سبت من العشرة للاربعة. أكّد من تحت.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "تدريب",
     "title": "تدريب",
     "person": null,
     "dueAt": null,
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-03",
      "time": "10:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 0.8,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "weeklyArNoTime": [
  {
   "reply": "تمام، تدريب كل سبت من الـ 10 للـ 4. أكّد من تحت.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "تدريب",
     "title": "تدريب",
     "person": null,
     "dueAt": null,
     "remindAt": null,
     "localTimeSpec": null,
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 0.8,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [
      "vague_time"
     ],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "weeklyEnNoTime": [
  {
   "reply": "I see you have an internship every Saturday from 10 AM to 4 PM. You can confirm this below.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "have",
     "title": "Internship",
     "person": null,
     "dueAt": null,
     "remindAt": null,
     "localTimeSpec": null,
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 0.8,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "weeklyEnWallClockOnly": [
  {
   "reply": "I understand you have an internship every Saturday from 10 AM to 4 PM. You can confirm this below.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "have",
     "title": "Internship",
     "person": null,
     "dueAt": null,
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-03",
      "time": "10:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "dentistSara": [
  {
   "reply": "I have two items for you: a dentist appointment on Friday at 4 PM, and a meeting with Sara on Sunday at 9 AM. You can confirm them below.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "have",
     "title": "Dentist appointment",
     "person": null,
     "dueAt": "2026-10-02T13:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "16:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "high",
      "source": "inferred",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": "health",
     "categoryConfidence": 0.8,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "meet",
     "title": "Meet with Sara",
     "person": "Sara",
     "dueAt": "2026-10-04T06:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-04",
      "time": "09:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "soft",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  },
  {
   "reply": "I've changed the dentist appointment to Friday at 5 PM.",
   "action": "update",
   "items": [
    {
     "type": "task",
     "action": "Dentist appointment",
     "title": "Dentist appointment",
     "person": null,
     "dueAt": "2026-10-02T14:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-02",
      "time": "17:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "high",
      "source": "inferred",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": "health",
     "categoryConfidence": 1,
     "confidence": {
      "overall": 0.9,
      "type": 1,
      "action": 0.9,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    },
    {
     "type": "task",
     "action": "Meet",
     "title": "Meet with Sara",
     "person": "Sara",
     "dueAt": "2026-10-04T06:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-04",
      "time": "09:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.9,
      "type": 1,
      "action": 0.9,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "bank": [
  {
   "reply": "تمام، شو اليوم والوقت اللي بدك تتصل فيه بالبنك؟",
   "action": "ask",
   "items": [
    {
     "type": "task",
     "action": "أتصل",
     "title": "أتصل بالبنك",
     "person": null,
     "dueAt": null,
     "remindAt": null,
     "localTimeSpec": null,
     "priority": {
      "level": "high",
      "source": "user_explicit",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 1,
      "time": 0,
      "priority": 1
     },
     "missingFields": [
      "time"
     ],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  },
  {
   "reply": "تمام، بدك تتصل بالبنك بكرة الساعة 10 الصبح. أكّد من تحت.",
   "action": "update",
   "items": [
    {
     "type": "task",
     "action": "أتصل",
     "title": "أتصل بالبنك",
     "person": null,
     "dueAt": "2026-10-01T07:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-01",
      "time": "10:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "high",
      "source": "user_explicit",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ],
 "saraMorning": [
  {
   "reply": "I have \"meeting with Sara\" for you on Sunday at 09:00. You can change the hour below.",
   "action": "propose",
   "items": [
    {
     "type": "task",
     "action": "meeting",
     "title": "Meeting with Sara",
     "person": "Sara",
     "dueAt": "2026-10-04T07:00:00Z",
     "remindAt": null,
     "localTimeSpec": {
      "date": "2026-10-04",
      "time": "09:00",
      "timezone": "Asia/Jerusalem"
     },
     "priority": {
      "level": "normal",
      "source": "default",
      "pressureAllowed": false,
      "pressureImplied": false
     },
     "flexibility": "movable",
     "category": null,
     "categoryConfidence": 0,
     "confidence": {
      "overall": 0.8,
      "type": 1,
      "action": 0.8,
      "time": 1,
      "priority": 1
     },
     "missingFields": [],
     "ambiguityFlags": [],
     "explicitReminderRequest": false,
     "explicitPressureRequest": false
    }
   ]
  }
 ]
} as const;

/* ── 1. the owner's engagements, then «لا خلّي التانية الساعة 7» ───── */

const ENGAGEMENTS = ['ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤ والثاني الجمعة عال٦', 'لا خلّي التانية الساعة 7'];
const RETITLED_BY_REF = [
  { reply: REAL.engagementsRetitled[0].reply, action: 'propose', locked: [], open: [], added: REAL.engagementsRetitled[0].items },
  {
    reply: REAL.engagementsRetitled[1].reply,
    action: 'update',
    locked: [],
    open: [
      { ref: 'i1', op: 'keep' },
      {
        ref: 'i2', op: 'update', fields: REAL.engagementsRetitled[1].items[1],
      },
    ],
    added: [],
  },
] as const;

for (const [label, answers] of [
  ['as the model usually answers', REAL.engagements],
  ['the recorded ref update retitles the second', RETITLED_BY_REF],
  ['the model moved the first to 09:00', REAL.engagementsFirstMoved],
] as const) {
  for (const locale of [undefined, 'ar'] as const) test(`«لا خلّي التانية الساعة 7» asks AM or PM for the second (${label}${locale ? ', app in Arabic' : ''})`, async () => {
    begin(replay(answers).provider);
    try {
      // An Arabic app (owner request 2026-09-30) changes nothing for an Arabic conversation.
      const [first, second] = await conversation(`ChatReal${label.length}${locale ?? ''}`, ENGAGEMENTS, locale);
      settled(first!.proposal!.items[0], FRIDAY, '16:00', 'the first, turn 1');
      settled(first!.proposal!.items[1], FRIDAY, '18:00', 'the second, turn 1');
      settled(second!.proposal!.items[0], FRIDAY, '16:00', 'the first, turn 2');
      assert.equal(second!.proposal!.items[1]!.resolvedDate, FRIDAY);
      assert.equal(second!.proposal!.items[1]!.resolvedTime, null);
      assert.equal(second!.proposal!.items[1]!.clarification?.questionKey, 'ask_am_pm');
      if (label === 'the recorded ref update retitles the second') {
        assert.equal(second!.proposal!.items[1]!.title, 'خلّي التانية', 'the merge did not apply the model’s exact ref update');
      } else {
        assert.equal(second!.proposal!.items[1]!.title, first!.proposal!.items[1]!.title, 'an unchanged model title drifted');
      }
      assert.match(second!.reply, /الصبح|المسا/);
    } finally {
      end();
    }
  });
}

/* ── 2. «عندي تدريب كل سبت من 10 لـ 4», "every Saturday from 10 to 4" ── */

for (const [label, message, answers, blockTitle] of [
  ['ar, the hour given', 'عندي تدريب كل سبت من 10 لـ 4', null, 'تدريب'],
  ['ar, only a wall clock', 'عندي تدريب كل سبت من 10 لـ 4', REAL.weeklyArWallClockOnly, 'تدريب'],
  ['ar, no hour at all', 'عندي تدريب كل سبت من 10 لـ 4', REAL.weeklyArNoTime, 'تدريب'],
  ['en, no hour at all', 'I have an internship every Saturday from 10 to 4', REAL.weeklyEnNoTime, 'Internship'],
  ['en, only a wall clock', 'I have an internship every Saturday from 10 to 4', REAL.weeklyEnWallClockOnly, 'Internship'],
] as const) {
  test(`a weekly routine is Saturday 10:00–16:00 and offered weekly, nothing asked (${label})`, async () => {
    const answer = answers ?? [{ ...REAL.weeklyArWallClockOnly[0], items: [{ ...REAL.weeklyArWallClockOnly[0].items[0], dueAt: '2026-10-03T07:00:00Z' }] }];
    begin(replay(answer).provider);
    try {
      const uid = `ChatRealWeekly${label.length}`;
      const [body] = await conversation(uid, [message]);
      const only = body!.proposal!.items;
      assert.equal(only.length, 1);
      settled(only[0], SATURDAY, '10:00', 'the routine');
      assert.deepEqual(only[0]!.weeklyBlock && { title: only[0]!.weeklyBlock.title, weekdays: only[0]!.weeklyBlock.weekdays, start: only[0]!.weeklyBlock.start, end: only[0]!.weeklyBlock.end },
        { title: blockTitle, weekdays: [6], start: '10:00', end: '16:00' }, JSON.stringify(only[0]));
      asksNothing(body!.reply);
      // Kept weekly through the existing confirm, as a capture's is.
      const confirmed = await confirmPost(post('/api/mobile/capture/confirm', uidFor(uid), {
        proposalId: body!.proposal!.proposalId, itemIds: [only[0]!.itemId], weeklyBlockItemIds: [only[0]!.itemId],
      }));
      assert.equal(confirmed.status, 200);
      const result = await confirmed.json() as { weeklyBlocks: Array<{ title?: string }> };
      assert.equal(result.weeklyBlocks.length, 1);
    } finally {
      end();
    }
  });
}

/* ── 3. the earlier real cases, still right ─────────────────────── */

test('dentist and Sara, then "make the dentist 5pm": Friday 17:00 and Sunday 09:00', async () => {
  begin(replay(REAL.dentistSara).provider);
  try {
    const [first, second] = await conversation('ChatRealDentistSara', [
      'I have a dentist appointment on Friday at 4pm and a meeting with Sara on Sunday morning', 'make the dentist 5pm',
    ]);
    settled(first!.proposal!.items[0], FRIDAY, '16:00', 'dentist, turn 1');
    settled(first!.proposal!.items[1], SUNDAY, '09:00', 'Sara, turn 1');
    settled(second!.proposal!.items[0], FRIDAY, '17:00', 'dentist, turn 2');
    settled(second!.proposal!.items[1], SUNDAY, '09:00', 'Sara, turn 2');
  } finally {
    end();
  }
});

test('«لازم أتصل بالبنك» asks the hour; «بكرا الساعة 10 الصبح» settles it tomorrow at 10:00', async () => {
  begin(replay(REAL.bank).provider);
  try {
    const [first, second] = await conversation('ChatRealBank', ['لازم أتصل بالبنك', 'بكرا الساعة 10 الصبح']);
    assert.equal(first!.proposal!.items[0]!.needsClarification, true);
    assert.match(first!.reply, /[?؟]/);
    settled(second!.proposal!.items[0], TOMORROW, '10:00', 'the bank');
    asksNothing(second!.reply);
  } finally {
    end();
  }
});

test('"meeting with Sara on Sunday morning": 09:00, marked as ours, and the reply does not ask for it', async () => {
  begin(replay(REAL.saraMorning).provider);
  try {
    const [body] = await conversation('ChatRealSaraMorning', ['meeting with Sara on Sunday morning']);
    settled(body!.proposal!.items[0], SUNDAY, '09:00', 'Sara');
    assert.equal(body!.proposal!.items[0]!.timeEstimated, true);
    asksNothing(body!.reply);
  } finally {
    end();
  }
});

/* ── 4. the reply agrees with the card ──────────────────────────── */

test('a reply never claims a change and asks for it at once (the staging reply)', () => {
  const proposal = { items: [
    { title: 'خطبة صاحبي الاول', needsClarification: false, resolvedTime: at(FRIDAY, '16:00') },
    { title: 'خطبة صاحبي الثاني', needsClarification: true, resolvedDate: FRIDAY, clarification: { questionKey: 'ask_time', params: { date: FRIDAY } } },
  ] } as never;
  const { reply } = safeChatReply('تمام، خليت خطبة صاحبك الثاني يوم الجمعة الساعة ٧. أكّد من تحت.', { language: 'ar', proposal, updated: true, timezone: TZ });
  assert.doesNotMatch(reply, /الساعة ٧/, reply);
  assert.match(reply, /أي ساعة بدك «خطبة صاحبي الثاني»؟$/);
  // A sentence about both items stands: it is true of the one that is settled.
  const both = safeChatReply('الأول الجمعة الساعة ٤ والثاني الجمعة. أكّد من تحت.', { language: 'ar', proposal, timezone: TZ }).reply;
  assert.match(both, /^الأول الجمعة الساعة ٤ والثاني الجمعة\./);
});

test('a reply never asks for an hour the card already shows (the emulator reply)', () => {
  const proposal = { items: [
    { title: 'Meeting with Sara', needsClarification: false, resolvedTime: at(SUNDAY, '09:00'), timeEstimated: true },
  ] } as never;
  const { reply } = safeChatReply('Okay, a meeting with Sara on Sunday morning. What time on Sunday morning is your meeting with Sara?', { language: 'en', proposal, timezone: TZ });
  assert.equal(reply, 'Okay, a meeting with Sara on Sunday morning. "Meeting with Sara" is at 09:00 for now. Tell me if you want another time.');
  // A question that is not about the hour stands.
  assert.equal(safeChatReply('Should I add the gym too?', { language: 'en', proposal, timezone: TZ }).reply, 'Should I add the gym too?');
});

test('an ordinal in a later message points at that item of the list the person saw', () => {
  const previous = [
    { title: 'خطبة صاحبي الاول', date: FRIDAY, time: '16:00' },
    { title: 'خطبة صاحبي الثاني', date: FRIDAY, time: '18:00' },
  ];
  const items = [{ title: 'خطبة صاحبي الاول' }, { title: 'خطبة صاحبي الثاني' }];
  const [first, second] = chatItemEvidence(ENGAGEMENTS, items, previous, TZ);
  assert.equal(first!.touchedNow, false, 'the edit was read as the first’s too');
  assert.equal(second!.touchedNow, true);
  assert.ok(second!.turns.includes('لا خلّي التانية الساعة 7'));
  assert.ok(!first!.turns.includes('لا خلّي التانية الساعة 7'));
  // «الساعة التانية» is two o'clock, not the second item.
  const [one, two] = chatItemEvidence(['ذكرني بخطبة صاحبي الاول يوم الجمعة عال ٤ والثاني الجمعة عال٦', 'خليها الساعة التانية'], items, previous, TZ);
  assert.equal(one!.touchedNow, true);
  assert.equal(two!.touchedNow, true);
});

test('"make it 5pm" in a list of two is the one item the model changed, not both', () => {
  const previous = [
    { title: 'Dentist appointment', date: FRIDAY, time: '16:00' },
    { title: 'Meeting with Sara', date: SUNDAY, time: '09:00' },
  ];
  const items = [
    { title: 'Dentist appointment', localTimeSpec: { date: FRIDAY, time: '17:00', timezone: TZ } },
    { title: 'Meeting with Sara', localTimeSpec: { date: SUNDAY, time: '09:00', timezone: TZ } },
  ];
  const turns = ['I have a dentist appointment on Friday at 4pm and a meeting with Sara on Sunday morning', 'make it 5pm'];
  const [dentist, sara] = chatItemEvidence(turns, items, previous, TZ);
  assert.equal(dentist!.touchedNow, true);
  assert.equal(sara!.touchedNow, false, 'an edit of the dentist was read as Sara’s too');
  assert.ok(!sara!.turns.includes('make it 5pm'));
});

/* ── 5. a question the person has not answered stays asked ─────── */

test('the model never answers «الصبح ولا المسا؟» for the person: a pending question survives an edit of the other item', async () => {
  // Staging, 2026-10-01 07:26Z: the first call failed (a cold provider), the
  // rules asked «الصبح ولا المسا؟» for both engagements; on the edit the model
  // put the FIRST at 04:00 — the morning — settled, with nothing asked.
  const [, edit] = REAL.engagements;
  const pickedMorning = {
    ...edit,
    items: edit.items.map((entry, index) => index === 0
      ? { ...entry, dueAt: '2026-10-02T01:00:00.000Z', remindAt: '2026-10-02T01:00:00.000Z', localTimeSpec: { date: '2026-10-02', time: '04:00', timezone: TZ } }
      : entry),
  };
  let calls = 0;
  const provider: LLMProviderFunction = async (prompt) => {
    calls += 1;
    if (calls === 1) throw new LLMUnavailableError('timeout');
    return renderRefModelAnswer(rebased(pickedMorning), prompt);
  };
  begin(provider);
  try {
    const uid = uidFor('ChatRealPendingAmPm');
    const first = await chatPost(post('/api/mobile/capture/chat', uid, { message: ENGAGEMENTS[0], timezone: TZ, referenceTime: new Date().toISOString() }));
    const one = await first.json() as Body;
    assert.equal(one.engine, 'rules');
    assert.deepEqual(one.proposal!.items.map((entry) => entry.clarification?.questionKey), ['ask_am_pm', 'ask_am_pm']);
    const second = await chatPost(post('/api/mobile/capture/chat', uid, {
      conversationId: one.conversationId, message: ENGAGEMENTS[1], timezone: TZ, referenceTime: new Date().toISOString(),
    }));
    const two = await second.json() as Body;
    assert.equal(two.engine, 'model');
    const [firstItem, secondItem] = two.proposal!.items;
    assert.equal(firstItem!.resolvedTime, null, `04:00 was picked for the person: ${JSON.stringify(firstItem)}`);
    assert.equal(firstItem!.needsClarification, true);
    assert.equal(firstItem!.clarification?.questionKey, 'ask_am_pm', JSON.stringify(firstItem));
    assert.equal(secondItem!.resolvedDate, FRIDAY);
    assert.equal(secondItem!.resolvedTime, null);
    assert.equal(secondItem!.needsClarification, true);
    assert.equal(secondItem!.clarification?.questionKey, 'ask_am_pm');
  } finally {
    end();
  }
});

test('a pending question is the model\u2019s to settle once the person answers it in the chat', async () => {
  // «الأولى 4 المسا»: the person answers the first engagement's question.
  const [, edit] = REAL.engagements;
  const answered = {
    ...edit,
    items: edit.items.map((entry, index) => index === 0 ? entry : {
      ...entry, dueAt: '2026-10-02T15:00:00.000Z', remindAt: '2026-10-02T15:00:00.000Z', localTimeSpec: { date: '2026-10-02', time: '18:00', timezone: TZ },
    }),
  };
  let calls = 0;
  const provider: LLMProviderFunction = async (prompt) => {
    calls += 1;
    if (calls === 1) throw new LLMUnavailableError('timeout');
    return renderRefModelAnswer(rebased(answered), prompt);
  };
  begin(provider);
  try {
    const uid = uidFor('ChatRealPendingAnswered');
    const first = await (await chatPost(post('/api/mobile/capture/chat', uid, { message: ENGAGEMENTS[0], timezone: TZ, referenceTime: new Date().toISOString() }))).json() as Body;
    const two = await (await chatPost(post('/api/mobile/capture/chat', uid, {
      conversationId: first.conversationId, message: 'الأولى الساعة 4 المسا والتانية 6 المسا', timezone: TZ, referenceTime: new Date().toISOString(),
    }))).json() as Body;
    settled(two.proposal!.items[0], FRIDAY, '16:00', 'the first, answered');
    settled(two.proposal!.items[1], FRIDAY, '18:00', 'the second, answered');
  } finally {
    end();
  }
});

/* ── r11 live Gemini recording, 2026-10-07 ───────────────────────────── */

type LiveRecord = {
  name: string;
  turns: Array<{ message: string; modelAnswers: string[] }>;
};

const LIVE_R11 = JSON.parse(readFileSync(
  new URL('../fixtures/capture-chat-r11-live.json', import.meta.url),
  'utf8',
)) as { records: LiveRecord[] };

function localOf(item: Item): string | null {
  return item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time ?? null : null;
}

function liveItem(body: Body, title: RegExp): Item {
  const found = body.proposal?.items.find((item) => title.test(item.title));
  assert.ok(found, `${title} was not in ${JSON.stringify(body.proposal)}`);
  return found;
}

function assertAsksAmPm(item: Item): void {
  assert.equal(item.resolvedTime, null, JSON.stringify(item));
  assert.equal(item.needsClarification, true, JSON.stringify(item));
  assert.equal(item.clarification?.questionKey, 'ask_am_pm', JSON.stringify(item));
}

for (const record of LIVE_R11.records) test(`live r11: ${record.name}`, async () => {
  const recorded = replayLive(record.turns);
  begin(recorded.provider);
  try {
    const bodies = await conversation(
      `LiveR11-${record.name}`,
      record.turns.map((turn) => turn.message),
      undefined,
      record.turns.map((turn) => turn.modelAnswers.length > 0 ? 'model' : 'rules'),
    );
    assert.equal(recorded.calls(), record.turns.reduce((count, turn) => count + Math.max(1, turn.modelAnswers.length), 0),
      'the fake provider did not replay every recorded model answer or fallback');
    const final = bodies.at(-1)!;
    assert.ok(final.proposal, JSON.stringify(final));

    switch (record.name) {
      case 'D8 ar one phrase two points':
        assert.deepEqual(final.proposal.items.map(localOf), ['20:00', '20:00'], JSON.stringify(final));
        break;
      case 'D8 en move both':
        assert.deepEqual(final.proposal.items.map((item) => item.resolvedDate), [FRIDAY, FRIDAY]);
        assert.deepEqual(final.proposal.items.map(localOf), ['17:00', '18:00']);
        break;
      case 'D8 en call and bill':
        assert.deepEqual(final.proposal.items.map(localOf), ['20:00', '20:00'], JSON.stringify(final));
        break;
      case 'R9-1 ar thought + timed add':
        settled(liveItem(final, /اتصل|أتصل/), TOMORROW, '17:00', record.name);
        assertAsksAmPm(liveItem(final, /خبز/));
        assert.ok(final.proposal.seeds?.some((seed) => /أ?سافر|السفر/.test(seed.summary)), JSON.stringify(final.proposal));
        break;
      case 'R9-1 en thought + timed add':
        // The recorded first turn fell back to the unchanged rules extractor,
        // which merged the call and thought. The later model answer tries to
        // split it using citations from that older turn, so v9 must roll the
        // answer back atomically. Changing that first-turn extraction is
        // explicitly outside this work order.
        settled(liveItem(final, /Call mom.*travel/i), TOMORROW, '17:00', record.name);
        assert.equal(final.proposal.items.some((item) => /bread/i.test(item.title)), false);
        assert.equal(final.proposal.seeds?.length ?? 0, 0);
        assert.match(final.reply, /couldn.t apply|edit it on the card/i);
        break;
      case 'R10-1 en move + untimed add':
        settled(liveItem(final, /Call mom/i), TOMORROW, '20:00', record.name);
        assert.equal(liveItem(final, /bread/i).needsClarification, true);
        break;
      case 'R10-1 ar move + untimed add':
        assertAsksAmPm(liveItem(final, /اتصل|أتصل/));
        assert.equal(liveItem(final, /خبز/).needsClarification, true);
        assert.match(final.reply, /الصبح|المسا/);
        break;
      case 'R10-2 en move + timed add':
        assert.deepEqual(final.proposal.items.map(localOf), ['20:00', '19:00']);
        break;
      case 'ND1 ar remove + add':
        assert.ok(final.proposal.removedItems?.some((item) => /اتصل|أتصل/.test(item.text)), JSON.stringify(final.proposal));
        assert.equal(final.proposal.items.some((item) => /اتصل|أتصل/.test(item.title)), false);
        assert.equal(liveItem(final, /خبز/).needsClarification, true);
        break;
      case 'D3 en forget + add':
        assert.ok(final.proposal.removedItems?.some((item) => /Call mom/i.test(item.text)), JSON.stringify(final.proposal));
        assert.equal(liveItem(final, /bread/i).needsClarification, true);
        break;
      case 'D1 ar commitment to thought':
        settled(liveItem(final, /اتصل|أتصل/), TOMORROW, '17:00', record.name);
        break;
      case 'D2 ar indic digits':
        settled(liveItem(final, /اتصل|أتصل/), TOMORROW, '20:00', record.name);
        break;
      case 'D2 ar proclitic':
        settled(liveItem(final, /اتصل|أتصل/), TOMORROW, '17:00', record.name);
        assertAsksAmPm(liveItem(final, /خبز/));
        break;
      case 'R10-4 en calendar date':
        settled(liveItem(final, /Call the bank/i), '2026-10-20', '10:00', record.name);
        break;
      case 'R10-6 ar range day move': {
        const work = liveItem(final, /شغل/);
        settled(work, weekday('Thursday'), '16:00', record.name);
        assert.equal(work.endTime ? localTimeSpecFor(new Date(work.endTime), TZ)?.time : null, '18:00');
        break;
      }
      case 'R8-2 ar rename + add':
        assert.equal(liveItem(final, /كعك/).needsClarification, true);
        assert.equal(liveItem(final, /ادرس|أدرس/).needsClarification, true);
        break;
      case 'D5 en recurring add': {
        settled(liveItem(final, /Call mom/i), TOMORROW, '17:00', record.name);
        const gym = final.proposal.items.filter((item) => /Gym/i.test(item.title));
        assert.equal(gym.length, 2, JSON.stringify(final.proposal));
        assert.ok(gym.every((item) => localOf(item) === '19:00'));
        break;
      }
      case 'pos ar second one':
        settled(final.proposal.items[0], TOMORROW, '16:00', record.name);
        assertAsksAmPm(final.proposal.items[1]!);
        break;
      case 'D6 ar offered time yes':
        assert.equal(liveItem(final, /البنك/).needsClarification, true);
        break;
      default:
        assert.fail(`missing corrected live expectation: ${record.name}`);
    }
  } finally {
    end();
  }
});
