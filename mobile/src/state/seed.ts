import type { Commitment, YesterdayItem } from './types';

// Sample week from the design. Day indexes count from Sunday 6 Sept, so
// 4 = Thursday 10 Sept (today). Replace with /api/mobile/commitments/*.
export const TODAY = 4;

export const seedCommitments: Commitment[] = [
  { id: 'c1', title: { ar: 'مراجعة محاضرة الإحصاء', en: 'Review the statistics lecture' }, day: 4, h: 10, m: 0, dur: 60, imp: 'must', status: 'done', locked: true },
  { id: 'c2', title: { ar: 'مكالمة مع أبو خالد عن الشغل', en: 'Call Abu Khaled about the job' }, day: 4, h: 14, m: 0, dur: 30, imp: 'should', status: 'active', locked: true },
  { id: 'c3', title: { ar: 'تسليم تقرير المشروع', en: 'Hand in the project report' }, day: 4, h: 18, m: 0, dur: 60, imp: 'must', status: 'active', locked: true },
  { id: 'c4', title: { ar: 'أشتري هدية لأمي', en: 'Buy a gift for mom' }, day: 4, h: null, m: 0, dur: 30, imp: 'nice', status: 'active' },
  { id: 'c5', title: { ar: 'محاضرة التسويق', en: 'Marketing lecture' }, day: 5, h: 11, m: 0, dur: 90, imp: 'should', status: 'active' },
  { id: 'c6', title: { ar: 'أدرس للامتحان', en: 'Study for the exam' }, day: 6, h: 17, m: 0, dur: 120, imp: 'must', status: 'active' },
  { id: 'c7', title: { ar: 'غداء مع العيلة', en: 'Lunch with the family' }, day: 6, h: 13, m: 0, dur: 90, imp: 'nice', status: 'active' },
];

export const seedYesterday: YesterdayItem[] = [
  { id: 'y1', title: { ar: 'ألغي اشتراك الجيم', en: 'Cancel the gym subscription' }, res: null },
  { id: 'y2', title: { ar: 'أرسل السيرة لشركة رواد', en: 'Send my CV to Rawad Co.' }, res: null },
];

// Busy blocks from the phone calendar: times only, never titles.
export const seedBusy = [
  { h: 9, m: 0, dur: 150 },
  { h: 15, m: 0, dur: 60 },
  { h: 20, m: 30, dur: 60 },
];

export const NOW = { h: 13, m: 20 };
