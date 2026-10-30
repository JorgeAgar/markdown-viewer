type WorkLane = 'render' | 'diagram' | 'image';
interface WorkJob {
  scope: DocumentWork;
  lane: WorkLane;
  element: HTMLElement;
  valid: () => boolean;
  start: () => void;
  cancel: () => void;
}

/** Pending work belongs to a document; only active documents may start it. */
export class WorkScheduler {
  private jobs: WorkJob[] = [];
  private images = 0;
  private diagrams = 0;
  private scheduled = false;

  document(root: HTMLElement, active = true): DocumentWork {
    return new DocumentWork(this, root, active);
  }

  enqueue<T>(scope: DocumentWork, lane: WorkLane, element: HTMLElement, valid: () => boolean,
    operation: () => T | Promise<T>): Promise<T | undefined> {
    if (scope.disposed || !valid()) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.jobs.push({ scope, lane, element, valid, cancel: () => resolve(undefined), start: () => {
        if (lane === 'image') this.images++;
        if (lane === 'diagram') this.diagrams++;
        // Invoke immediately so synchronous work counts toward the turn's budget.
        let result: T | Promise<T>;
        try { result = operation(); } catch (error) { result = Promise.reject(error); }
        void Promise.resolve(result).then(resolve, reject).finally(() => {
          if (lane === 'image') this.images--;
          if (lane === 'diagram') this.diagrams--;
          this.schedule();
        });
      } });
      this.schedule();
    });
  }

  wake(): void {
    // Also settle canceled jobs while their document is paused or closed.
    this.jobs = this.jobs.filter(job => {
      if (!job.scope.disposed && job.valid()) return true;
      job.cancel();
      return false;
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || !this.jobs.some(job => this.runnable(job))) return;
    this.scheduled = true;
    queueMicrotask(() => this.drain());
  }

  private runnable(job: WorkJob): boolean {
    return job.scope.active && !job.scope.root.hidden && job.scope.root.isConnected
      && (job.lane !== 'image' || this.images < 2)
      && (job.lane !== 'diagram' || this.diagrams < 1);
  }

  private drain(): void {
    const started = performance.now();
    while (true) {
      let next = -1;
      for (let i = 0; i < this.jobs.length; i++) {
        const job = this.jobs[i]!;
        if (!this.runnable(job)) continue;
        if (next === -1) next = i;
        const viewport = job.scope.root.parentElement?.getBoundingClientRect();
        const bounds = job.element.getBoundingClientRect();
        if (bounds.bottom >= (viewport?.top ?? 0) && bounds.top <= (viewport?.bottom ?? window.innerHeight)) {
          next = i;
          break;
        }
      }
      if (next === -1) { this.scheduled = false; return; }
      const job = this.jobs.splice(next, 1)[0]!;
      if (!job.scope.disposed && job.valid()) job.start();
      else job.cancel();
      if (performance.now() - started >= 8) {
        // Yield to input/paint between expensive synchronous blocks.
        setTimeout(() => this.drain(), 0);
        return;
      }
    }
  }
}

export class DocumentWork {
  disposed = false;
  constructor(private readonly scheduler: WorkScheduler, readonly root: HTMLElement, public active = true) {}

  setActive(active: boolean): void {
    this.active = active;
    this.scheduler.wake();
  }

  run<T>(lane: WorkLane, element: HTMLElement, valid: () => boolean, operation: () => T | Promise<T>): Promise<T | undefined> {
    return this.scheduler.enqueue(this, lane, element, valid, operation);
  }

  invalidate(): void { this.scheduler.wake(); }
  dispose(): void { this.disposed = true; this.scheduler.wake(); }
}

export const documentWork = new WorkScheduler();
