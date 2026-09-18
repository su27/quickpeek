import type { PreparedLegacyWorkbook } from "./legacy-excel-layout";
import { workerRequest } from "./worker-request";

export function convertLegacyWorkbook(input: ArrayBuffer, signal: AbortSignal): Promise<PreparedLegacyWorkbook> {
  signal.throwIfAborted();
  return workerRequest(new Worker(new URL("./legacy-excel.worker.ts", import.meta.url), { type: "module" }), input, signal);
}
