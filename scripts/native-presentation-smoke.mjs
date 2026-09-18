// Run against a deliberately diagnostic QuickPeek instance with WebView2 CDP
// on localhost:9229. Exercises the real file-open, commit and presentation path.
// Usage: node scripts/native-presentation-smoke.mjs <quickpeek.exe> <sample.rtf>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const [executable, fixture] = process.argv.slice(2).map(path => resolve(path));
assert.ok(executable && fixture, "provide the diagnostic executable and RTF fixture");
const tabs = await fetch("http://127.0.0.1:9229/json/list").then(response => response.json());
const tab = tabs.find(tab => tab.url.includes("tauri.localhost"));
assert.ok(tab, "diagnostic QuickPeek WebView not found");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
});
async function evaluate(expression) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("WebView evaluation timed out"));
    }, 15000);
    pending.set(id, message => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(message);
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
      expression, awaitPromise: true, returnByValue: true,
    } }));
  });
  assert.ok(!response.error && !response.result.exceptionDetails, JSON.stringify(response));
  return response.result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 15000;
  while (!await evaluate(expression)) {
    if (Date.now() >= deadline) {
      throw new Error(`presentation did not settle: ${expression}; state=${JSON.stringify(await evaluate(`({
        title: document.title, viewport: document.querySelector('#documentViewport').className,
        visibility: document.visibilityState, request: window.__lastNativeRequest,
      })`))}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function open(path, kind, visibility) {
  await evaluate("window.__lastNativeRequest = null");
  const launch = spawnSync(executable, [path], { windowsHide: true, timeout: 15000 });
  assert.equal(launch.status, 0, String(launch.error ?? launch.stderr));
  await waitFor(`document.title.startsWith(${JSON.stringify(basename(path).replace(/\s+/g, ' '))})
    && document.querySelector('#documentViewport').classList.contains('is-${kind}')
    && window.__lastNativeRequest !== null
    && document.visibilityState === '${visibility}'`);
  return evaluate("window.__lastNativeRequest");
}
const scratch = mkdtempSync(join(tmpdir(), "quickpeek-native-presentation-"));
const text = join(scratch, "restore-webview.txt");
const invalidRtf = join(scratch, "invalid.rtf");
writeFileSync(text, "WebView restored after native preview.");
writeFileSync(invalidRtf, "Invalid RTF: exercise the file-information fallback.");
try {
  await evaluate(`(async () => { window.__lastNativeRequest = null;
    window.__nativeTestCallback = window.__TAURI_INTERNALS__.transformCallback(event => {
      window.__lastNativeRequest = event.payload;
    });
    window.__nativeTestListener = await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'preview-file', target: {kind: 'Any'}, handler: window.__nativeTestCallback,
    }); })()`);
  const native = await open(fixture, "system", "hidden");
  await open(resolve('fixtures/documents/sample.docx'), "docx", "visible");
  assert.ok(await evaluate("document.querySelectorAll('#documentHost section.docx').length > 0"), "Office worker did not render inside WebView2");
  if (process.env.QUICKPEEK_PDF_FIXTURE) {
    await open(resolve(process.env.QUICKPEEK_PDF_FIXTURE), "pdf", "visible");
    assert.ok(await evaluate("document.querySelector('.pdf-native-page.is-ready img')?.naturalWidth > 64"));
  }
  if (process.env.QUICKPEEK_DOC_FIXTURE) await open(resolve(process.env.QUICKPEEK_DOC_FIXTURE), "system", "hidden");
  await open(text, "text", "visible");
  assert.ok(await evaluate("document.body.innerText.includes('WebView restored')"));
  await evaluate(`window.__TAURI_INTERNALS__.invoke('show_preview_window', {
    generation: ${native.generation}, nativePreview: true,
  })`);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await evaluate("document.visibilityState"), "visible", "stale native commit hid the new file");
  await open(fixture, "system", "hidden");
  await open(invalidRtf, "file", "visible");
  const reopened = await open(fixture, "system", "hidden");
  await evaluate(`window.__TAURI_INTERNALS__.invoke('hide_preview_window', {generation:${reopened.generation}})`);
  await waitFor("!document.querySelector('#workspace').classList.contains('has-document')");
  await open(text, "text", "visible");
  await open(fixture, "system", "hidden");
  console.log({ officeWorkerInWebView: true, nativeSurface: true, textRestored: true, staleCommitIgnored: true,
    failureFallback: true, closeAndReopen: true });
} finally {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', {
    event: 'preview-file', eventId: window.__nativeTestListener,
  }); window.__TAURI_INTERNALS__.unregisterCallback(window.__nativeTestCallback);`).catch(() => {});
  socket.close();
  unlinkSync(text);
  unlinkSync(invalidRtf);
  rmdirSync(scratch);
}
