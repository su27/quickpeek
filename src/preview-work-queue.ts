/** Bounds actual work, even when a caller stops waiting for its result. */
export class PreviewWorkQueue {
  private running = 0;
  private pending: Array<{ start(): void; priority(): number }> = [];
  private readonly concurrency: number;
  constructor(concurrency = 1) { this.concurrency = concurrency; }

  run<T>(signal: AbortSignal, work: () => Promise<T>, priority = () => 0): Promise<T> {
    return new Promise((resolve, reject) => {
      const entry = { start: () => start(), priority };
      const abort = (): void => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(new DOMException("Preview cancelled", "AbortError"));
      };
      const start = (): void => {
        if (signal.aborted) { abort(); return; }
        this.running++;
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", abort);
          this.running--;
          // Re-evaluate priorities when the lane becomes available: scrolling
          // can change the desired page while the previous render is running.
          this.pending.sort((a, b) => a.priority() - b.priority());
          this.pending.shift()?.start();
        });
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      if (this.running < this.concurrency) start(); else this.pending.push(entry);
    });
  }
}
