'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import Navbar from '@/components/Navbar';
import { Task } from '@/types';
import { isActiveState } from '@/utils/itemState';
import { developerPagesEnabled } from '@/utils/developerPages';

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function AnalyticsPage() {
  const { tasks, isAuthenticated } = useApp();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && (!isAuthenticated || !developerPagesEnabled)) {
      router.replace('/dashboard');
    }
  }, [mounted, isAuthenticated, router]);

  const analytics = useMemo(() => {
    const now = new Date();
    const weekStart = getWeekStart(now);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    // Tasks completed this week
    const completedThisWeek = tasks.filter((t) => {
      if (t.state !== 'completed' || !t.completedAt) return false;
      const d = new Date(t.completedAt);
      return d >= weekStart && d < weekEnd;
    });

    // Tasks created this week
    const createdThisWeek = tasks.filter((t) => {
      const d = new Date(t.createdAt);
      return d >= weekStart && d < weekEnd;
    });

    const totalTasks = tasks.length;
    const completedAll = tasks.filter((t) => t.state === 'completed').length;
    const completionRate = totalTasks > 0 ? Math.round((completedAll / totalTasks) * 100) : 0;

    // Category breakdown (pending + completed)
    const mustTotal = tasks.filter((t) => t.priority === 'must').length;
    const shouldTotal = tasks.filter((t) => t.priority === 'should').length;
    const niceTotal = tasks.filter((t) => t.priority === 'nice').length;

    const mustDone = tasks.filter((t) => t.priority === 'must' && t.state === 'completed').length;
    const shouldDone = tasks.filter((t) => t.priority === 'should' && t.state === 'completed').length;
    const niceDone = tasks.filter((t) => t.priority === 'nice' && t.state === 'completed').length;

    // Daily breakdown (last 7 days)
    const dailyData: { label: string; date: Date; completed: number; created: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const nextD = new Date(d);
      nextD.setDate(d.getDate() + 1);

      const comp = tasks.filter((t) => {
        if (!t.completedAt) return false;
        const cd = new Date(t.completedAt);
        return cd >= d && cd < nextD;
      }).length;

      const created = tasks.filter((t) => {
        const cd = new Date(t.createdAt);
        return cd >= d && cd < nextD;
      }).length;

      dailyData.push({ label: getDayLabel(d), date: d, completed: comp, created });
    }

    // 4-week chart
    const weeklyData: { label: string; completed: number; created: number }[] = [];
    for (let i = 3; i >= 0; i--) {
      const wStart = new Date(weekStart);
      wStart.setDate(weekStart.getDate() - i * 7);
      const wEnd = new Date(wStart);
      wEnd.setDate(wStart.getDate() + 7);

      const comp = tasks.filter((t) => {
        if (!t.completedAt) return false;
        const d = new Date(t.completedAt);
        return d >= wStart && d < wEnd;
      }).length;

      const created = tasks.filter((t) => {
        const d = new Date(t.createdAt);
        return d >= wStart && d < wEnd;
      }).length;

      weeklyData.push({ label: `${formatShortDate(wStart)}`, completed: comp, created });
    }

    // Streak: consecutive days with at least 1 completion
    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const nextD = new Date(d);
      nextD.setDate(d.getDate() + 1);
      const hasCompletion = tasks.some((t) => {
        if (!t.completedAt) return false;
        const cd = new Date(t.completedAt);
        return cd >= d && cd < nextD;
      });
      if (hasCompletion) streak++;
      else if (i > 0) break;
    }

    // Insights
    const insights: { type: 'good' | 'warning' | 'info'; text: string }[] = [];
    if (mustTotal > 0) {
      const mustRate = Math.round((mustDone / mustTotal) * 100);
      if (mustRate >= 70) {
        insights.push({ type: 'good', text: `You complete ${mustRate}% of Must-Do tasks — great focus on priorities!` });
      } else {
        insights.push({ type: 'warning', text: `Only ${mustRate}% of Must-Do tasks completed. Consider breaking them into smaller steps.` });
      }
    }
    if (niceTotal > mustTotal + shouldTotal && completionRate < 40) {
      insights.push({ type: 'warning', text: `You have more Nice-To-Do tasks than urgent ones. Consider trimming your list.` });
    }
    const activeCount = tasks.filter((t) => isActiveState(t.state)).length;
    if (activeCount > 15 && completionRate < 40) {
      insights.push({ type: 'warning', text: `You may be overcommitting: ${activeCount} active tasks with ${completionRate}% completion rate.` });
    }
    if (streak >= 3) {
      insights.push({ type: 'good', text: `${streak}-day completion streak! You're building momentum.` });
    }
    if (completedThisWeek.length === 0 && totalTasks > 0) {
      insights.push({ type: 'info', text: `No completions this week yet. Start with your smallest Must-Do item.` });
    }
    if (insights.length === 0) {
      insights.push({ type: 'info', text: `Add more tasks and complete them to see personalized insights here.` });
    }

    return {
      completedThisWeek: completedThisWeek.length,
      completionRate,
      createdThisWeek: createdThisWeek.length,
      streak,
      mustTotal, mustDone, shouldTotal, shouldDone, niceTotal, niceDone,
      dailyData, weeklyData, insights,
    };
  }, [tasks]);

  const maxWeekly = Math.max(...analytics.weeklyData.map((w) => w.completed), 1);
  const maxDaily = Math.max(...analytics.dailyData.map((d) => d.completed), 1);

  if (!mounted || !isAuthenticated || !developerPagesEnabled) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-black text-gray-800">Your Patterns &amp; Insights</h1>
          <p className="text-gray-500 mt-1">Track how you&apos;re doing without judgment.</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Completed this week', value: analytics.completedThisWeek, color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-100' },
            { label: 'Completion rate', value: `${analytics.completionRate}%`, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
            { label: 'Created this week', value: analytics.createdThisWeek, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-100' },
            { label: 'Current streak', value: `${analytics.streak}d`, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-100' },
          ].map((stat) => (
            <div key={stat.label} className={`${stat.bg} border ${stat.border} rounded-xl p-4 text-center`}>
              <div className={`text-3xl font-black ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-gray-500 mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Category breakdown */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-5">By Category</h2>
          <div className="space-y-4">
            {[
              { label: 'Must Do', done: analytics.mustDone, total: analytics.mustTotal, barColor: 'bg-red-500', textColor: 'text-red-600' },
              { label: 'Should Do', done: analytics.shouldDone, total: analytics.shouldTotal, barColor: 'bg-orange-500', textColor: 'text-orange-600' },
              { label: 'Nice To Do', done: analytics.niceDone, total: analytics.niceTotal, barColor: 'bg-blue-500', textColor: 'text-blue-600' },
            ].map((cat) => {
              const pct = cat.total > 0 ? Math.round((cat.done / cat.total) * 100) : 0;
              return (
                <div key={cat.label}>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className={`text-sm font-semibold ${cat.textColor}`}>{cat.label}</span>
                    <span className="text-xs text-gray-500">{cat.done} / {cat.total} ({pct}%)</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-3">
                    <div
                      className={`${cat.barColor} h-3 rounded-full transition-all`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Weekly chart */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-5">4-Week Overview</h2>
          <div className="flex items-end gap-4 h-36">
            {analytics.weeklyData.map((week, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-xs font-bold text-gray-600">{week.completed}</span>
                <div className="w-full flex flex-col justify-end" style={{ height: '80px' }}>
                  <div
                    className="w-full bg-blue-500 rounded-t-md transition-all"
                    style={{ height: `${Math.round((week.completed / maxWeekly) * 80)}px`, minHeight: week.completed > 0 ? '4px' : '0' }}
                  />
                </div>
                <span className="text-xs text-gray-400 text-center">{week.label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2 text-center">Completed tasks per week</p>
        </div>

        {/* Daily breakdown table */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Last 7 Days</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-3 font-semibold">Day</th>
                  <th className="pb-3 font-semibold text-right">Completed</th>
                  <th className="pb-3 font-semibold text-right pr-2">Progress</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {analytics.dailyData.map((day, i) => {
                  const isToday = i === analytics.dailyData.length - 1;
                  return (
                    <tr key={i} className={isToday ? 'bg-blue-50/50' : ''}>
                      <td className="py-3 font-medium text-gray-700">
                        {day.label}
                        {isToday && <span className="ml-2 text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full font-semibold">Today</span>}
                      </td>
                      <td className="py-3 text-right font-semibold text-gray-800">{day.completed}</td>
                      <td className="py-3 pr-2">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-20 bg-gray-100 rounded-full h-1.5">
                            <div
                              className="bg-green-500 h-1.5 rounded-full"
                              style={{ width: `${Math.round((day.completed / maxDaily) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Insights */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Insights</h2>
          <div className="space-y-3">
            {analytics.insights.map((insight, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 p-3 rounded-xl ${
                  insight.type === 'good' ? 'bg-green-50 border border-green-100' :
                  insight.type === 'warning' ? 'bg-orange-50 border border-orange-100' :
                  'bg-blue-50 border border-blue-100'
                }`}
              >
                <span className="text-base mt-0.5">
                  {insight.type === 'good' ? '✅' : insight.type === 'warning' ? '⚠️' : 'ℹ️'}
                </span>
                <p className={`text-sm ${
                  insight.type === 'good' ? 'text-green-800' :
                  insight.type === 'warning' ? 'text-orange-800' :
                  'text-blue-800'
                }`}>
                  {insight.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
