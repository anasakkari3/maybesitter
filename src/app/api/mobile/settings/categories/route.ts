import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  CategoryPreferencesValidationError,
  readCategoryPreferences,
  saveCategoryPreferences,
} from '../../../../../../lib/services/categories/categoryPreferences';
import type { CommitmentCategoryPreferences } from '../../../../../../src/contracts/v1/categoryContracts';

export const dynamic = 'force-dynamic';

function dto(preferences: CommitmentCategoryPreferences) {
  return { enabled: [...preferences.enabled], grouping: preferences.grouping };
}

/** Which categories this account uses, and whether its lists are split (#415). */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const preferences = await readCategoryPreferences(user.uid);
  return Response.json({ success: true, categoryPreferences: dto(preferences) });
}

/**
 * Replaces the preference.
 *
 * A whole preference rather than a patch: `enabled` and `grouping` are read
 * together everywhere they are read at all, and a client that could send half
 * of one would be a client that could turn the split on against an empty set
 * of categories and show the user a filter bar with nothing in it.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const preferences = await saveCategoryPreferences(user.uid, body);
    return Response.json({ success: true, categoryPreferences: dto(preferences) });
  } catch (error) {
    if (error instanceof CategoryPreferencesValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the categories', 500);
  }
}
