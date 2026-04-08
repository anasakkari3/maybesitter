import { randomUUID } from 'crypto';
import { getDailyAgenda } from '../../lib/services/agendaService';
import type { CommandHandler, NewScheduledJob, SchedulerStore } from './jobRunner';
import { runDueJobs } from './jobRunner';

export const SCHEDULER_TICK_MS = 30 * 1000;

export interface SchedulerLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface SchedulerOptions {
  tickMs?: number;
  logger?: SchedulerLogger | null;
  evaluateAgenda?: boolean;
}

export class Scheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly store: SchedulerStore;
  private readonly handleCommand: CommandHandler;
  private readonly tickMs: number;
  private readonly logger: SchedulerLogger | null;
  private readonly evaluateAgendaOnTick: boolean;

  constructor(
    store: SchedulerStore,
    handleCommand: CommandHandler,
    options: number | SchedulerOptions = SCHEDULER_TICK_MS
  ) {
    this.store = store;
    this.handleCommand = handleCommand;
    this.tickMs = typeof options === 'number' ? options : options.tickMs ?? SCHEDULER_TICK_MS;
    this.logger = typeof options === 'number' ? console : options.logger === undefined ? console : options.logger;
    this.evaluateAgendaOnTick = typeof options === 'number' ? true : options.evaluateAgenda !== false;
  }

  start(): void {
    if (this.interval) return;
    void this.tick();
    this.interval = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runDueJobs(this.store, this.handleCommand, now);
      this.evaluateAgendaHook(now);
    } finally {
      this.running = false;
    }
  }

  private evaluateAgendaHook(now: Date): void {
    if (!this.evaluateAgendaOnTick) return;

    try {
      const agenda = getDailyAgenda({ now });
      const topItem = agenda.items[0];
      const pressureDecision = agenda.pressureCandidate ? `pressureCandidate=${agenda.pressureCandidate.tone}` : 'pressureCandidate=none';
      const topDecision = topItem
        ? `top=${topItem.reason}:${topItem.urgencyScore}:${topItem.title}`
        : 'top=none';
      this.logger?.log(`[scheduler] agenda evaluated items=${agenda.items.length} ${pressureDecision} ${topDecision}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown agenda evaluation failure';
      this.logger?.warn(`[scheduler] agenda evaluation skipped: ${message}`);
    }
  }

  scheduleReminder(reminderId: string, runAt: string, requiresAction = true): void {
    this.store.createJob({
      id: randomUUID(),
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: reminderId,
      runAt,
      payload: { reminderId, requiresAction },
    });
  }

  scheduleEscalation(commitmentId: string, runAt: string): void {
    this.store.createJob({
      id: randomUUID(),
      jobType: 'escalation_check',
      targetType: 'commitment',
      targetId: commitmentId,
      runAt,
      payload: { commitmentId },
    });
  }

  scheduleJob(job: NewScheduledJob): void {
    this.store.createJob(job);
  }
}
