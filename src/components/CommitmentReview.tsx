'use client';

import { useCallback, useEffect, useState } from 'react';

type ReviewItem = {
  id: string;
  title: string;
  status: string;
  kind: string;
  person: string | null;
  priority: string;
  dueAt: string | null;
  remindAt: string | null;
  nextReminderAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ReviewSnapshot = {
  generatedAt: string;
  sections: {
    active: ReviewItem[];
    pendingConfirmations: ReviewItem[];
    overdue: ReviewItem[];
    upcoming: ReviewItem[];
  };
};

const sections: { key: keyof ReviewSnapshot['sections']; title: string }[] = [
  { key: 'active', title: 'Active' },
  { key: 'pendingConfirmations', title: 'Waiting for confirmation' },
  { key: 'overdue', title: 'Overdue' },
  { key: 'upcoming', title: 'Upcoming' },
];

function formatDate(value: string | null): string {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function CommitmentRow({ item }: { item: ReviewItem }) {
  const details = [item.person ? `with ${item.person}` : null, item.priority !== 'normal' ? `${item.priority} priority` : null]
    .filter(Boolean)
    .join(' | ');

  return (
    <li className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-900">{item.title}</p>
          {details && <p className="mt-1 text-xs text-gray-500">{details}</p>}
        </div>
      </div>
      <dl className="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-gray-800">Due</dt>
          <dd>{formatDate(item.dueAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-800">Reminder</dt>
          <dd>{formatDate(item.nextReminderAt || item.remindAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-gray-800">Updated</dt>
          <dd>{formatDate(item.updatedAt)}</dd>
        </div>
      </dl>
    </li>
  );
}

export default function CommitmentReview() {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/commitments/review', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `Request failed with ${response.status}`);
      setSnapshot(body as ReviewSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load commitment state');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('maybesitter:capture-complete', refresh);
    return () => window.removeEventListener('maybesitter:capture-complete', refresh);
  }, [refresh]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Commitment review</h2>
          <p className="mt-1 text-sm text-gray-500">What Maybesitter is currently holding.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700"
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {!error && !snapshot && (
        <p className="mt-4 text-sm text-gray-500">Loading commitment state.</p>
      )}

      {snapshot && (
        <div className="mt-4 space-y-5">
          <p className="text-xs text-gray-500">Snapshot: {formatDate(snapshot.generatedAt)}</p>
          {sections.map((section) => {
            const items = snapshot.sections[section.key];
            return (
              <div key={section.key}>
                <h3 className="text-sm font-semibold text-gray-900">
                  {section.title} ({items.length})
                </h3>
                {items.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {items.map((item) => (
                      <CommitmentRow key={`${section.key}-${item.id}`} item={item} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">
                    None.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
