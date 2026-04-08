'use client';

import type { ItemPriority, Task } from '@/types';
import {
  getCalendarSortGroup,
  getDailyCalendarItems,
  getLocalIsoDate,
  isOverdueAgendaItem,
} from '@/utils/agenda';

type DailyCalendarProps = {
  tasks: Task[];
};

const priorityConfig: Record<ItemPriority, { label: string; badge: string; marker: string }> = {
  must: {
    label: 'Must',
    badge: 'bg-red-100 text-red-700 ring-red-200',
    marker: 'bg-red-500',
  },
  should: {
    label: 'Should',
    badge: 'bg-orange-100 text-orange-700 ring-orange-200',
    marker: 'bg-orange-500',
  },
  nice: {
    label: 'Nice',
    badge: 'bg-blue-100 text-blue-700 ring-blue-200',
    marker: 'bg-blue-500',
  },
};

function formatCalendarDate(task: Task, today: string): string {
  if (!task.dueDate) return 'No date';
  if (task.dueDate < today) return 'Overdue';
  if (task.dueDate === today) return 'Today';
  return task.dueDate;
}

function formatCalendarTime(task: Task): string {
  if (task.reminderTime) return task.reminderTime;
  return 'No time';
}

export default function DailyCalendar({ tasks }: DailyCalendarProps) {
  const today = getLocalIsoDate();
  const items = getDailyCalendarItems(tasks, today);
  const timedCount = items.filter((item) => getCalendarSortGroup(item) === 'timed').length;
  const untimedCount = items.length - timedCount;

  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Daily calendar</h2>
          <p className="mt-1 text-sm text-gray-500">
            Timed items first. Untimed items are ordered by priority.
          </p>
        </div>
        <div className="flex gap-2 text-xs font-semibold text-gray-500">
          <span>{timedCount} timed</span>
          <span>{untimedCount} prioritized</span>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-200 p-4 text-sm text-gray-500">
          Nothing on today&apos;s calendar yet.
        </p>
      ) : (
        <div className="divide-y divide-gray-100">
          {items.map((task) => {
            const priority = priorityConfig[task.priority];
            const overdue = isOverdueAgendaItem(task, today);
            const untimed = getCalendarSortGroup(task) === 'untimed';

            return (
              <div key={task.id} className="flex gap-3 py-3">
                <div className="w-16 flex-shrink-0 pt-0.5 text-sm font-bold text-gray-900">
                  {formatCalendarTime(task)}
                  {untimed && (
                    <p className="mt-1 text-[11px] font-semibold text-gray-400">priority</p>
                  )}
                </div>
                <div className={`mt-1 h-3 w-3 flex-shrink-0 rounded-full ${priority.marker}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-900">{task.title}</p>
                      {task.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-gray-500">{task.description}</p>
                      )}
                    </div>
                    <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${priority.badge}`}>
                      {priority.label}
                    </span>
                  </div>
                  <p className={`mt-1 text-xs ${overdue ? 'font-semibold text-red-700' : 'text-gray-500'}`}>
                    {formatCalendarDate(task, today)}
                    {untimed ? ' - placed by priority' : ' - placed by time'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
