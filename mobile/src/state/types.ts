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
  | 'capture'
  | 'review'
  | 'saved'
  | 'closeout'
  | 'firstmove'
  // Development only: the design gallery (src/design/Gallery.tsx).
  | 'gallery';

export type CapState = 'idle' | 'listening' | 'transcript' | 'typing' | 'processing' | 'nothing';

export type Sheet = null | 'clarify' | 'readings' | 'rearrange' | 'toast';

export type ExampleKey = 'doctor' | 'report' | 'sami' | 'study' | 'hi';

export type ThemePref = 'system' | 'light' | 'dark';
