'use client';

import { useApp } from '@/context/AppContext';
import { Task } from '@/types';
import {
  AgendaReason,
  getAgendaReason,
  getDailyAgendaItems,
  getLocalIsoDate,
  getNextExpectedAction,
} from '@/utils/agenda';
import { ITEM_STATE_LABELS } from '@/utils/itemState';

const reasonConfig: Record<AgendaReason, { label: string; className: string }> = {
  overdue: {
    label: 'Overdue',
    className: 'bg-red-100 text-red-700 border-red-200',
  },
  due_today: {
    label: 'Due today',
    className: 'bg-gray-100 text-gray-700 border-gray-200',
  },
  reminder_today: {
    label: 'Reminder today',
    className: 'bg-blue-100 text-blue-700 border-blue-200',
  },
};

function getDayOfWeek(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

function getFormattedDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatTiming(task: Task): string {
  const parts: string[] = [];
  if (task.dueDate) parts.push(task.dueDate);
  if (task.reminderTime) parts.push(task.reminderTime);
  return parts.join(' at ');
}

function canActOn(task: Task): boolean {
  return task.state !== 'completed' && task.state !== 'cancelled';
}

export default function DailyDigestModal() {
  const {
    showDigestModal,
    user,
    tasks,
    closeDigestModal,
    confirmDailyDigest,
    acknowledgeItem,
    completeTask,
  } = useApp();

  if (!showDigestModal) return null;

  const now = new Date();
  const today = getLocalIsoDate(now);
  const agendaItems = getDailyAgendaItems(tasks, today);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="border-b border-gray-200 p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Daily agenda</p>
          <h2 className="mt-1 text-2xl font-bold text-gray-900">
            {getGreeting()}, {user?.name?.split(' ')[0] || 'there'}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {getDayOfWeek(now)} - {getFormattedDate(now)}
          </p>
        </div>

        <div className="space-y-4 p-6">
          <p className="text-sm text-gray-600">
            These are the overdue items, items due today, and reminders scheduled for today. Confirming awareness does not mark them completed.
          </p>

          {agendaItems.length > 0 ? (
            <div className="space-y-3">
              {agendaItems.map((task: Task) => {
                const reason = reasonConfig[getAgendaReason(task, today)];
                const canAcknowledge = canActOn(task) && !task.acknowledgedAt;
                const canComplete = canActOn(task);

                return (
                  <div key={task.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${reason.className}`}>
                            {reason.label}
                          </span>
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                            {task.priority}
                          </span>
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                            {ITEM_STATE_LABELS[task.state]}
                          </span>
                        </div>

                        <h3 className="mt-2 text-sm font-bold text-gray-900">{task.title}</h3>
                        {task.description && (
                          <p className="mt-1 text-xs text-gray-500">{task.description}</p>
                        )}
                        <p className="mt-2 text-xs text-gray-500">
                          {formatTiming(task) || 'No scheduled time'} - Next: {getNextExpectedAction(task, today)}
                        </p>
                      </div>

                      <div className="flex flex-col gap-2 sm:w-40">
                        <button
                          onClick={() => acknowledgeItem(task.id)}
                          disabled={!canAcknowledge}
                          className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                            canAcknowledge
                              ? 'bg-green-600 text-white hover:bg-green-700'
                              : 'cursor-not-allowed bg-gray-100 text-gray-400'
                          }`}
                        >
                          Confirm awareness
                        </button>
                        <button
                          onClick={() => completeTask(task.id)}
                          disabled={!canComplete}
                          className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                            canComplete
                              ? 'bg-gray-900 text-white hover:bg-gray-800'
                              : 'cursor-not-allowed bg-gray-100 text-gray-400'
                          }`}
                        >
                          Mark as completed
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 text-center">
              <p className="text-sm font-semibold text-gray-800">No agenda items need awareness today.</p>
              <p className="mt-1 text-xs text-gray-500">Undated captured items stay out of the agenda until they are scheduled.</p>
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <button
              onClick={closeDigestModal}
              className="flex-1 rounded-lg bg-gray-100 px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200"
            >
              Review agenda
            </button>
            <button
              onClick={confirmDailyDigest}
              className="flex-1 rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-green-700"
            >
              Confirm awareness for all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
