// Run against a diagnostic QuickPeek instance already showing the large PDF.
// Exercises real PDF.js rendering after outrunning the page renderer.
import assert from 'node:assert/strict';
const tabs = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
const tab = tabs.find(tab => tab.url.includes('tauri.localhost'));
assert.ok(tab, 'diagnostic WebView not found');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => socket.addEventListener('open', r, {once:true}));
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m); pending.delete(m.id);
});
async function evaluate(expression) {
  const id = ++sequence;
  const result = await new Promise(resolve => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression, awaitPromise:true, returnByValue:true}}));
  });
  assert.ok(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
  return result.result.result.value;
}
try {
  const result = await evaluate(`(async () => {
    const viewer = document.querySelector('.pdf-pages');
    if (!viewer) throw Error('Open the PDF first');
    const figures = [...viewer.querySelectorAll('figure')];
    if (figures.length < 120) throw Error('Fixture must have at least 120 pages');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const measurements = [];
    for (const target of [99, 149, 30, 105]) {
      if (target >= figures.length) continue;
      const start = performance.now();
      // Simulate dragging the scrollbar across intermediate page neighborhoods.
      for (const index of [10, 35, 60, 85, target]) {
        viewer.scrollTop = figures[index].offsetTop;
        await sleep(70);
      }
      while (!figures[target].classList.contains('is-ready') && performance.now() - start < 40000) await sleep(100);
      measurements.push({page:target+1, ms:Math.round(performance.now()-start),
        ready:figures[target].classList.contains('is-ready'),
        error:figures[target].querySelector('.pdf-page-error')?.textContent ?? null});
      if (!measurements.at(-1).ready) break;
    }
    const target = figures[105], original = target.querySelector('canvas'), originalWidth = original.width;
    document.querySelector('[aria-label="Zoom in"]').click();
    const zoomStart = performance.now();
    while (target.querySelector('canvas') === original && performance.now()-zoomStart < 20000) await sleep(50);
    const zoomed = target.querySelector('canvas');
    const zoomRerenders = zoomed !== original && zoomed.width > originalWidth;
    document.querySelector('[aria-label="Fit width"]').click();
    const thumb = document.querySelector('[aria-label="Page 100"]');thumb.click();
    const thumbStart = performance.now();
    while ((!figures[99].classList.contains('is-ready') || thumb.getAttribute('aria-current') !== 'page') && performance.now()-thumbStart < 20000) await sleep(50);
    const side = thumb.closest('nav'), r = thumb.getBoundingClientRect(), s = side.getBoundingClientRect();
    return {measurements, retained:viewer.querySelectorAll('.is-ready').length, zoomRerenders,
      thumbnailNavigates:thumb.getAttribute('aria-current') === 'page', thumbnailFollows:r.top>=s.top && r.bottom<=s.bottom};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.measurements.every(m => m.ready), 'jump destination failed to render');
  assert.ok(result.retained <= 5 && result.zoomRerenders && result.thumbnailNavigates && result.thumbnailFollows, 'zoom/thumbnail/cache regression');
} finally { socket.close(); }
