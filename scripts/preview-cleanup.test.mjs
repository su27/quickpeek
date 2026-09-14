import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewCleanup, nextPreviewPaint } from "../src/preview-cleanup.ts";

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

test("abort completes the paint barrier even when hidden window frames stop", async () => {
  let id = 0;
  const frames = new Map();
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = frame => frames.delete(frame);
  try {
    const controller = new AbortController();
    const paint = nextPreviewPaint(controller.signal);
    assert.equal(frames.size, 1);
    controller.abort();
    await paint;
    assert.equal(frames.size, 0);
    await nextPreviewPaint(controller.signal);
    assert.equal(frames.size, 0);
    const normal = nextPreviewPaint();
    for (let i = 0; i < 2; i++) {
      const [frame, callback] = frames.entries().next().value;
      frames.delete(frame);
      callback();
    }
    await normal;
    assert.equal(frames.size, 0);
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});
