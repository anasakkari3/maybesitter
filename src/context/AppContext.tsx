'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { User, Item, ItemPriority, DailyDigest, ReminderAttempt } from '@/types';
import {
  acknowledgeItem as transitionAcknowledgeItem,
  cancelItem as transitionCancelItem,
  completeItem as transitionCompleteItem,
  deriveScheduledState,
  escalateItem as transitionEscalateItem,
  isTerminalState,
  markMissed as transitionMarkMissed,
  scheduleItem as transitionScheduleItem,
} from '@/utils/itemState';
import { getDailyAgendaItems, getLocalIsoDate } from '@/utils/agenda';
import { REMINDER_ENGINE_INTERVAL_MS } from '@/utils/reminderEngine';
import {
  clearCommitments as clearRemoteCommitments,
  confirmDailyDigest as postDailyDigestConfirmation,
  createCommitment,
  exportAppData,
  fetchAppSnapshot,
  patchCommitment,
  postAppAction,
  postCommitmentAction,
  runReminderScheduler,
  seedDemoData as postSeedDemoData,
} from '@/utils/apiClient';
import type { AppSnapshot } from '@/server/dataStore';

type FilterType = 'all' | ItemPriority;
type ItemInput = Pick<Item, 'title' | 'description' | 'priority' | 'dueDate' | 'reminderTime'> &
  Partial<Pick<Item, 'roughTiming' | 'source'>>;

type LocalReminderAlert = {
  id: string;
  itemId: string;
  idempotencyKey: string;
  title: string;
  body: string;
  type: 'reminder' | 'escalation';
};

interface AppContextType {
  user: User | null;
  tasks: Item[];
  currentFilter: FilterType;
  showTaskModal: boolean;
  showDigestModal: boolean;
  editingTask: Item | null;
  isAuthenticated: boolean;
  setCurrentFilter: (filter: FilterType) => void;
  openAddTask: () => void;
  openEditTask: (task: Item) => void;
  closeTaskModal: () => void;
  openDigestModal: () => void;
  closeDigestModal: () => void;
  addTask: (data: ItemInput) => void;
  updateTask: (taskId: string, updates: Partial<Item>) => void;
  deleteTask: (taskId: string) => void;
  acknowledgeItem: (taskId: string) => void;
  completeTask: (taskId: string) => void;
  markMissed: (taskId: string) => void;
  escalateItem: (taskId: string) => void;
  cancelTask: (taskId: string) => void;
  updateUser: (updates: Partial<User>) => void;
  confirmDailyDigest: () => void;
  getTodayDigest: () => DailyDigest | null;
  loadSeedData: () => void;
  clearTasks: () => void;
  removeAccount: () => void;
  refreshTasks: () => void;
  exportData: () => Promise<string>;
}

const AppContext = createContext<AppContextType | null>(null);

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function isClosed(item: Item | undefined): boolean {
  return !item || item.state === 'completed' || item.state === 'cancelled' || Boolean(item.completedAt);
}

function getAlertText(attempt: ReminderAttempt, item: Item): Pick<LocalReminderAlert, 'title' | 'body' | 'type'> {
  if (attempt.type === 'escalation') {
    return {
      type: 'escalation',
      title: `Maybesitter escalation: ${item.title}`,
      body: 'No acknowledgement came in. Please confirm awareness now.',
    };
  }

  return {
    type: 'reminder',
    title: `Maybesitter reminder: ${item.title}`,
    body: 'Please confirm you are aware of this. Completion can happen later.',
  };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [tasks, setTasksState] = useState<Item[]>([]);
  const [dailyDigests, setDailyDigests] = useState<DailyDigest[]>([]);
  const [reminderAttempts, setReminderAttempts] = useState<ReminderAttempt[]>([]);
  const [currentFilter, setCurrentFilter] = useState<FilterType>('all');
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showDigestModal, setShowDigestModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Item | null>(null);
  const [localAlerts, setLocalAlerts] = useState<LocalReminderAlert[]>([]);
  const [dismissedAlertKeys, setDismissedAlertKeys] = useState<Set<string>>(() => new Set());
  const [mounted, setMounted] = useState(false);
  const tasksRef = useRef<Item[]>([]);
  const browserNotifiedKeys = useRef<Set<string>>(new Set());

  const syncSnapshot = useCallback((snapshot: AppSnapshot) => {
    setUserState(snapshot.user);
    setTasksState(snapshot.items);
    setDailyDigests(snapshot.dailyDigests);
    setReminderAttempts(snapshot.reminderAttempts);
  }, []);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    let stopped = false;
    setMounted(true);
    fetchAppSnapshot()
      .then((snapshot) => {
        if (!stopped) syncSnapshot(snapshot);
      })
      .catch((err) => {
        console.error('Failed to load Maybesitter server state', err);
      });

    return () => {
      stopped = true;
    };
  }, [syncSnapshot]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (user?.preferences?.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [user?.preferences?.theme]);

  useEffect(() => {
    const itemById = new Map(tasks.map((task) => [task.id, task]));
    const nextAlerts = reminderAttempts
      .filter((attempt) => attempt.status === 'sent' && !dismissedAlertKeys.has(attempt.idempotencyKey))
      .map((attempt): LocalReminderAlert | null => {
        const item = itemById.get(attempt.itemId);
        if (!item || isClosed(item) || item.acknowledgedAt) return null;
        return {
          id: attempt.id,
          itemId: attempt.itemId,
          idempotencyKey: attempt.idempotencyKey,
          ...getAlertText(attempt, item),
        };
      })
      .filter((alert): alert is LocalReminderAlert => alert !== null);

    setLocalAlerts(nextAlerts);
  }, [dismissedAlertKeys, reminderAttempts, tasks]);

  useEffect(() => {
    if (!user?.preferences.notificationsEnabled || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    localAlerts.forEach((alert) => {
      if (browserNotifiedKeys.current.has(alert.idempotencyKey)) return;
      browserNotifiedKeys.current.add(alert.idempotencyKey);
      try {
        const notification = new Notification(alert.title, {
          body: alert.body,
          tag: alert.idempotencyKey,
          requireInteraction: alert.type === 'escalation',
        });
        notification.onclick = () => window.focus();
      } catch (err) {
        console.error('Browser notification display failed', err);
      }
    });
  }, [localAlerts, user?.preferences.notificationsEnabled]);

  const isAuthenticated = mounted;

  const commitAction = useCallback(
    async (type: string, payload: Record<string, unknown> = {}) => {
      const snapshot = await postAppAction(type, payload);
      syncSnapshot(snapshot);
      return snapshot;
    },
    [syncSnapshot]
  );

  const refreshTasks = useCallback(() => {
    fetchAppSnapshot()
      .then(syncSnapshot)
      .catch((err) => console.error('Failed to refresh Maybesitter state', err));
  }, [syncSnapshot]);

  const dismissLocalAlert = useCallback((idempotencyKey: string) => {
    setDismissedAlertKeys((prev) => new Set(prev).add(idempotencyKey));
  }, []);

  const updateUser = useCallback(
    (updates: Partial<User>) => {
      if (!user) return;
      const updated = { ...user, ...updates };
      if (updates.preferences) {
        updated.preferences = { ...user.preferences, ...updates.preferences };
      }
      setUserState(updated);
      void commitAction('updateUser', { user: updates }).catch((err) => {
        console.error('Failed to update user', err);
        refreshTasks();
      });
    },
    [commitAction, refreshTasks, user]
  );

  const openAddTask = useCallback(() => {
    setEditingTask(null);
    setShowTaskModal(true);
  }, []);

  const openEditTask = useCallback((task: Item) => {
    setEditingTask(task);
    setShowTaskModal(true);
  }, []);

  const closeTaskModal = useCallback(() => {
    setShowTaskModal(false);
    setEditingTask(null);
  }, []);

  const openDigestModal = useCallback(() => {
    setShowDigestModal(true);
  }, []);

  const closeDigestModal = useCallback(() => {
    setShowDigestModal(false);
  }, []);

  const addTask = useCallback(
    (data: ItemInput) => {
      if (!user) return;
      const now = new Date().toISOString();
      const newTask: Item = {
        ...data,
        id: generateClientId(),
        userId: user.id,
        state: deriveScheduledState(data.dueDate, data.reminderTime),
        acknowledgedAt: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        escalationLevel: 0,
        escalatedAt: null,
        roughTiming: data.roughTiming || '',
        source: data.source || 'manual',
      };
      setTasksState((prev) => [...prev, newTask]);
      void createCommitment(newTask as unknown as Record<string, unknown>).then(syncSnapshot).catch((err) => {
        console.error('Failed to add item', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot, user]
  );

  const updateTask = useCallback(
    (taskId: string, updates: Partial<Item>) => {
      const current = tasksRef.current.find((task) => task.id === taskId);
      if (!current) return;

      const now = new Date().toISOString();
      const shouldReschedule =
        updates.dueDate !== undefined ||
        updates.reminderTime !== undefined;

      let updated: Item;
      try {
        if (shouldReschedule && !isTerminalState(current.state)) {
          updated = transitionScheduleItem(
            { ...current, ...updates, id: current.id, userId: current.userId, state: current.state },
            {
              dueDate: updates.dueDate,
              reminderTime: updates.reminderTime,
              roughTiming: updates.roughTiming,
            }
          );
        } else {
          updated = {
            ...current,
            ...updates,
            id: current.id,
            userId: current.userId,
            state: current.state,
            completedAt: current.completedAt,
            updatedAt: now,
          };
        }
      } catch (err) {
        console.error('Rejected invalid item update', err);
        return;
      }

      setTasksState((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
      void patchCommitment(taskId, updated as unknown as Record<string, unknown>).then(syncSnapshot).catch((err) => {
        console.error('Failed to update item', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      setTasksState((prev) => prev.filter((task) => task.id !== taskId));
      setLocalAlerts((prev) => prev.filter((alert) => alert.itemId !== taskId));
      void postCommitmentAction(taskId, 'cancel').then(syncSnapshot).catch((err) => {
        console.error('Failed to delete item', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const transitionTask = useCallback(
    (taskId: string, transition: (task: Item) => Item) => {
      const current = tasksRef.current.find((task) => task.id === taskId);
      if (!current) return;

      let updated: Item;
      try {
        updated = transition(current);
      } catch (err) {
        console.error('Rejected invalid item transition', err);
        return;
      }

      setTasksState((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
      void patchCommitment(taskId, updated as unknown as Record<string, unknown>).then(syncSnapshot).catch((err) => {
        console.error('Failed to persist item transition', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const acknowledgeItem = useCallback(
    (taskId: string) => {
      const current = tasksRef.current.find((task) => task.id === taskId);
      if (current) {
        try {
          const updated = transitionAcknowledgeItem(current);
          setTasksState((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
        } catch { /* ignore optimistic failure */ }
      }
      setLocalAlerts((prev) => prev.filter((alert) => alert.itemId !== taskId));
      void postCommitmentAction(taskId, 'acknowledge').then(syncSnapshot).catch((err) => {
        console.error('Failed to acknowledge item', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const completeTask = useCallback(
    (taskId: string) => {
      const current = tasksRef.current.find((task) => task.id === taskId);
      if (current) {
        try {
          const updated = transitionCompleteItem(current);
          setTasksState((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
        } catch { /* ignore optimistic failure */ }
      }
      setLocalAlerts((prev) => prev.filter((alert) => alert.itemId !== taskId));
      void postCommitmentAction(taskId, 'complete').then(syncSnapshot).catch((err) => {
        console.error('Failed to complete task', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const markMissed = useCallback(
    (taskId: string) => {
      transitionTask(taskId, transitionMarkMissed);
    },
    [transitionTask]
  );

  const escalateItem = useCallback(
    (taskId: string) => {
      transitionTask(taskId, transitionEscalateItem);
    },
    [transitionTask]
  );

  const cancelTask = useCallback(
    (taskId: string) => {
      const current = tasksRef.current.find((task) => task.id === taskId);
      if (current) {
        try {
          const updated = transitionCancelItem(current);
          setTasksState((prev) => prev.map((task) => (task.id === taskId ? updated : task)));
        } catch { /* ignore optimistic failure */ }
      }
      setLocalAlerts((prev) => prev.filter((alert) => alert.itemId !== taskId));
      void postCommitmentAction(taskId, 'cancel').then(syncSnapshot).catch((err) => {
        console.error('Failed to cancel task', err);
        refreshTasks();
      });
    },
    [refreshTasks, syncSnapshot]
  );

  const getTodayDigest = useCallback((): DailyDigest | null => {
    const today = getLocalIsoDate();
    return dailyDigests.find((digest) => digest.date === today && digest.userId === user?.id) || null;
  }, [dailyDigests, user?.id]);

  const confirmDailyDigest = useCallback(() => {
    if (!user) return;
    const today = getLocalIsoDate();
    const digest: DailyDigest = {
      id: generateClientId(),
      userId: user.id,
      date: today,
      confirmed: true,
      confirmedAt: new Date().toISOString(),
    };

    setShowDigestModal(false);
    void postDailyDigestConfirmation(digest, today).then(syncSnapshot).catch((err) => {
      console.error('Failed to confirm daily digest', err);
      refreshTasks();
    });
  }, [refreshTasks, syncSnapshot, user]);

  const loadSeedData = useCallback(() => {
    void postSeedDemoData().then(syncSnapshot).catch((err) => {
      console.error('Failed to seed demo data', err);
      refreshTasks();
    });
  }, [refreshTasks, syncSnapshot]);

  const clearTasks = useCallback(() => {
    setTasksState([]);
    setReminderAttempts([]);
    setDailyDigests([]);
    void clearRemoteCommitments().then(syncSnapshot).catch((err) => {
      console.error('Failed to clear items', err);
      refreshTasks();
    });
  }, [refreshTasks, syncSnapshot]);

  const removeAccount = useCallback(() => {
    void commitAction('deleteAccount').catch((err) => {
      console.error('Failed to reset single-user data', err);
      refreshTasks();
    });
  }, [commitAction, refreshTasks]);

  const exportData = useCallback(() => exportAppData(), []);

  useEffect(() => {
    if (!user) return;

    let stopped = false;
    let running = false;

    const runEngine = async () => {
      if (running || stopped) return;
      running = true;
      try {
        const snapshot = await runReminderScheduler();
        if (!stopped) syncSnapshot(snapshot);
      } catch (err) {
        console.error('Reminder scheduler poll failed', err);
      } finally {
        running = false;
      }
    };

    void runEngine();
    const intervalId = window.setInterval(runEngine, REMINDER_ENGINE_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [syncSnapshot, user]);

  return (
    <AppContext.Provider
      value={{
        user,
        tasks,
        currentFilter,
        showTaskModal,
        showDigestModal,
        editingTask,
        isAuthenticated,
        setCurrentFilter,
        openAddTask,
        openEditTask,
        closeTaskModal,
        openDigestModal,
        closeDigestModal,
        addTask,
        updateTask,
        deleteTask,
        acknowledgeItem,
        completeTask,
        markMissed,
        escalateItem,
        cancelTask,
        updateUser,
        confirmDailyDigest,
        getTodayDigest,
        loadSeedData,
        clearTasks,
        removeAccount,
        refreshTasks,
        exportData,
      }}
    >
      {children}
      {localAlerts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] w-[min(360px,calc(100vw-2rem))] space-y-3">
          {localAlerts.map((alert) => (
            <div
              key={alert.id}
              className={`rounded-xl border bg-white p-4 shadow-lg ${
                alert.type === 'escalation' ? 'border-red-200' : 'border-blue-200'
              }`}
            >
              <p className="text-sm font-bold text-gray-800">{alert.title}</p>
              <p className="mt-1 text-xs text-gray-600">{alert.body}</p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => {
                    acknowledgeItem(alert.itemId);
                    dismissLocalAlert(alert.idempotencyKey);
                  }}
                  className="rounded-lg bg-green-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-600"
                >
                  Confirm awareness
                </button>
                <button
                  onClick={() => dismissLocalAlert(alert.idempotencyKey)}
                  className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
