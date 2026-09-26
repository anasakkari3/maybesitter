# `src/lib/deviceSettings`

The one place in the app that may touch `AsyncStorage`.

`eslint.config.js` forbids it everywhere under `src/api`, `src/features` and
`src/screens` (UC-1.4 #148): commitment titles are the most personal thing this
product holds, neither platform encrypts app storage by default, and the
retired Flutter client's habit of persisting user edits locally must not come
back. Server state belongs in Firestore under the uid, where signing in on a
new device is what brings it back.

The rule's message names this directory as the sanctioned exception, alongside
`src/i18n/language.ts`. Three things live here, and each is admissible for the
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

- **`theme.ts`** — System / Light / Dark (UC-1.R2 #155). Three enum values
  about how a screen looks; it says nothing about what the person committed
  to. It is a *device* fact rather than an account one on purpose: somebody
  may want dark on the phone they read in bed and system on the tablet, and
  the scheme a screen should use is a property of the screen being looked at.

- **`awarenessStore.ts`** and **`hardReceiptQueue.ts`** (UC-3.11 #196,
  UC-3.12a #197) — notification state for this installation: commitment ids,
  instants and a boolean, never a title. The first is "the user said they
  know", the second is "this phone will ring for that Must reminder", waiting
  to be told to the server. Both are keyed by account and cleared on sign-out;
  each header makes the full argument.

- **`actionOutbox.ts`** (UC-3.14 #200) — notification-button taps (Done,
  Later, the body tap) waiting to reach the server: a commitment id, an action,
  an instant and a random `clientActionId`, never a title. It is the one queue
  the client keeps, because a button pressed offline or with the app killed has
  nowhere else to wait; every item is an explicit tap. Keyed by account and
  cleared on sign-out.

- **`calendarBusy.ts`** and **`calendarDevice.ts`** (UC-3.1 #185, UC-3.2
  #186) — busy intervals and calendar/event ids for this phone's calendar;
  `calendarDevice.ts` also keeps which of this phone's calendars the user
  switched off for busy time (ids only). Each header makes the argument.

- **`placeReminders.ts`** (closure CL4) — saved places (a name and a pin) and
  the place reminders this phone is watching. The pins are the one thing the
  server is forbidden to hold, so the phone is their only home; the armed list
  carries the commitment title because a region crossing wakes the app with no
  network to ask. Keyed by account or cleared with it on sign-out and account
  deletion. The header makes the full argument.

Anything new here needs the same argument made in its own header, or it belongs
on the account instead.

- **`healthConnection.ts`** (Health → energy) — whether this installation reads
  Apple Health for this account, and when it last tried: a boolean and one
  instant, keyed by account. The HealthKit grant is a fact about this phone and
  iOS never tells an app a read was refused, so "turned on here" can only be
  remembered here. No sample, score or band is stored: the summary goes to the
  server and is read back from there. Disconnect removes it.
