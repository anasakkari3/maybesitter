import { createGmailTransport } from '../integrations/gmail/production/gmailTransport';
import { googleAccessToken, requireReadableFeature } from '../integrations/google/googleConnectService';
import type { GoogleRuntime } from '../integrations/google/googleRuntime';
import { analyzeSource } from './analyzeSource';
import { listObservations, type StoredObservation } from './observationStore';

/** A bounded, user-invoked scan of recent mail, including non-commitment signals. */
export async function scanGmailIntelligence(
  uid: string,
  runtime: GoogleRuntime,
): Promise<{ messagesRead: number; observations: StoredObservation[] }> {
  await requireReadableFeature(uid, 'gmail', runtime);
  const transport = createGmailTransport({
    accessToken: () => googleAccessToken(uid, 'gmail', runtime),
    reauth: () => googleAccessToken(uid, 'gmail', runtime, { forceRefresh: true }),
    fetchImpl: runtime.fetchImpl,
  });
  const messages = await transport.listRecentMessages({ query: 'newer_than:7d', maxResults: 10 });
  const seen = new Set((await listObservations(uid, runtime.storage))
    .filter(item => item.source === 'gmail').map(item => item.sourceRef));
  const observations: StoredObservation[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    const text = [message.subject ?? '', message.text].filter(Boolean).join('\n');
    if (!text.trim() || text.length > 12_000) continue;
    observations.push(...await analyzeSource(uid, 'gmail', message.id, text, message.receivedAt,
      runtime.shareModel ? { generate: runtime.shareModel, storage: runtime.storage } : { storage: runtime.storage }));
  }
  return { messagesRead: messages.length, observations };
}
