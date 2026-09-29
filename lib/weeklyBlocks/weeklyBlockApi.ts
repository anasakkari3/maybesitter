/**
 * What the weekly-blocks routes share: the refusal shape. A refusal carries the
 * contract's `code` beside the English message, so the phone branches on the
 * code (it must explain `overnight_not_supported` in the person's language)
 * rather than on a sentence.
 */
import { WeeklyBlockValidationError } from '../../src/contracts/v1/weeklyBlockContracts';

export { WeeklyBlockValidationError };

export function weeklyBlockValidationResponse(error: WeeklyBlockValidationError): Response {
  return Response.json({ success: false, error: error.message, code: error.code }, { status: 400 });
}
