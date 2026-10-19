/**
 * Jobs this worker is running, for the best-effort requeue on shutdown (DESIGN.md §6.1: `beforeunload`). The real
 * guarantee is the 8-minute lock TTL: a job whose worker dies is re-claimed by the dispatcher.
 */
import type { Db } from '../db.ts';
import { errorFields, type Logger } from '../log.ts';
import { requeueAnalysis } from './store.ts';

export class InFlightJobs {
  private readonly jobs = new Map<string, number>();

  add(analysisId: string, attempt: number): void {
    this.jobs.set(analysisId, attempt);
  }

  remove(analysisId: string, attempt: number): void {
    if (this.jobs.get(analysisId) === attempt) this.jobs.delete(analysisId);
  }

  get size(): number {
    return this.jobs.size;
  }

  entries(): [string, number][] {
    return [...this.jobs.entries()];
  }

  /** Requeues every in-flight job with no delay (fenced: a job finished meanwhile is untouched). */
  async requeueAll(db: Db, log: Logger): Promise<number> {
    let n = 0;
    await Promise.all(
      this.entries().map(async ([id, attempt]) => {
        try {
          if (await requeueAnalysis(db, id, attempt, 0, 'worker_shutdown')) n++;
        } catch (err) {
          log.warn('shutdown requeue failed', { analysisId: id, ...errorFields(err) });
        }
      }),
    );
    if (n) log.warn('requeued in-flight jobs on shutdown', { count: n });
    return n;
  }
}

/** Registers the `beforeunload` handler (edge runtime: fired before the worker is shut down). */
export function installShutdownRequeue(jobs: InFlightJobs, db: Db, log: Logger): void {
  addEventListener('beforeunload', () => {
    if (jobs.size > 0) void jobs.requeueAll(db, log);
  });
}
