# MaybeSitter coral continuation · 2026-09-23

The user's explicit 15-screen handoff supersedes the old teal palette. This
continuation extends the existing React Native product; it does not replace its
navigation, backend boundary, language support, or confirmation model.

## Design system

- Charcoal background, quiet translucent cards, fine borders, rounded controls.
- Coral actions and selected navigation; green confirmed/active states; amber
  attention and proposals. Every state retains a text label.
- A reusable SVG folded ribbon mark and wordmark in root headers, product
  leaves, onboarding, sign-in, and capture. Back remains labelled and pinned.
- Shared icon tiles for settings and expansion cards, consistent rounded state
  chips, common review/confirmation patterns, and selected-state accessibility.
- Dark coral button labels use ink, not the reference's insufficient-contrast
  white. Light mode uses a deeper coral for readable text and buttons.
- Text remains uncapped in Arabic, English, and Hebrew. Large-type headers omit
  decorative branding, actions stack, and bottom tabs keep accessible labels.
- Reduce Transparency uses solid cards/bars, with one OS subscription in the
  app provider. Android uses the solid fallback. Existing Reduce Motion remains.

`mobile/src/design/coral.source.json` records the palette and hashes of all 15
reference images. Historical R2 exports stay intact; their integrity checks and
layout/type/motion values remain. The current color checks pin the explicit
continuation and test semantic text pairs at WCAG AA.

## Coverage

| Surface family | Continuation |
| --- | --- |
| Today, week calendar, commitments | Branded headers, selected navigation, coral actions, green completion, glass rows, explicit sort direction |
| Capture, clarification, review, saved | Branded task chrome, shared actions/cards, green saved receipt, existing explicit confirm/undo |
| Details, edit, postpone, drop/delete dialogs | Shared colors, cards, chips, forms, sheets and confirmation controls |
| Daily plan, accepted plan, proposal | Shared cards/actions, amber proposal distinction, green accepted state |
| Settings and all settings leaves | Icon-led grouped rows, brand mark, shared headers, inputs and controls |
| Routine, energy, categories, notifications, widget | Shared scheme, scalable forms, unchanged permissions and persistence |
| Memory, trust, personalization, activity, account | Shared rows/cards/dialogs, existing consent/edit/delete boundaries |
| Sign-in, email auth, onboarding, account deletion | Shared scheme, branded entry/onboarding, existing authentication and recovery |
| Integrations, assistant modes, add/share, goals, habits, PDF, patch, watchers | Same product primitives and honest availability states |
| Empty, loading, error, offline, toast | Shared theme and feedback primitives; no invented data |

## Product honesty

The capability audit in `product-expansion-matrix.md` still applies. Device
calendar permissions, capture/review/confirm, daily planning, memory/consent,
commitments, and watcher management use existing app boundaries. Provider OAuth,
PDF extraction, goal roadmaps, habit execution, plan diffs, preparation and
watcher creation retain their Preview/Coming soon/Beta framing. No fabricated
meetings, provider connection, extracted dates, progress, or notification
receipt was added. No external messages are sent by this work.

## Deliverables and verification

- Figma review board: https://www.figma.com/design/KMHdrXWLCLz3w6wpMRWVmo
- Workspace review gallery and native evidence: `outputs/astra-coral-continuation/`
- Figma contains raster references and native captures, not a claim of an
  editable Figma component library. The reusable design system is implemented
  in the mobile source.
- Full mobile tests, TypeScript, relevant ESLint and native iOS flows are
  recorded in the artifact report. No Android device claim is made.
- The source branch remains unmerged and undeployed.
