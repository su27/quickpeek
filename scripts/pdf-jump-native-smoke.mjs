// Run against a diagnostic QuickPeek instance already showing the large PDF.
// Exercises real WinRT rendering after outrunning the page renderer.
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
    const viewer = document.querySelector('.pdf-native-viewer');
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
        viewer.scrollTop = figures[index].offsetTop - viewer.offsetTop;
        await sleep(70);
      }
      while (!figures[target].classList.contains('is-ready') && performance.now() - start < 40000) await sleep(100);
      measurements.push({page:target+1, ms:Math.round(performance.now()-start),
        ready:figures[target].classList.contains('is-ready'),
        error:figures[target].querySelector('.pdf-native-page-error').textContent});
      if (!measurements.at(-1).ready) break;
    }
    return {measurements, retained:viewer.querySelectorAll('.is-ready').length};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.measurements.every(m => m.ready), 'jump destination failed to render');
} finally { socket.close(); }
