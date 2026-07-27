import type { LlmRetentionDeletionReport } from "@itotori/db";

export const RETENTION_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type RetentionSchedulerEvent =
  | {
      readonly kind: "retention_scheduler_started";
      readonly at: string;
      readonly intervalMs: number;
    }
  | {
      readonly kind: "retention_deletion_completed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly report: LlmRetentionDeletionReport;
    }
  | {
      readonly kind: "retention_deletion_failed";
      readonly startedAt: string;
      readonly finishedAt: string;
    };

export type RetentionSchedulerSnapshot = {
  readonly started: boolean;
  readonly running: boolean;
  readonly lastEvent: RetentionSchedulerEvent | null;
};

export interface RetentionScheduler {
  start(): void;
  stop(): void;
  snapshot(): RetentionSchedulerSnapshot;
}

type SchedulerTimer = ReturnType<typeof setInterval>;

/** Runs retention once at process startup and at least once each following day.
 * Events intentionally contain lifecycle metadata and aggregate counts only. */
export function createRetentionScheduler(input: {
  readonly deleteExpired: () => Promise<LlmRetentionDeletionReport>;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly observe?: (event: RetentionSchedulerEvent) => void;
}): RetentionScheduler {
  const intervalMs = input.intervalMs ?? RETENTION_SCHEDULER_INTERVAL_MS;
  const now = input.now ?? (() => new Date());
  const observe = input.observe ?? observeRetentionSchedulerEvent;
  let timer: SchedulerTimer | undefined;
  let running = false;
  let lastEvent: RetentionSchedulerEvent | null = null;

  const emit = (event: RetentionSchedulerEvent) => {
    lastEvent = event;
    observe(event);
  };
  const run = async () => {
    if (running) return;
    running = true;
    const startedAt = now().toISOString();
    try {
      const report = await input.deleteExpired();
      emit({
        kind: "retention_deletion_completed",
        startedAt,
        finishedAt: now().toISOString(),
        report,
      });
    } catch {
      emit({
        kind: "retention_deletion_failed",
        startedAt,
        finishedAt: now().toISOString(),
      });
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer !== undefined) return;
      emit({ kind: "retention_scheduler_started", at: now().toISOString(), intervalMs });
      timer = setInterval(() => {
        void run();
      }, intervalMs);
      timer.unref();
      void run();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    snapshot() {
      return { started: timer !== undefined, running, lastEvent };
    },
  };
}

function observeRetentionSchedulerEvent(event: RetentionSchedulerEvent): void {
  console.info(JSON.stringify(event));
}
