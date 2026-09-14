// Real built frontend, isolated headless Edge. Does not interact with the desktop.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const root = resolve('dist');
const server = createServer((req, res) => {
  const path = resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = mkdtempSync(join(tmpdir(), 'quickpeek-shell-test-'));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timeout = setTimeout(() => reject(new Error('Edge startup timeout')), 15000);
    edge.stderr.on('data', data => { log += data; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    edge.on('error', reject);
  });
  const tab = await fetch('http://' + new URL(endpoint).host + '/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  const loaded = new Promise(resolve => socket.addEventListener('message', function ready(event) { if (JSON.parse(event.data).method === 'Page.loadEventFired') { socket.removeEventListener('message', ready); resolve(); } }));
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await loaded;
  const result = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, timeout: 15000, expression: `(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const workspace = document.querySelector('#workspace');
    assert(!document.querySelector('#emptyState, #emptyOpenButton, .empty-state'), 'retired welcome page retained');
    assert(!document.body.innerText.includes('选择文件'), 'visible file-picker prompt');
    assert(getComputedStyle(workspace).backgroundColor === 'rgb(32, 32, 32)', 'idle surface is not dark');
    for (const [name, content] of [['one.txt', 'first preview'], ['two.md', '# Second preview']]) {
      const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type: 'text/plain' }));
      const input = document.querySelector('#fileInput'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
      const deadline = performance.now() + 5000;
      while (!document.title.startsWith(name) || !workspace.classList.contains('has-document')) {
        if (performance.now() > deadline) throw new Error('preview did not commit: ' + name);
        await new Promise(requestAnimationFrame);
      }
      assert(getComputedStyle(document.querySelector('#documentViewport')).display === 'block', 'committed preview hidden');
      assert(!document.querySelector('.empty-state'), 'welcome page returned during switch');
    }
    return { retiredPageRemoved: true, idleSurfaceDark: true, textAndMarkdownSwitch: true };
  })()` });
  assert.ok(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
  console.log(result.result.result.value);
  void send('Browser.close');
} finally { socket?.close(); edge.kill(); server.closeAllConnections(); server.close(); }
