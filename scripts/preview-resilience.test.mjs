import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { previewTask } from '../src/preview-task.ts';
import { PreviewWorkQueue } from '../src/preview-work-queue.ts';
import { validateOfficeDirectory } from '../src/office-limits.ts';
import { workerRequest } from '../src/worker-request.ts';

test('worker cancellation and failed transfers always terminate the worker', async () => {
  for (const badTransfer of [false, true]) {
    let terminated = 0;
    const worker = { terminate() { terminated++; }, postMessage() { if (badTransfer) throw Error('transfer failed'); } };
    const controller = new AbortController();
    const work = workerRequest(worker, new ArrayBuffer(0), controller.signal);
    if (!badTransfer) controller.abort();
    await assert.rejects(work);
    worker.onmessage({ data: { result: 'late result' } });
    assert.equal(terminated, 1);
  }
});

test('cancelled and timed out work disposes a late result exactly once', async () => {
  for (const cancel of [true, false]) {
    let finish; let disposed = 0;
    const controller = new AbortController();
    const result = previewTask(new Promise(resolve => { finish = resolve; }), controller.signal, 5, () => disposed++);
    if (cancel) controller.abort();
    await assert.rejects(result);
    finish({});
    await Promise.resolve();
    controller.abort();
    assert.equal(disposed, 1);
  }
});

test('native work remains bounded and cancelled queued work never starts', async () => {
  const queue = new PreviewWorkQueue();
  let finish;
  const live = new AbortController(), stale = new AbortController();
  const first = queue.run(live.signal, () => new Promise(resolve => { finish = resolve; }));
  let started = 0;
  const second = queue.run(stale.signal, async () => { started++; });
  const third = queue.run(live.signal, async () => { started++; return 'latest'; });
  stale.abort();
  await assert.rejects(second);
  assert.equal(started, 0);
  finish();
  await first;
  assert.equal(await third, 'latest');
  assert.equal(started, 1);
});

test('Office directory rejects oversized inflated data before unpacking', async () => {
  const zip = new JSZip(); zip.file('word/document.xml', '<document/>');
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  assert.doesNotThrow(() => validateOfficeDirectory(bytes));
  const data = new DataView(bytes);
  const directory = data.getUint32(bytes.byteLength - 6, true);
  data.setUint32(directory + 24, 65 * 1024 * 1024, true);
  assert.throws(() => validateOfficeDirectory(bytes), /limit/);
  assert.throws(() => validateOfficeDirectory(bytes.slice(0, 10)), /Incomplete/);
});
