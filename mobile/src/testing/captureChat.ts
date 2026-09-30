/**
 * A stand-in for `POST /api/mobile/capture/chat`, for screen tests.
 *
 * The composer's every send goes to the capture chat now (owner decision
 * 2026-09-30), so a test that used to hand the screen a proposal from
 * `proposeCapture` hands it the chat's answer carrying that proposal. This
 * builds the answer the way the route does (`captureChatService`):
 *
 *   - no `conversationId` mints one; a known one continues its turns;
 *   - `turns` is the conversation so far plus this message and the reply;
 *   - a proposal with no items, or a refusal, is `proposal: null` — the
 *     route's own `shown()` rule — and the reply says so instead.
 *
 * Use: `jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => proposal()) as never)`.
 * Nothing here imports jest, so it is a plain function any test can call.
 */
import type { CaptureChatAnswer, CaptureChatTurn, CaptureProposal } from '../api/schemas/capture';

/** The rules' reply over a proposal, as `capture.chatRules.json` records it. */
export const CHAT_RULES_REPLY = 'هيك فهمت. شوف القائمة وإذا كلها تمام أكّدها.';
/** A reply over nothing to confirm (a greeting, a question). */
export const CHAT_NOTHING_REPLY = 'شو بدك أسجّلك؟';

export interface ChatServerOptions {
  /**
   * Pass a maybe-only proposal (#519: no items, seeds) through, instead of
   * `null` as today's route does. For the screen's own handling of one the
   * route does not send yet — say so where it is used.
   */
  keepSeedsOnly?: boolean;
  /** The reply for a message (`call` counts from 0); the rules' template when absent. */
  reply?: (message: string, proposal: CaptureProposal | null, call: number) => string;
  engine?: 'model' | 'rules';
}

export function chatServer(
  proposalFor: (message: string, call: number) => unknown,
  options: ChatServerOptions = {},
): (input: { conversationId: string | null; message: string }) => Promise<CaptureChatAnswer> {
  const conversations = new Map<string, CaptureChatTurn[]>();
  let minted = 0;
  let calls = 0;
  return async (input) => {
    const conversationId = input.conversationId ?? `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
    const before = input.conversationId ? conversations.get(input.conversationId) ?? [] : [];
    const call = calls++;
    const raw = (await proposalFor(input.message, call)) as CaptureProposal | null;
    const offers = raw && (raw.items.length > 0 || (options.keepSeedsOnly === true && (raw.seeds?.length ?? 0) > 0));
    const proposal = raw && raw.status !== 'rejected' && offers ? raw : null;
    const reply = options.reply?.(input.message, proposal, call) ?? (proposal ? CHAT_RULES_REPLY : CHAT_NOTHING_REPLY);
    const turns: CaptureChatTurn[] = [...before, { role: 'user', text: input.message }, { role: 'assistant', text: reply }];
    conversations.set(conversationId, turns);
    return { conversationId, reply, engine: options.engine ?? 'rules', proposal, turns };
  };
}
