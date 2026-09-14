import { test } from "node:test";
import assert from "node:assert/strict";
import { previewTask } from "../src/preview-task.ts";
test("preview task returns completion and rejects errors", async () => {
  const signal = new AbortController().signal;
  assert.equal(await previewTask(Promise.resolve(7), signal), 7);
  await assert.rejects(previewTask(Promise.reject(new Error("broken")), signal), /broken/);
});
test("cancellation rejects without waiting for native decoding", async () => {
  const abort = new AbortController();
  const promise = previewTask(new Promise(() => {}), abort.signal);
  abort.abort();
  await assert.rejects(promise, { name: "AbortError" });
});
test("pre-cancelled request cannot resolve and a hung task times out", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(previewTask(Promise.resolve(1), abort.signal), { name: "AbortError" });
  await assert.rejects(previewTask(new Promise(() => {}), new AbortController().signal, 10), /超时/);
});
