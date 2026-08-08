# Design System — Maybesitter Mobile

## Source of Truth
The design system was extracted directly from Google Stitch Project **Maybesitter Assistant** (`projects/5784545255932247559`).

## Color System (`SemanticColors`)
Primitive colors map to semantic roles for complete Light and Dark theme support:

| Role | Dark Theme | Light Theme | Description |
| :--- | :--- | :--- | :--- |
| `background` | `#1B1B21` | `#F7F9FB` | Primary scaffold background |
| `surface` | `#25252B` | `#FFFFFF` | Card & container fill |
| `surfaceElevated` | `#303036` | `#F2EFF7` | Elevated headers & badges |
| `brandPrimary` | `#39B8FD` | `#006591` | Electric cyan brand accent & active states |
| `brandSecondary` | `#9EA9FF` | `#333F91` | Indigo AI & clarification accent |
| `mustPriority` | `#BA1A1A` | `#BA1A1A` | Crimson red for MUST priority |
| `shouldPriority` | `#39B8FD` | `#006591` | Cyan for SHOULD priority |
| `nicePriority` | `#F29C06` | `#653E00` | Warm amber for NICE priority |
| `success` | `#10B981` | `#006C49` | Completion & save confirmation |
| `destructive` | `#BA1A1A` | `#BA1A1A` | Delete actions & error states |

## Typography (`AppTextStyles`)
Uses **Manrope** Google Font across both platforms:
- **Display**: 32pt Bold
- **Page Title**: 24pt Bold
- **Section Title**: 18pt W700
- **Card Title**: 16pt W600
- **Body**: 15pt W400
- **Supporting Body**: 14pt W400
- **Label**: 12pt W600
- **Caption**: 11pt W500

## Spacing & Radii
- **Spacing Scale**: `xs: 4`, `sm: 8`, `md: 16`, `lg: 24`, `xl: 32`, `xxl: 48`
- **Corner Radii**: `control: 8`, `card: 16`, `sheet: 24`, `pill: 999`
