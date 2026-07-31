# One-next-step product contract

Version 1 uses the complete loop: Capture → Review → one recommendation → concise explanation → user decision.

The proposal is deterministic over ranked, canonical commitment evidence. It presents at most one primary step and exposes accept, edit, defer, dismiss, and done. Empty means no candidates exist; insufficient evidence means candidates exist but a safe explanation cannot be supported. These states are not interchangeable.

Accept, edit, and done produce a confirmation-required decision. They do not write canonical state. Defer and dismiss are recorded without penalty. Model-generated values never become canonical, sensitive attributes are never inferred, and explanations fail closed when they contain command-like or guilt-based wording.

The review component supplies English, Arabic, and Hebrew copy, RTL direction for Arabic and Hebrew, a labelled action group, keyboard-native buttons, and a polite live region. The interaction requires no onboarding.

Migration is additive: import the v1 contract and service without changing existing Capture contracts. Rollback removes the component/service exports; existing capture, confirmation, and commitment review remain unchanged.
