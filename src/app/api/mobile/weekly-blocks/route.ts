import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { parseWeeklyBlockInput } from '../../../../../src/contracts/v1/weeklyBlockContracts';
import { WeeklyBlockValidationError, weeklyBlockValidationResponse } from '../../../../../lib/weeklyBlocks/weeklyBlockApi';
import { createWeeklyBlock, listWeeklyBlocks, presentWeeklyBlock } from '../../../../../lib/weeklyBlocks/weeklyBlockService';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * The weekly fixed blocks this account keeps («ثابت أسبوعي»), paused ones
 * included so the person can resume them. Every path is built from the
 * verified uid; there is no parameter that could name another tree.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const blocks = await listWeeklyBlocks(user.uid);
    return Response.json({ success: true, items: blocks.map(presentWeeklyBlock) });
  } catch (error) {
    console.error('[weekly-blocks] listing failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not read your weekly blocks', 500);
  }
}

/**
 * "Work from 10 until 4 every Saturday", once the person confirmed it.
 *
 * `parseWeeklyBlockInput` refuses a body without `confirmation` and this route
 * does not fill one in: a block exists only because somebody said yes to it.
 * Creating it materializes eight weeks of busy time at once, so the plan built
 * a minute later already keeps the window free.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  try {
    const input = parseWeeklyBlockInput(body);
    const { block } = await createWeeklyBlock(user.uid, input);
    return Response.json({ success: true, block: presentWeeklyBlock(block) }, { status: 201 });
  } catch (error) {
    if (error instanceof WeeklyBlockValidationError) return weeklyBlockValidationResponse(error);
    console.error('[weekly-blocks] create failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not create the weekly block', 500);
  }
}
