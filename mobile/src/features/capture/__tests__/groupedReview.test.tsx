/**
 * Grouped review UX for syllabus proposals (UC-3.7, #191 Step 6).
 *
 * Verifies:
 *  1. Grouped sections by kind with section counts.
 *  2. Within each section, items are sorted by date ascending.
 *  3. Page chips rendered on cards from document evidence facts.
 *  4. Confidence >= 0.7 items are selected by default; < 0.7 unselected.
 *  5. Select all and Select none controls.
 *  6. Recurring lecture times banner and acceptance into manual busy blocks.
 *  7. Full Arabic RTL localized rendering.
 */
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { CaptureProvider, useCaptureFlow } from '../CaptureProvider';
import { ReviewScreen } from '../../../screens/ReviewScreen';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import type { CaptureProposal } from '../../../api/schemas/capture';
import type { ShareProposal } from '../../../api/schemas/share';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'syllabus-review-user',
  email: 'student@university.edu',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function createSyllabusProposal(): ShareProposal {
  return {
    version: 'v1',
    proposalId: 'p-syllabus-123',
    status: 'proposed',
    items: [
      {
        itemId: 'assign-2',
        title: 'Project Milestone 2',
        resolvedTime: '2026-10-25T23:59:00.000Z',
        needsClarification: false,
      },
      {
        itemId: 'assign-1',
        title: 'Homework 1',
        resolvedTime: '2026-10-10T23:59:00.000Z',
        needsClarification: false,
      },
      {
        itemId: 'exam-midterm',
        title: 'Midterm Examination',
        resolvedTime: '2026-10-18T10:00:00.000Z',
        needsClarification: false,
      },
      {
        itemId: 'quiz-opt',
        title: 'Optional Reading Quiz',
        resolvedTime: '2026-10-05T14:00:00.000Z',
        needsClarification: false,
      },
    ],
    seeds: [],
    provenance: { requestedEngine: 'model', executedEngine: 'gemini', fallbackUsed: false },
    share: {
      channel: 'pdf',
      kind: 'pdf',
      fileCount: 1,
      totalBytes: 250000,
      ignoredSegments: 0,
      evidenceDropped: false,
      metrics: {},
      suggestedNextAction: null,
      document: {
        documentTitle: 'CS 101 Syllabus',
        courseName: 'Intro to Computer Science',
        recurringSessions: [
          { weekday: 1, start: '10:00', end: '12:00', label: 'Lecture' },
          { weekday: 3, start: '10:00', end: '12:00', label: 'Lecture' },
        ],
      },
      evidence: [
        {
          itemId: 'assign-2',
          sourceIndex: 0,
          excerpt: 'Milestone 2 due Oct 25',
          document: {
            kind: 'assignment',
            page: 4,
            confidence: 0.85,
            dueAt: '2026-10-25T23:59:00.000Z',
            needsClarification: false,
          },
        },
        {
          itemId: 'assign-1',
          sourceIndex: 0,
          excerpt: 'Homework 1 due Oct 10',
          document: {
            kind: 'assignment',
            page: 2,
            confidence: 0.92,
            dueAt: '2026-10-10T23:59:00.000Z',
            needsClarification: false,
          },
        },
        {
          itemId: 'exam-midterm',
          sourceIndex: 0,
          excerpt: 'Midterm Oct 18 in Hall B',
          document: {
            kind: 'exam',
            page: 3,
            confidence: 0.98,
            dueAt: '2026-10-18T10:00:00.000Z',
            needsClarification: false,
          },
        },
        {
          itemId: 'quiz-opt',
          sourceIndex: 0,
          excerpt: 'Optional quiz Oct 5',
          document: {
            kind: 'quiz',
            page: 1,
            confidence: 0.55,
            dueAt: '2026-10-05T14:00:00.000Z',
            needsClarification: false,
          },
        },
      ],
    },
  };
}

function HarnessMount({ proposal }: { proposal: CaptureProposal }) {
  const { adoptProposal } = useCaptureFlow();
  useEffect(() => {
    adoptProposal(proposal, 'share');
  }, [adoptProposal, proposal]);
  return <ReviewScreen />;
}

function renderReview(proposal: ShareProposal = createSyllabusProposal()) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AppProvider>
            <CaptureProvider>
              <HarnessMount proposal={proposal as unknown as CaptureProposal} />
            </CaptureProvider>
          </AppProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');

  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  jest.spyOn(calendarEndpoints, 'postManualBusy').mockResolvedValue({
    success: true,
    sourceId: 'manual-p-syllabus-123',
    blocks: 32,
    windowStart: '2026-09-23T00:00:00.000Z',
    windowEnd: '2027-01-13T00:00:00.000Z',
  } as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('Syllabus grouped review (UC-3.7, #191)', () => {
  it('renders section headers grouped by kind with item counts', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-section-exam')).toBeTruthy();
      expect(screen.getByTestId('review-section-assignment')).toBeTruthy();
      expect(screen.getByTestId('review-section-quiz')).toBeTruthy();
    });

    expect(screen.getByText('Exams (1)')).toBeTruthy();
    expect(screen.getByText('Assignments (2)')).toBeTruthy();
    expect(screen.getByText('Quizzes (1)')).toBeTruthy();
  });

  it('renders page chips on item cards from document evidence', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-page-assign-1')).toBeTruthy();
    });

    expect(screen.getByTestId('review-page-assign-1')).toHaveTextContent('Page 2');
    expect(screen.getByTestId('review-page-assign-2')).toHaveTextContent('Page 4');
    expect(screen.getByTestId('review-page-exam-midterm')).toHaveTextContent('Page 3');
    expect(screen.getByTestId('review-page-quiz-opt')).toHaveTextContent('Page 1');
  });

  it('sorts items inside a section by date ascending', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-item-assign-1')).toBeTruthy();
      expect(screen.getByTestId('review-item-assign-2')).toBeTruthy();
    });

    // In the assignments section, assign-1 (Oct 10) precedes assign-2 (Oct 25)
    const assignmentSection = screen.getByTestId('review-section-assignment');
    const assign1 = screen.getByTestId('review-item-assign-1');
    const assign2 = screen.getByTestId('review-item-assign-2');
    expect(assignmentSection).toContainElement(assign1);
    expect(assignmentSection).toContainElement(assign2);
  });

  it('selects items with confidence >= 0.7 by default and leaves confidence < 0.7 unselected', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-item-assign-1')).toBeTruthy();
    });

    // assign-1 (0.92), assign-2 (0.85), exam-midterm (0.98) should be checked
    expect(screen.getByTestId('review-item-assign-1').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('review-item-assign-2').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('review-item-exam-midterm').props.accessibilityState.checked).toBe(true);

    // quiz-opt (0.55 < 0.70) should NOT be checked
    expect(screen.getByTestId('review-item-quiz-opt').props.accessibilityState.checked).toBe(false);
  });

  it('supports Select all and Select none controls', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-select-all')).toBeTruthy();
      expect(screen.getByTestId('review-select-none')).toBeTruthy();
    });

    // Tap Select all -> all 4 items become checked
    fireEvent.press(screen.getByTestId('review-select-all'));
    await waitFor(() => {
      expect(screen.getByTestId('review-item-quiz-opt').props.accessibilityState.checked).toBe(true);
    });
    expect(screen.getByTestId('review-item-assign-1').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('review-item-assign-2').props.accessibilityState.checked).toBe(true);
    expect(screen.getByTestId('review-item-exam-midterm').props.accessibilityState.checked).toBe(true);

    // Tap Select none -> all items become unchecked
    fireEvent.press(screen.getByTestId('review-select-none'));
    await waitFor(() => {
      expect(screen.getByTestId('review-item-quiz-opt').props.accessibilityState.checked).toBe(false);
    });
    expect(screen.getByTestId('review-item-assign-1').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('review-item-assign-2').props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('review-item-exam-midterm').props.accessibilityState.checked).toBe(false);
  });

  it('offers recurring lecture times prompt and saves them via postManualBusy', async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-lecture-times-banner')).toBeTruthy();
      expect(screen.getByTestId('review-add-lecture-times')).toBeTruthy();
    });

    expect(screen.getByText('Add lecture times as busy time?')).toBeTruthy();

    fireEvent.press(screen.getByTestId('review-add-lecture-times'));

    await waitFor(() => {
      expect(calendarEndpoints.postManualBusy).toHaveBeenCalledWith({
        proposalId: 'p-syllabus-123',
        sessions: [
          { weekday: 1, start: '10:00', end: '12:00', label: 'Lecture' },
          { weekday: 3, start: '10:00', end: '12:00', label: 'Lecture' },
        ],
        timezone: expect.any(String),
      });
      expect(screen.getByTestId('review-lecture-times-added')).toBeTruthy();
      expect(screen.getByText('Lecture times added as busy time')).toBeTruthy();
    });
  });

  it('renders localized copy in Arabic (ar) with RTL orientation', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId('review-section-exam')).toBeTruthy();
    });

    // Check Arabic section titles and counts
    expect(screen.getByText('امتحانات (1)')).toBeTruthy();
    expect(screen.getByText('واجبات (2)')).toBeTruthy();
    expect(screen.getByText('كويزات (1)')).toBeTruthy();

    // Check Arabic page chips: ص {page}
    expect(screen.getByTestId('review-page-assign-1')).toHaveTextContent('ص 2');
    expect(screen.getByTestId('review-page-exam-midterm')).toHaveTextContent('ص 3');

    // Check Arabic select all / select none controls
    expect(screen.getByText('تحديد الكل')).toBeTruthy();
    expect(screen.getByText('إلغاء التحديد')).toBeTruthy();

    // Check Arabic lecture times prompt
    expect(screen.getByText('نضيف أوقات المحاضرات كوقت مشغول؟')).toBeTruthy();
    expect(screen.getByText('ضيف المحاضرات')).toBeTruthy();
  });
});
