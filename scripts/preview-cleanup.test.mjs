import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewCleanup } from "../src/preview-cleanup.ts";

test("cleanup acknowledgement waits for every staging preview to release", async () => {
  const cleanup = new PreviewCleanup();
  const finish1 = cleanup.begin();
  const finish2 = cleanup.begin();
  let acknowledged = false;
  const drained = cleanup.drained().then(() => { acknowledged = true; });
  finish1();
  await Promise.resolve();
  assert.equal(acknowledged, false);
  finish2();
  await drained;
  assert.equal(acknowledged, true);
  finish2(); // idempotent
  await cleanup.drained();
});

test("an old close does not wait for a new preview's work", async () => {
  const cleanup = new PreviewCleanup();
  const finishOld = cleanup.begin();
  const drained = cleanup.drained();
  const finishNew = cleanup.begin();
  finishOld();
  await drained;
  finishNew();
});
