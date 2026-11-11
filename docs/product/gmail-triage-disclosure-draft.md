# Gmail reading and triage — privacy disclosure draft (2026-11-11)

Status: **draft, not published.** The published policy is v1.1
(`site/{en,ar}/privacy.html`, owner-approved 2026-09-25). Publishing a change
to it is the owner's step.

## Why this exists

- The published policy has **no Gmail section at all**. It names Google
  Calendar scopes only. Production keeps Gmail off (`m5a_features=false` in
  `infra/cloudrun/flags.sh`), so nothing published is false today. But the
  Gmail add-on cannot be sold until this section exists. The scopes the code
  asks for are `gmail.readonly`, `gmail.compose` and `gmail.send`.
- The triage stage (`lib/intelligence/emailTriage.ts`) adds one more way mail
  text is used: a short relevance score before the full read.
- Jev is a processor in the United States. It stays off everywhere until
  three things are true:
  1. an endpoint is chosen whose operator signs a DPA with SCCs, either
     TypeSafe AI directly or a gateway such as Vercel, Cloudflare or OpenRouter;
  2. the paragraph below is published;
  3. the golden-set run shows zero lost commitments.

  `tests/infra/firstDeploy.test.ts` keeps `MAYBESITTER_JEV_URL` empty in both
  environments. jevai.org is not a candidate: it is a community site with no
  named operator, terms or privacy policy.

## Draft — English (new section after "Vertex AI Gemini")

> **Gmail (optional add-on)**
> If you connect Gmail, MaybeSitter reads your recent messages to find what you
> committed to: appointments, deadlines, payments, replies you promised. It
> requests `gmail.readonly` to read messages, plus `gmail.compose` and
> `gmail.send` only to send a reply that you confirm yourself.
> Messages first pass simple checks on the sender and headers. Newsletters and
> automated mail are skipped there. For the rest, a short excerpt (sender,
> subject and the first lines) is scored for relevance by Google's Gemini
> through Vertex AI in the EU. Only messages that may contain something for you
> are then read in full by the same model. A small random sample of skipped
> messages is read anyway, to check that nothing was missed.
> Message bodies are not stored on our servers. We store only the commitments
> you confirm, a short quote that shows where each one came from, and
> per-message markers so the same mail is not read twice.
> [Only once Jev is enabled:] The relevance score may instead be computed by
> TypeSafe AI's Jev model in the United States, under a data processing
> agreement with standard contractual clauses. TypeSafe does not train on your
> messages. The excerpt sent is at most the sender, subject and the first 4,000
> characters.
> MaybeSitter's use and transfer of information received from Google APIs will
> adhere to the Google API Services User Data Policy, including the Limited Use
> requirements.

## Draft — Arabic

> **‏Gmail (إضافة اختيارية)**
> إذا ربطت Gmail، يقرأ MaybeSitter رسائلك الأخيرة ليجد ما التزمت به: مواعيد،
> مواعيد تسليم، دفعات، ردود وعدت بها. يطلب صلاحية `gmail.readonly` لقراءة
> الرسائل، و`gmail.compose` و`gmail.send` فقط لإرسال رد تؤكّده أنت بنفسك.
> تمرّ الرسائل أولاً بفحص بسيط للمرسِل والعناوين، فتُتجاوز النشرات والرسائل
> الآلية. أما الباقي، فيُقيَّم مقتطف قصير منه (المرسِل والعنوان وأول الأسطر) عبر
> نموذج Gemini من Google على Vertex AI داخل الاتحاد الأوروبي. ثم يقرأ النموذج
> نفسه كاملةً فقط الرسائل التي قد تخصّك. وتُقرأ عيّنة عشوائية صغيرة من الرسائل
> المتجاوَزة، للتأكد من أن شيئاً لم يفُت.
> لا نخزّن نصوص الرسائل على خوادمنا. نخزّن فقط الالتزامات التي تؤكّدها،
> واقتباساً قصيراً يبيّن من أين جاء كل التزام، وعلامة لكل رسالة حتى لا تُقرأ
> مرتين.
> [فقط بعد تفعيل Jev:] قد يُحسب تقييم الصلة بدلاً من ذلك عبر نموذج Jev من
> TypeSafe AI في الولايات المتحدة، بموجب اتفاقية معالجة بيانات تتضمّن البنود
> التعاقدية القياسية. لا تدرّب TypeSafe نماذجها على رسائلك. لا يتجاوز المقتطف
> المُرسَل المرسِل والعنوان وأول 4,000 حرف.

The Arabic wording needs the same owner or native review that v1.1 had. Hebrew
is still a draft for the whole policy.

## Before publishing, check against the code

- [ ] The bulk and header rules really skip newsletters: `isBulk` in
  `lib/integrations/gmail/production/gmailTransport.ts`.
- [ ] The "short quote" matches what M5a stores: verbatim evidence on the
  proposal.
- [ ] `gmail.send` and `gmail.compose` are still requested. If not, drop them
  from the text.
- [ ] Google OAuth verification for restricted scopes (`gmail.readonly`)
  covers the AI processing described here.
