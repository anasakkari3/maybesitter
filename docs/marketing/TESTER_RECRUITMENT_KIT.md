# Tester recruitment kit

Companion to [`docs/release/OWNER_TESTER_RECRUITMENT.md`](../release/OWNER_TESTER_RECRUITMENT.md).
That file owns the rules: the numbers, the roster, consent, reminders and reporting. This
file holds the words and the link conventions.

**Everything here is a draft for the owner to approve and send.** No message has been
sent, and no contact is held in this repository. Arabic was written first. The Hebrew
drafts need a native speaker's pass before use (#335), the same flag as the Hebrew landing
page. Every sentence has been checked against
[`CLAIMS_POLICY.md`](CLAIMS_POLICY.md).

## What the recruitment is for

1. **The Play rule:** at least 12 Android testers opted in for 14 consecutive days. The
   target is 15 Android and 5 iOS, consented by 2026-10-26.
2. **The positioning test:** arm A ("No overdue pile.") against arm B ("Say it once. It
   lands in your day."). Neither has won.
3. **The ICP hypothesis:** do Arabic-speaking students in Israel activate, including
   people who do *not* know the founder? This is a hypothesis to test, not a fact.

Quotas to aim for within the 20: at least 5 Arabic-first, at least 2 Hebrew-first, and at
least 5 who do not know the founder personally.

## Links: the source-code convention

Every link carries a source code and one arm. The page reads both, and both travel with
the sign-up.

```
https://{{DOMAIN}}/ar?v=a&source=ig-story-1006
https://{{DOMAIN}}/?v=b&source=li-founder-1005
https://{{DOMAIN}}/he?v=a&source=union-post-1012
```

- `source` = `<channel>-<placement>-<MMDD>`, lower-case, only `a–z 0–9 - _`, at most 64
  characters. Anything else is recorded as `direct`.
- Channels: `ig` (Instagram), `li` (LinkedIn), `wa` (WhatsApp one-to-one), `wastatus`,
  `union` (a student-union or association post), `table` (a QR code at a physical table),
  `warm` (the survey warm leads), `email`.
- Never put a person's name, an institution's student list, or anything identifying into
  a source code. Institution names are fine only for the organisation's own post, and only
  with its permission.
- **One arm per distribution unit.** A post, a story, a DM batch or a table day gets
  `v=a` *or* `v=b`, never both. Alternate arms on a balanced schedule: same channel, same
  weekday, same time slot, next unit gets the other arm. Keep a private log of which unit
  got which arm. That log is the denominator's partner.
- Denominators come from each platform (link taps, DMs sent). The site counts no one.

Until the domain exists (#137), links cannot be sent. Prepare them; don't send them.

## Screening

The sign-up form already asks four things: email, device, the language they'd use, and
whether they know the founder personally. For the roster, add from their own reply:

| Question | Why |
|---|---|
| Are you 18 or older? | The service is not directed at under-18s (privacy policy, "Age") |
| Do you study, work, or both? | The ICP hypothesis is people who do both |
| Where do you keep things you've promised to do today? (notes, messages to yourself, paper, calendar, a task app, memory) | The real alternative we are measured against |
| Have you tried a task or planner app and stopped using it? | Switching history, for the interviews |

**Outside-network rule:** a tester counts as outside the network if they answered "no"
to "Do you know the founder personally?" **and** were not recruited through the founder's
personal contacts (`wa`, `warm`). Report the two counts separately. A sample made
entirely of friends cannot test the ICP hypothesis.

Do not screen on diagnosis, health, religion or anything sensitive, and do not ask about
ADHD. People self-select through the message.

## Consent

The three existing consent points in `OWNER_TESTER_RECRUITMENT.md` stand as they are.

> **BLOCKED ON COUNSEL (X9, option C).** A fourth point is needed to measure usage of
> the pre-release build for the closed test. Its wording, and how it relates to the
> in-app analytics setting, must be approved by counsel before it is used. Until then:
> **do not add research-measurement wording to any invitation, and do not treat any
> tester's reply as consent to measurement.** The placeholder text lives in
> `OWNER_TESTER_RECRUITMENT.md`, clearly marked, and is not final.

---

## 1. Invitation: warm contact (friend, classmate, colleague)

Channel `wa` or `email`. One-to-one only. Never paste it into a group.

### Arabic (lead)

**Arm A**

> بتجرّب MaybeSitter أسبوعين؟
>
> عم بعمل MaybeSitter، مخطِّط وتذكيرات هادي بالعربي والعبري والإنجليزي. ما في كومة «متأخّر»:
> كل إشي يا بيخلص، يا بيتأجّل، يا بينلغى بقصد منك.
>
> بدّي مجموعة صغيرة تستعمله ١٤ يوم ورا بعض. هاد كل الطلب: تنزّله، تخلّيه على تلفونك، وتستعمله
> لمّا ينفعك. ما في إشي تعبّيه.
>
> إشيين لازم تعرفهم قبل ما توافق: لسّا بالأول، فرح يصير في أعطال. وعلى أندرويد رح أحتاج إيميل
> حساب جوجل اللي على تلفونك، لأنه هيك جوجل بتعطي صلاحية الدخول، وما رح أستعمله لإشي تاني.
>
> مجاني، لعمر ١٨ وفوق، وبتقدر توقف بأي وقت وما رح أسألك ليش. وإذا مش حابب، عادي كتير.
>
> للتسجيل: {link}

**Arm B**: same message. Replace the second paragraph with:

> عم بعمل MaybeSitter، مخطِّط وتذكيرات هادي بالعربي والعبري والإنجليزي. احكيها مرّة، وبتلاقيها
> بيومك: بتكتب شو التزمت فيه متل ما بتحكيه، بتأكّده، وبيظهر بيومك.

### English

**Arm A**

> Would you try MaybeSitter for two weeks?
>
> I'm building MaybeSitter, a calm planner and reminders app in Arabic, Hebrew and
> English. No overdue pile: things are done, moved, or dropped on purpose.
>
> I need a small group to use it for 14 days in a row. That's the whole ask: install it,
> keep it on your phone, and use it when it's useful. There's nothing to fill in.
>
> Two things to know before saying yes. It's early, so things will break. And on Android
> I'll need the Google account email on your phone, because that's how Google grants
> access. I'll use it for nothing else.
>
> It's free, it's for people 18 and over, and you can stop any time without explaining.
> If you'd rather not, that's genuinely fine.
>
> Sign up here: {link}

**Arm B**: replace the second paragraph with:

> I'm building MaybeSitter, a calm planner and reminders app in Arabic, Hebrew and
> English. Say it once, it lands in your day: you type what you committed to the way
> you'd say it, confirm it, and it shows up in your day.

### Hebrew (native review required, #335)

Written so it doesn't assume the gender of the reader or the founder.

**Arm A**

> רוצה לנסות את MaybeSitter לשבועיים?
>
> MaybeSitter היא אפליקציית תכנון ותזכורות רגועה בעברית, בערבית ובאנגלית. בלי ערימת «באיחור»:
> כל דבר מסתיים, נדחה, או שמוותרים עליו בכוונה.
>
> נדרשת קבוצה קטנה שתשתמש בה 14 ימים ברצף. זו כל הבקשה: להתקין, להשאיר בטלפון ולהשתמש כשזה
> עוזר. אין מה למלא.
>
> שני דברים שכדאי לדעת לפני שמסכימים: זה עוד מוקדם, אז דברים יישברו. ובאנדרואיד תידרש כתובת
> חשבון הגוגל שבטלפון, כי כך גוגל נותנת גישה, והיא תשמש רק לזה.
>
> חינם, מגיל 18 ומעלה, ואפשר להפסיק בכל רגע בלי להסביר. ואם לא מתאים, באמת בסדר גמור.
>
> להרשמה: {link}

**Arm B**: replace the second paragraph with:

> MaybeSitter היא אפליקציית תכנון ותזכורות רגועה בעברית, בערבית ובאנגלית. אומרים פעם אחת, וזה
> נכנס ליום: כותבים את מה שהתחייבתם אליו כמו שמדברים, מאשרים, וזה מופיע ביום.

---

## 2. Warm leads: survey respondents who agreed to be contacted

Eight survey respondents left an email and agreed to a 15-minute interview. Contacting
them about **the test** is a new request. Say so, ask, and accept silence as a no.
Channel `warm`. Send once. Silence means no: no follow-up, as the message itself promises.

### Arabic (lead)

> مرحبا، جاوبت قبل كم أسبوع على استبيان عن الالتزامات اليومية، وحكيت إنه منقدر نتواصل معك
> لمقابلة قصيرة. شكراً إلك.
>
> صار في نسخة تجريبية من التطبيق اللي طلع من هالبحث، MaybeSitter. بتحب تجرّبه ١٤ يوم؟ مجاني،
> وبتقدر توقف بأي وقت. [then the arm A or arm B line from §1]
>
> إذا لأ، ما في داعي ترد، وما رح نرجع نبعتلك.
>
> للتسجيل: {link}

### English

> Hi, a few weeks ago you answered a survey about everyday commitments and said we could
> contact you for a short interview. Thank you.
>
> There's now a test version of the app that came out of that research, MaybeSitter.
> Would you try it for 14 days? It's free and you can stop any time.
> [then the arm A or arm B line from §1]
>
> If not, no need to reply, and we won't write again.
>
> Sign up here: {link}

### Hebrew (native review required)

> שלום, לפני כמה שבועות נעניתם לסקר על התחייבויות יומיומיות ואישרתם שאפשר לפנות לראיון קצר.
> תודה על כך.
>
> עכשיו יש גרסת ניסיון של האפליקציה שנולדה מהמחקר הזה, MaybeSitter. מתאים לנסות אותה 14 ימים?
> זה בחינם ואפשר להפסיק בכל רגע. [then the arm A or arm B line from §1]
>
> אם לא, אין צורך להשיב, ולא נפנה שוב.
>
> להרשמה: {link}

---

## 3. Student-union and association outreach (to the admin, not to members)

Channel `union`. Always ask the admin first, disclose that you are the founder, ask for
**one** post or a table, and offer nothing tied to reviews or ratings. If they say no,
that's the end of it.

### Arabic (lead)

> مرحبا، أنا [الاسم]، مؤسّس/ة MaybeSitter. هو مخطِّط وتذكيرات هادي بالعربي والعبري والإنجليزي،
> لسّا بمرحلة التجربة.
>
> عم بدوّر على طلاب، عمر ١٨ وفوق، يجرّبوه ١٤ يوم قبل ما ينزل على المتاجر بإسرائيل. بتسمحولي
> أنشر بوست واحد بالمجموعة/الصفحة، أو أحط طاولة صغيرة بأسبوع الاستقبال؟ النص جاهز وببعته
> قبل للموافقة.
>
> التجربة مجانية، ما في إلزام، وما بنطلب تقييمات. بحترم أي جواب.

### English

> Hi, I'm [name], the founder of MaybeSitter, a calm planner and reminders app in Arabic,
> Hebrew and English that's still in testing.
>
> I'm looking for students, 18 and over, to try it for 14 days before it reaches the
> stores in Israel. Could I share one post with your group or page, or set up a small
> table during welcome week? I'll send the exact text for your approval first.
>
> The test is free, there's no obligation, and we don't ask for ratings. Any answer is
> fine.

### Hebrew (native review required)

> שלום, כאן [שם], מייסד/ת MaybeSitter, אפליקציית תכנון ותזכורות רגועה בעברית, בערבית ובאנגלית,
> שעדיין בשלב ניסוי.
>
> אנחנו מחפשים סטודנטים וסטודנטיות מגיל 18 ומעלה שינסו אותה 14 ימים לפני שהיא תגיע לחנויות
> בישראל. אפשר לפרסם פוסט אחד בקבוצה או בעמוד, או להציב שולחן קטן בשבוע הקליטה? הנוסח המלא יישלח
> לאישור מראש.
>
> הניסוי חינמי, בלי התחייבות, ואנחנו לא מבקשים דירוגים. כל תשובה בסדר.

## 4. Public post / story copy (short)

For a post an organisation has approved, or the founder's own accounts. One arm per post.

| Language | Arm A | Arm B |
|---|---|---|
| Arabic | ما في كومة «متأخّر». مخطِّط وتذكيرات هادي، وعم ندوّر على ناس يجرّبوه ١٤ يوم (١٨+). مجاني. {link} | احكيها مرّة، وبتلاقيها بيومك. مخطِّط وتذكيرات هادي، وعم ندوّر على ناس يجرّبوه ١٤ يوم (١٨+). مجاني. {link} |
| English | No overdue pile. A calm planner and reminders app, looking for people to try it for 14 days (18+). Free. {link} | Say it once. It lands in your day. A calm planner and reminders app, looking for people to try it for 14 days (18+). Free. {link} |
| Hebrew (review) | בלי ערימת «באיחור». אפליקציית תכנון ותזכורות רגועה מחפשת אנשים שינסו אותה 14 ימים (18+). חינם. {link} | אומרים פעם אחת, וזה נכנס ליום. אפליקציית תכנון ותזכורות רגועה מחפשת אנשים שינסו אותה 14 ימים (18+). חינם. {link} |

## Never

- Never send an invitation to a group chat or a mailing list you don't own.
- Never offer a reward for a rating or a review. After the public launch, testers may be
  asked once for an honest review, with no script and no incentive.
- Never describe voice, dialect understanding, calendars, email, goals or anything else
  the claims policy qualifies or forbids.
- Never mention ADHD, diagnosis or health.
- Never use the $5,000 funding unless the program's terms allow it, it is named
  accurately, and it isn't presented as traction (X14).
