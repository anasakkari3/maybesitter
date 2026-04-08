'use client';

import { Task, ItemPriority } from '@/types';
import { useApp } from '@/context/AppContext';
import { ITEM_STATE_LABELS } from '@/utils/itemState';
import {
  AgendaVisualStatus,
  getAgendaVisualStatus,
  getLocalIsoDate,
  getNextExpectedAction,
  isEscalationPendingForUser,
  isOverdueAgendaItem,
} from '@/utils/agenda';
import { getMissedRescheduleSuggestion } from '@/utils/rescheduling';

interface TaskCardProps {
  task: Task;
}

const priorityConfig: Record<ItemPriority, { label: string; badge: string }> = {
  must: {
    label: 'Must',
    badge: 'bg-red-100 text-red-700',
  },
  should: {
    label: 'Should',
    badge: 'bg-orange-100 text-orange-700',
  },
  nice: {
    label: 'Nice',
    badge: 'bg-blue-100 text-blue-700',
  },
};

const visualConfig: Record<AgendaVisualStatus, { card: string; dot: string; badge: string; label: string }> = {
  pending: {
    card: 'border-gray-200 bg-white',
    dot: 'bg-gray-400',
    badge: 'bg-gray-100 text-gray-700',
    label: 'Pending',
  },
  acknowledged: {
    card: 'border-green-200 bg-green-50',
    dot: 'bg-green-500',
    badge: 'bg-green-100 text-green-700',
    label: 'Acknowledged',
  },
  overdue: {
    card: 'border-red-300 bg-red-50',
    dot: 'bg-red-500',
    badge: 'bg-red-100 text-red-700',
    label: 'Overdue',
  },
  escalation_pending: {
    card: 'border-red-400 bg-red-50',
    dot: 'bg-red-600',
    badge: 'bg-red-100 text-red-800',
    label: 'Escalation pending',
  },
  escalated: {
    card: 'border-red-500 bg-red-50',
    dot: 'bg-red-700',
    badge: 'bg-red-100 text-red-900',
    label: 'Escalated',
  },
  completed: {
    card: 'border-gray-200 bg-gray-50',
    dot: 'bg-green-500',
    badge: 'bg-green-100 text-green-700',
    label: 'Completed',
  },
  cancelled: {
    card: 'border-gray-200 bg-gray-50',
    dot: 'bg-gray-300',
    badge: 'bg-gray-100 text-gray-500',
    label: 'Cancelled',
  },
};

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isClosed(task: Task): boolean {
  return task.state === 'completed' || task.state === 'cancelled';
}

export default function TaskCard({ task }: TaskCardProps) {
  const { user, acknowledgeItem, completeTask, updateTask, cancelTask, deleteTask, openEditTask } = useApp();
  const today = getLocalIsoDate();
  const priority = priorityConfig[task.priority];
  const visual = visualConfig[getAgendaVisualStatus(task, today)];
  const overdue = isOverdueAgendaItem(task, today);
  const completed = task.state === 'completed';
  const cancelled = task.state === 'cancelled';
  const closed = isClosed(task);
  const canAcknowledge = !closed && !task.acknowledgedAt;
  const canComplete = !closed;
  const escalationPending = isEscalationPendingForUser(task);
  const escalated = task.state === 'escalated' || task.escalationLevel > 0;
  const canReschedule = task.state === 'missed' || task.state === 'escalation_pending' || task.state === 'escalated';
  const rescheduleSuggestion = canReschedule
    ? getMissedRescheduleSuggestion(task, user?.preferences.reminderTime)
    : null;

  return (
    <div className={`rounded-xl border p-4 shadow-sm transition-shadow hover:shadow-md ${visual.card}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-1 h-3 w-3 flex-shrink-0 rounded-full ${visual.dot}`} aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className={`text-sm font-bold text-gray-900 ${completed ? 'line-through text-gray-500' : ''}`}>
                {task.title}
              </h3>
              {task.description && (
                <p className="mt-1 text-xs text-gray-500">{task.description}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 sm:justify-end">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${priority.badge}`}>
                {priority.label}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${visual.badge}`}>
                {visual.label}
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span>State: {ITEM_STATE_LABELS[task.state]}</span>
            {task.dueDate && (
              <span className={overdue ? 'font-semibold text-red-700' : ''}>
                Due: {overdue ? 'Overdue - ' : ''}{formatDate(task.dueDate)}
              </span>
            )}
            {task.reminderTime && <span>Reminder: {task.reminderTime}</span>}
            {task.roughTiming && <span>Rough timing: {task.roughTiming}</span>}
            {task.acknowledgedAt && <span className="font-semibold text-green-700">Awareness confirmed</span>}
            {escalationPending && <span className="font-semibold text-red-700">Escalation pending</span>}
            {escalated && <span className="font-semibold text-red-800">Escalated</span>}
          </div>

          <p className="mt-2 text-xs font-semibold text-gray-700">
            Next expected action: {getNextExpectedAction(task, today)}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {canAcknowledge ? (
              <button
                onClick={() => acknowledgeItem(task.id)}
                className="rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-green-700"
              >
                Confirm awareness
              </button>
            ) : (
              task.acknowledgedAt ? (
                <span className="rounded-lg bg-green-100 px-3 py-2 text-xs font-semibold text-green-700">
                  Awareness confirmed
                </span>
              ) : (
                !cancelled && (
                  <span className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600">
                    Awareness not confirmed
                  </span>
                )
              )
            )}

            {canComplete && (
              <button
                onClick={() => completeTask(task.id)}
                className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800"
              >
                Mark as completed
              </button>
            )}

            {rescheduleSuggestion && (
              <button
                onClick={() => updateTask(task.id, {
                  dueDate: rescheduleSuggestion.dueDate,
                  reminderTime: rescheduleSuggestion.reminderTime,
                  roughTiming: rescheduleSuggestion.roughTiming,
                })}
                className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-700"
              >
                {rescheduleSuggestion.label}
              </button>
            )}

            <button
              onClick={() => openEditTask(task)}
              className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-50"
            >
              Edit
            </button>

            <button
              onClick={() => (closed ? deleteTask(task.id) : cancelTask(task.id))}
              className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700 ring-1 ring-red-200 transition-colors hover:bg-red-50"
            >
              {closed ? 'Delete' : 'Cancel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
