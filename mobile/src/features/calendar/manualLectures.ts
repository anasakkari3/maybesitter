/**
 * Lecture times added by hand from a syllabus (UC-3.7, #191 Step 7), seen and
 * removed from Settings → Calendar (QA audit CXA10.3).
 *
 * Each accepted syllabus is one server source of sixteen weeks of busy time.
 * The list is read from `GET /calendar/manual`; a removal is
 * `DELETE /calendar/manual?proposalId=`, after which the list and the Plan's
 * server busy read are refetched, so «الخطة» stops counting it at once.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteManualBusy, listManualBusy } from '../../api/endpoints/calendar';
import { ConflictError, ForbiddenError, ValidationError } from '../../api/errors';
import { useUid } from '../../api/queries';

export function manualBusyKey(uid: string) {
  return ['user', uid, 'calendar', 'manualBusy'] as const;
}

export function useManualBusySources() {
  const uid = useUid();
  return useQuery({
    queryKey: manualBusyKey(uid),
    queryFn: () => listManualBusy({ asUid: uid }),
    enabled: uid !== 'signed-out',
    retry: false,
  });
}

export function useRemoveManualBusy() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) => deleteManualBusy(proposalId, { asUid: uid }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: manualBusyKey(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'calendar', 'serverBusy'] });
    },
  });
}

/** Why «أضف أوقات المحاضرات» was refused, in the person's words (CA10.4). */
export function manualBusyFailureKey(error: unknown): 'syllabusLecturesNeedCalendar' | 'syllabusLecturesLimit' | 'syllabusLecturesTooMany' | 'syllabusLecturesFailed' {
  if (error instanceof ForbiddenError && error.reason === 'calendar_consent_required') return 'syllabusLecturesNeedCalendar';
  // More sessions in one syllabus than one acceptance takes: trying again cannot help.
  if (error instanceof ValidationError && error.reason === 'too_many_sessions') return 'syllabusLecturesTooMany';
  // The manual route's only 409 is the per-account limit.
  if (error instanceof ConflictError) return 'syllabusLecturesLimit';
  return 'syllabusLecturesFailed';
}
