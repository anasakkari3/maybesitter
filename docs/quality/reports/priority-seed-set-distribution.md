# Priority Seed-Set Distribution

> **SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE**
> These are the commitment pairs an annotator is asked to compare. They carry no verdicts:
> no human judgment has been collected.

Generated: 2026-08-18T21:10:39.774Z
Rubric: `priority-rubric-v1` | Clock: `2026-08-18T09:00:00.000Z`
Pairs: 20 | Locked split: 4 | Calibration: 16
Designed-ambiguous: 4 | Bidirectional strings: 9
Status: **GATE PASSED**

## Distribution: language × load pattern

Each cell shows `pairs · designed-ambiguous · locked`.

| language | light | moderate | heavy | overloaded | total |
|---|---|---|---|---|---|
| `ar` | 1 · 0 · 0 | 2 · 1 · 0 | 1 · 0 · 1 | 1 · 0 · 0 | 5 |
| `he` | 1 · 0 · 0 | 1 · 0 · 0 | 2 · 1 · 0 | 1 · 0 · 1 | 5 |
| `en` | 2 · 1 · 0 | 1 · 0 · 1 | 1 · 0 · 0 | 1 · 0 · 0 | 5 |
| `mixed` | 1 · 0 · 1 | 2 · 1 · 0 | 1 · 0 · 0 | 1 · 0 · 0 | 5 |
| **total** | 5 | 6 | 5 | 4 | 20 |

## Distribution: reason mix

| mix | pairs |
|---|---|
| `overdue\|overdue` | 3 |
| `overdue\|due_soon` | 2 |
| `overdue\|active` | 2 |
| `overdue\|pending` | 1 |
| `due_soon\|due_soon` | 2 |
| `due_soon\|active` | 2 |
| `due_soon\|pending` | 2 |
| `active\|active` | 2 |
| `active\|pending` | 2 |
| `pending\|pending` | 2 |

## Pairs by cell

- `ar` × `light`: `ps-ar-light-01` (mixes: overdue|due_soon)
- `ar` × `moderate`: `ps-ar-moderate-01`, `ps-ar-moderate-02` (mixes: active|pending, active|active)
- `ar` × `heavy`: `ps-ar-heavy-01` (mixes: overdue|overdue)
- `ar` × `overloaded`: `ps-ar-overloaded-01` (mixes: due_soon|pending)
- `he` × `light`: `ps-he-light-01` (mixes: due_soon|active)
- `he` × `moderate`: `ps-he-moderate-01` (mixes: overdue|active)
- `he` × `heavy`: `ps-he-heavy-01`, `ps-he-heavy-02` (mixes: pending|pending, due_soon|due_soon)
- `he` × `overloaded`: `ps-he-overloaded-01` (mixes: overdue|pending)
- `en` × `light`: `ps-en-light-01`, `ps-en-light-02` (mixes: active|active, pending|pending)
- `en` × `moderate`: `ps-en-moderate-01` (mixes: due_soon|due_soon)
- `en` × `heavy`: `ps-en-heavy-01` (mixes: overdue|due_soon)
- `en` × `overloaded`: `ps-en-overloaded-01` (mixes: active|pending)
- `mixed` × `light`: `ps-mixed-light-01` (mixes: due_soon|active)
- `mixed` × `moderate`: `ps-mixed-moderate-01`, `ps-mixed-moderate-02` (mixes: overdue|overdue)
- `mixed` × `heavy`: `ps-mixed-heavy-01` (mixes: due_soon|pending)
- `mixed` × `overloaded`: `ps-mixed-overloaded-01` (mixes: overdue|active)

---
*End of report.*
