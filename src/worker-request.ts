/** A one-shot worker owns its input buffer and is terminated on every exit. */
export function workerRequest<T>(worker: Worker, bytes: ArrayBuffer, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = (): void => finish(new DOMException("Preview cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Document processing timed out")), 12000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result);
    worker.onerror = event => finish(new Error(event.message || "Document worker failed"));
    worker.onmessageerror = () => finish(new Error("Invalid document worker result"));
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage(bytes, [bytes]); } catch (error) { finish(error); }
  });
}
