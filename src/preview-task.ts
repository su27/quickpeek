/** Deadline is failure handling, never a presentation delay. No listeners survive completion. */
export function previewTask<T>(task: Promise<T>, signal: AbortSignal, timeout = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => finish(() => reject(new DOMException("预览已取消", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error("预览读取超时"))), timeout);
    const finish = (complete: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      complete();
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}
