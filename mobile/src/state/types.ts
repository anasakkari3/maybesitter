export type Imp = 'must' | 'should' | 'nice';

// Only four states exist in the product: active, done, rearranged (an active
// item with a new time) and dropped on purpose. There is no "overdue".
export type Status = 'active' | 'done' | 'dropped';

export type Localized = { ar: string; en: string };

export type Commitment = {
  id: string;
  title: Localized;
  day: number; // index into the week that starts Sunday 6 Sept; see seed.ts
  h: number | null;
  m: number;
  dur: number; // minutes
  imp: Imp;
  status: Status;
  locked?: boolean;
};

export type Proposal = {
  id: string;
  title: string;
  day: number;
  h: number | null;
  m: number;
  imp: Imp;
  c: number; // colour index linking the card to its span in the sentence
  needsTime?: boolean;
  ambiguous?: boolean;
  big?: boolean;
};

export type Part = { text: string; c: number };

export type YesterdayItem = { id: string; title: Localized; res: null | 'done' | 'later' };

export type Screen =
  | 'today'
  | 'calendar'
  | 'settings'
  | 'details'
  // One entry for the whole capture flow (UC-2.R2, #172). Review and success
  // are not screens any more: which one shows is derived from the flow's own
  // status, so there is no second place for it to be recorded wrongly.
  | 'capture'
  | 'closeout'
  | 'firstmove'
  // Development only: the design gallery (src/design/Gallery.tsx).
  | 'gallery'
  // Development only, and additionally behind an env flag: the Google Calendar
  // verification demo (src/screens/CalendarDemoScreen.tsx, UC-1.8 #152).
  | 'calendarDemo'
  // Settings → Account → Delete account (UC-1.5 #149).
  | 'deleteAccount'
  // Settings sub-screens (UC-2.R4 #174). Flat rather than nested: `Root` is a
  // switch, and a route tree for seven leaves would be a navigation library
  // this app has deliberately not taken on.
  | 'trust'
  | 'knows'
  | 'feedbackHistory'
  | 'routineSettings'
  | 'notificationsSettings'
  | 'about';

export type CapState = 'idle' | 'listening' | 'transcript' | 'typing' | 'processing' | 'nothing';

/**
 * `rearrange` is gone (UC-2.R3, #173): three of its four choices operated on a
 * duration and a scope the domain does not have, and only ever showed a toast.
 * `postpone` is the transition the actions route actually implements.
 */
export type Sheet =
  | null
  // `clarify` and `readings` were the mock capture flow's sheets. UC-2.5
  // (#165) renders the server's own question against the live proposal, so a
  // second clarify state would be a second thing to wire up by mistake.
  | 'postpone'
  | 'edit'
  | 'confirmDrop'
  | 'confirmDelete'
  | 'toast';

export type ExampleKey = 'doctor' | 'report' | 'sami' | 'study' | 'hi';

export type ThemePref = 'system' | 'light' | 'dark';
