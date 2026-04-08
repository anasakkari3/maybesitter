'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import Navbar from '@/components/Navbar';
import AssistantPanel from '@/components/AssistantPanel';
import DailyCalendar from '@/components/DailyCalendar';
import TaskCard from '@/components/TaskCard';
import TaskModal from '@/components/TaskModal';
import DailyDigestModal from '@/components/DailyDigestModal';
import { Task, ItemPriority } from '@/types';
import { isActiveState } from '@/utils/itemState';
import { getDailyAgendaItems, getLocalIsoDate } from '@/utils/agenda';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

type FilterType = 'all' | ItemPriority;

export default function DashboardPage() {
  const { user, tasks, isAuthenticated, openAddTask, openDigestModal, getTodayDigest, loadSeedData, refreshTasks, currentFilter: rawCurrentFilter, setCurrentFilter } = useApp();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const currentFilter = rawCurrentFilter as FilterType;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && !isAuthenticated) {
      router.push('/dashboard');
    }
  }, [mounted, isAuthenticated, router]);

  useEffect(() => {
    window.addEventListener('maybesitter:capture-complete', refreshTasks);
    return () => window.removeEventListener('maybesitter:capture-complete', refreshTasks);
  }, [refreshTasks]);

  if (!mounted || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const todayDigest = getTodayDigest();
  const today = getLocalIsoDate();
  const agendaCount = getDailyAgendaItems(tasks, today).length;
  const showDigestBanner = user?.preferences.dailyDigestEnabled !== false && !todayDigest?.confirmed && agendaCount > 0;
  const showDemoDataControls = process.env.NODE_ENV !== 'production';

  const activeTasks = tasks.filter((t) => isActiveState(t.state));
  const completedTasks = tasks.filter((t) => t.state === 'completed');

  const mustCount = activeTasks.filter((t) => t.priority === 'must').length;
  const shouldCount = activeTasks.filter((t) => t.priority === 'should').length;
  const niceCount = activeTasks.filter((t) => t.priority === 'nice').length;

  const filteredTasks =
    currentFilter === 'all'
      ? activeTasks
      : activeTasks.filter((t) => t.priority === currentFilter);

  const filterTabs: { value: FilterType; label: string; count: number; color: string; activeColor: string }[] = [
    { value: 'all', label: 'All', count: activeTasks.length, color: 'text-gray-600', activeColor: 'bg-gray-800 text-white' },
    { value: 'must', label: 'Must-Do', count: mustCount, color: 'text-red-600', activeColor: 'bg-red-500 text-white' },
    { value: 'should', label: 'Should-Do', count: shouldCount, color: 'text-orange-600', activeColor: 'bg-orange-500 text-white' },
    { value: 'nice', label: 'Nice-To-Do', count: niceCount, color: 'text-blue-600', activeColor: 'bg-blue-500 text-white' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <TaskModal />
      <DailyDigestModal />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-black text-gray-800">
            {getGreeting()}, {user?.name?.split(' ')[0]}!
          </h1>
          <p className="text-gray-500 mt-1">What matters today?</p>
        </div>

        {/* Daily Digest Banner */}
        {showDigestBanner && (
          <button
            onClick={openDigestModal}
            className="mb-5 flex w-full items-center justify-between rounded-xl border border-green-200 bg-green-50 p-4 text-left shadow-sm transition-colors hover:bg-green-100"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-600 text-sm font-bold text-white">
                {agendaCount}
              </span>
              <div className="text-left">
                <p className="text-sm font-semibold text-green-900">Daily agenda needs awareness confirmation</p>
                <p className="text-xs text-green-800">Overdue, due today, and reminder-today items only</p>
              </div>
            </div>
            <svg className="h-5 w-5 text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        <div className="mb-6">
          <AssistantPanel />
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-white rounded-xl border border-red-100 p-3 text-center shadow-sm">
            <div className="text-2xl font-black text-red-600">{mustCount}</div>
            <div className="text-xs text-gray-500 mt-0.5">Must Do</div>
          </div>
          <div className="bg-white rounded-xl border border-orange-100 p-3 text-center shadow-sm">
            <div className="text-2xl font-black text-orange-600">{shouldCount}</div>
            <div className="text-xs text-gray-500 mt-0.5">Should Do</div>
          </div>
          <div className="bg-white rounded-xl border border-blue-100 p-3 text-center shadow-sm">
            <div className="text-2xl font-black text-blue-600">{niceCount}</div>
            <div className="text-xs text-gray-500 mt-0.5">Nice To Do</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3 text-center shadow-sm">
            <div className="text-2xl font-black text-gray-700">{activeTasks.length}</div>
            <div className="text-xs text-gray-500 mt-0.5">Total</div>
          </div>
        </div>

        <DailyCalendar tasks={activeTasks} />

        {/* Filter + Add Button */}
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 overflow-x-auto flex-shrink-0 min-w-0">
            {filterTabs.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setCurrentFilter(tab.value as 'all' | ItemPriority)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${
                  currentFilter === tab.value
                    ? tab.activeColor
                    : `${tab.color} hover:bg-gray-100`
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                    currentFilter === tab.value ? 'bg-white/20' : 'bg-gray-100'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            onClick={openAddTask}
            className="flex-shrink-0 flex items-center gap-1.5 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Capture item
          </button>
        </div>

        {/* Task List */}
        {filteredTasks.length > 0 ? (
          <div className="space-y-3 mb-8">
            {filteredTasks.map((task: Task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center mb-8">
            <div className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-400">
              Empty
            </div>
            <h3 className="text-lg font-bold text-gray-700 mb-2">
              {tasks.length === 0
                ? "No items yet!"
                : `No ${currentFilter === 'all' ? 'active' : currentFilter} items`}
            </h3>
            <p className="text-gray-500 text-sm mb-4">
              {tasks.length === 0
                ? showDemoDataControls
                  ? "Capture your first item or load demo data to get started."
                  : "Capture your first item to get started."
                : "No active items in this category."}
            </p>
            {tasks.length === 0 && (
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  onClick={openAddTask}
                  className="px-4 py-2 bg-green-500 text-white text-sm font-semibold rounded-lg hover:bg-green-600 transition-colors"
                >
                  Capture first item
                </button>
                {showDemoDataControls && (
                  <button
                    onClick={loadSeedData}
                    className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Load Demo Data
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Completed tasks */}
        {completedTasks.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3 flex items-center gap-2">
              <span className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              Completed ({completedTasks.length})
            </h2>
            <div className="space-y-2">
              {completedTasks.slice(0, 10).map((task: Task) => (
                <TaskCard key={task.id} task={task} />
              ))}
              {completedTasks.length > 10 && (
                <p className="text-xs text-gray-400 text-center py-2">
                  + {completedTasks.length - 10} more completed items
                </p>
              )}
            </div>
          </div>
        )}

        {/* Demo data seed button */}
        {showDemoDataControls && tasks.length > 0 && (
          <div className="mt-8 pt-6 border-t border-gray-200 flex justify-center">
            <button
              onClick={loadSeedData}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Reload demo data
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
