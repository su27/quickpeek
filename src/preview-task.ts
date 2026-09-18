/** Deadline is failure handling, never a presentation delay. No listeners survive completion. */
export function previewTask<T>(task: Promise<T>, signal: AbortSignal, timeout = 12000, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => finish(() => reject(new DOMException("Preview cancelled", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error("Preview timed out"))), timeout);
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete();
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(value => {
      if (settled) { disposeLate?.(value); return; }
      finish(() => resolve(value));
    }, error => finish(() => reject(error))).catch(console.warn);
    if (signal.aborted) abort();
  });
}
