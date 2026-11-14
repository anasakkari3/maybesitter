/**
 * Replays the Gmail sender filter over a local JSONL golden set without any
 * provider or model call.
 *
 * Usage:
 *   node --no-warnings --loader ./scripts/ts-resolver.mjs \
 *     scripts/replay-gmail-sender-filter.ts <mails.jsonl|golden.jsonl>
 *
 * The accepted base shape is the one documented by run-email-triage-eval.ts:
 * `{ id, from, subject, body, label }`. File order is arrival order. Optional
 * booleans (`starred`, `sent`, `isReply`) are honoured when a local fixture
 * includes them. Bodies are parsed only to validate the shape; they are never
 * printed and no model sees them.
 */
import { readFileSync } from 'node:fs';
import {
  decide,
  isSenderFilterAuditSample,
  normalizeSenderAddress,
  normalizeSubject,
  senderKey,
  subjectKey,
  type GmailSenderStats,
} from '../lib/intelligence/gmailSenderFilter.ts';
import { isConversationReply } from '../lib/intelligence/emailTriage.ts';

interface GoldenMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly label: 0 | 1 | 'm';
  readonly starred?: boolean;
  readonly sent?: boolean;
  readonly isReply?: boolean;
}

const REPLAY_UID = 'gmail-sender-filter-replay';

function inputPath(): string | undefined {
  const setAt = process.argv.indexOf('--set');
  return setAt >= 0 ? process.argv[setAt + 1] : process.argv[2];
}

function parseMail(line: string, index: number): GoldenMail {
  const value = JSON.parse(line) as Partial<GoldenMail>;
  if (typeof value.id !== 'string' || typeof value.from !== 'string' || typeof value.subject !== 'string'
    || typeof value.body !== 'string' || ![0, 1, 'm'].includes(value.label as never)) {
    throw new Error(`line ${index + 1} does not match { id, from, subject, body, label }`);
  }
  return value as GoldenMail;
}

function emptyStats(key: string, address: string, at: string): GmailSenderStats {
  return {
    v: 1, senderKey: key, fullyRead: 0, produced: 0, skipped: 0,
    subjects: {}, displayAddress: address, repliedTo: false, lastSeenAt: at,
  };
}

function main(): void {
  const path = inputPath();
  if (!path) {
    console.error('usage: replay-gmail-sender-filter.ts <mails.jsonl|golden.jsonl>');
    process.exitCode = 2;
    return;
  }
  const mails = readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(parseMail);
  const stats = new Map<string, GmailSenderStats>();
  const items: Array<{ id: string; label: GoldenMail['label']; action: 'read' | 'skip'; reason: string; audited: boolean }> = [];

  mails.forEach((mail, index) => {
    const address = normalizeSenderAddress(mail.from);
    const key = address ? senderKey(REPLAY_UID, address) : null;
    const normalized = normalizeSubject(mail.subject);
    const subKey = normalized ? subjectKey(REPLAY_UID, normalized) : null;
    const current = key ? stats.get(key) ?? null : null;
    const decision = decide(current, {
      id: mail.id,
      subjectKey: subKey,
      conversationReply: Boolean(mail.isReply) || isConversationReply(mail.subject),
      sentByAccount: Boolean(mail.sent),
      starred: Boolean(mail.starred),
    });
    items.push({ id: mail.id, label: mail.label, action: decision.action, reason: decision.reason, audited: decision.audited });
    if (!key || !address) return;
    const at = new Date(index).toISOString();
    if (decision.action === 'skip') {
      const base = current!;
      const subjects = { ...base.subjects };
      if (subKey && subjects[subKey]) subjects[subKey] = { ...subjects[subKey]!, skipped: subjects[subKey]!.skipped + 1 };
      stats.set(key, { ...base, skipped: base.skipped + 1, subjects, lastSeenAt: at });
      return;
    }
    const produced = mail.label === 1;
    const base = current ?? emptyStats(key, address, at);
    const subjects = { ...base.subjects };
    if (subKey) {
      const subject = subjects[subKey] ?? { fullyRead: 0, produced: 0, skipped: 0 };
      subjects[subKey] = produced
        ? { ...subject, fullyRead: 1, produced: 1 }
        : { ...subject, fullyRead: subject.fullyRead + 1 };
    }
    stats.set(key, {
      ...base,
      fullyRead: produced ? 1 : base.fullyRead + 1,
      produced: produced ? 1 : base.produced,
      subjects,
      lastSeenAt: at,
    });
  });

  const skipped = items.filter(item => item.action === 'skip');
  const missedCommitments = skipped.filter(item => item.label === 1).map(item => item.id);
  console.log(JSON.stringify({
    mails: items.length,
    skipped: skipped.length,
    auditedReads: items.filter(item => item.audited).length,
    labelledCommitments: items.filter(item => item.label === 1).length,
    missedCommitments,
    passed: missedCommitments.length === 0,
    items,
    auditRate: 0.05,
    deterministicAuditCheck: items.every(item => !item.audited || isSenderFilterAuditSample(item.id)),
  }, null, 2));
  if (missedCommitments.length > 0) process.exitCode = 1;
}

try { main(); }
catch (error) {
  console.error(`sender-filter replay failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
