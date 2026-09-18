import { workerRequest } from "./worker-request";

export function prepareOfficeInput(bytes: ArrayBuffer, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  return workerRequest(new Worker(new URL("./office-input.worker.ts", import.meta.url), { type: "module" }), bytes, signal);
}
