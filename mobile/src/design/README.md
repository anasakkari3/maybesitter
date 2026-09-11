# Design system

One source, two layers, no invented values.

## Where the values come from

`design/` at the repository root is the Claude Design export (OWNER-A4 #138).
It has **no** `:root` block and no CSS custom properties — every colour, size
and duration is an inline literal in the component script. So tokens are
*extracted*, not read:

```bash
node scripts/extract-design-tokens.mjs    # frequency tables + the manifest sha
```

The extraction is recorded in `src/design/tokens.source.json`, which pins
`sourceManifestSha` to the sha256 of `design/EXPORT_MANIFEST.json`.
`src/design/__tests__/tokens.test.ts` fails if:

- the export changes and the pin was not updated (drift), or
- any exported file no longer matches its own manifest hash, or
- a token in `src/theme/tokens.ts` stops matching `tokens.source.json`.

That is the whole point of the pin: after a re-export, the tokens have to be
re-derived deliberately instead of silently diverging from the design.

## The two layers

```ts
import { color, palettes, radius, space, typeScale, motion } from '../theme/tokens';

color.light.textPrimary   // semantic role — use this in new code
p.tx                      // the short alias the nine shipped screens use
```

`color.light` / `color.dark` name the role (`background`, `surface`,
`textPrimary`, `textMuted`, `border`, `brand`, `brandContainer`, `onBrand`,
`must`, `mustContainer`, `hatch`, `overlay`). `palettes` is built *from* those
roles, so the short keys (`bg`, `sf`, `sf2`, `tx`, `mu`, `ln`, `ac`, `acs`,
`wm`, `wms`, …) are aliases of the same strings. Existing screens were not
rewritten: renaming verified UI to gain semantic names would be churn with a
real risk and no user-visible gain.

There is **no** `danger`, `success` or `warning` role. The design has one teal
accent for actions and "done" and one warm sand for "must", and nothing is red
anywhere — the product has no failure state to paint. A role that does not
exist in the design does not get invented here.

## The one deviation from the export

| Token | Export | Here | Why |
|---|---|---|---|
| `color.dark.onBrand` | `#FFFFFF` | `#101416` | White on the dark accent `#6FC3D6` measures **2.01:1**, below the 4.5:1 minimum. Dark ink on the same accent measures **9.22:1**. |

It is recorded in `tokens.source.json` under `deviations`, and the contrast
test asserts both that every shipped pair passes **and** that the export's own
value would fail — so the reason stays visible instead of living in a comment.

Every other pair already passes: light text 16.61:1, light muted 5.11:1, dark
text 16.04:1, dark muted 7.42:1, light on-brand 4.98:1.

## Writing direction

Arabic is the default. The root view sets `direction: 'rtl'`, so layout
mirrors without per-screen code — provided styles never use physical box
offsets. An ESLint rule (error) blocks `marginLeft`, `paddingRight`,
`borderLeftWidth` and friends in `src/`. Symmetric absolute fills
(`left: 0, right: 0`) are allowed, because they mirror trivially.

Times, dates and Latin-only labels inside Arabic text go through `ltr()`, and
digits in tight boxes use `<Txt latin>` — Noto Naskh's tall line box clips
them otherwise.

## Fonts

Outfit (Latin) and Noto Naskh Arabic, both at 400/500/600/700, exactly as the
export loads them. **Neither carries Hebrew glyphs.** A Hebrew face has to be
added before `he` can be offered in the language picker (UC-1.R3 #156).

## What is not here

The component catalogue from the original #155 text (BottomSheet, Dialog,
TextField, SegmentedControl, Skeleton…) is deliberately not built: no shipped
screen renders those. Each one lands with the Phase 2 screen issue that needs
it (#171–#174), against the contract in `COMPONENTS.md`.
