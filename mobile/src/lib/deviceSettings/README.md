# `src/lib/deviceSettings`

The one place in the app that may touch `AsyncStorage`.

`eslint.config.js` forbids it everywhere under `src/api`, `src/features` and
`src/screens` (UC-1.4 #148): commitment titles are the most personal thing this
product holds, neither platform encrypts app storage by default, and the
retired Flutter client's habit of persisting user edits locally must not come
back. Server state belongs in Firestore under the uid, where signing in on a
new device is what brings it back.

The rule's message names this directory as the sanctioned exception, alongside
`src/i18n/language.ts`. Two things live here, and both are admissible for the
same reason the language preference is:

- **`onboardingProgress.ts`** — which onboarding step this *install* reached.
  Not content, and not even about the person: it is a fact about this copy of
  the app. A second device onboards again on purpose (see the module header).

- **`routineCache.ts`** — the five coarse survey answers, as an offline copy.
  The canonical home is the account (`users/{uid}.profile.routine`, UC-2.7a
  #167) and the server is what the day is planned from; this exists so the
  survey works on a plane. They are enum choices about sleeping and focus
  hours, not free text, and the user can delete them from Settings, which
  deletes both copies.

Anything new here needs the same argument made in its own header, or it belongs
on the account instead.
