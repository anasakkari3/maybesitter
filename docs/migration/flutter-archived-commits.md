# Flutter commits archived, not merged (S0, 2026-09-11)

The launch client is the React Native app in `mobile/`. When the unmerged branch
work was consolidated onto `main` (UC-0.1, #132), commits that changed only the
retired Flutter app were **archived by tag instead of merged**. Their backend
siblings were cherry-picked with `-x`; for the two mixed commits only the
`mobile/` paths were left out.

Nothing here is lost. Every commit stays reachable through its tag:

```
git log archive/2026-09/fix/full-debt-repair
git worktree add /tmp/flutter-ref archive/2026-09/core-value/integration
```

The last complete Flutter app — including the IBM Plex Sans Arabic font work
that was uncommitted at the switch — is `archive/flutter-final` (also tagged
`archive/flutter-font-work`). Each row names the React Native issue that
re-implements the behaviour, as the functional reference for that issue.

## fix/full-debt-repair — tag `archive/2026-09/fix/full-debt-repair`

| Commit | Behaviour | Reproduced in RN by |
|---|---|---|
| `16037e0` | Update, cancel and delete survive an app relaunch | UC-2.R3 (#173) |
| `48c4c5a` | A time edit goes through `update()`, not `postpone()` | UC-2.R3 (#173); client rule `buildTimePatch` from UC-0.2c (#134) |
| `d7ec91b` | Editing the start time carries the commitment's duration | UC-2.R3 (#173) |
| `2df2771` | ARB keys for English strings leaking into the Arabic main flow (not wired) | UC-1.R3 (#156) |
| `7587f37` | The pilot build pins its dart-defines; the default configuration is tested | UC-0.2a (#139) |
| `5ad4e72` (mobile/ part only) | Client time mapping and in-memory repository follow the UTC-read rule | UC-1.R3 (#156) |

## core-value/integration — tag `archive/2026-09/core-value/integration`

| Commit | Behaviour | Reproduced in RN by |
|---|---|---|
| `9240f35` | Publishing a widget snapshot is not counted as a widget impression | UC-3.R1 (#203) |
| `c733a63` | The user is told when their feedback did not send | UC-2.R4 (#174) |
| `a33ad8e` | Analytics honour the consent the participant actually gave | UC-2.R1 (#171) |
| `c04cb05` | The user decides whether the widget names a commitment | UC-3.R1 (#203) |
| `dbc2689` | Withdrawing consent and deleting data reach the device | UC-1.5 (#149), UC-2.R4 (#174) |
| `5de6f58` | Readiness tests for the kill switches and the deletion path | UC-2.R4 (#174) |
| `e8ce61f` | Privacy copy says what the app does, not what the plan hoped | UC-2.R4 (#174) |
| `56ea234` | A disputed split becomes a choice, not a silent pick | UC-2.R2 (#172) |
| `05125d1` | iOS registers the calendar plugin where the app actually starts | UC-3.1 (#185) |
| `aedddf9` (mobile/ part only) | `split_choice.dart` and its test | UC-2.R2 (#172) |
| `959f1fd` | iOS probe for watching a reminder arrive | not in launch (watchOS) |
| `482c35b` | watchOS target and the snapshot that reaches it | not in launch |
| `8dd5893` | Merge of the watchOS target and snapshot bridge | not in launch |
| `07dfc8e` | The watch says why the wrist is empty | not in launch |
| `16fdd50` | The watch target declares its platforms | not in launch |

## core-value/real-capture — tag `archive/2026-09/core-value/real-capture`

| Commit | Behaviour | Reproduced in RN by |
|---|---|---|
| `e4ea03c` | Review shows what the person actually wrote | UC-2.4 (#164) |
| `673936e` | Review corrects date, time and priority, not just the title | UC-2.4 (#164) |
