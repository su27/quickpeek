// Uses an explicitly diagnostic app instance; never displays the parent window.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [path, pid] = process.argv.slice(2);
assert(path && /^\d+$/.test(pid));
const tabs = await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json());
const tab = tabs.find(t=>t.url.includes('tauri.localhost'));
assert(tab);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
let id = 0;
async function run(expression) {
  const request = ++id;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.removeEventListener('message',listener);reject(new Error('IPC timeout'));},15000);
    function listener(event){const m=JSON.parse(event.data);if(m.id!==request)return;clearTimeout(timer);ws.removeEventListener('message',listener);if(m.error||m.result.exceptionDetails)reject(new Error(JSON.stringify(m)));else resolve(m.result.result.value);}
    ws.addEventListener('message',listener);
    ws.send(JSON.stringify({id:request,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
}
const invoke=(command,args={})=>run(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
function snapshot(stage){console.log(stage);console.log(execFileSync('powershell',['-NoProfile','-File','scripts/inspect-native-preview.ps1',pid],{windowsHide:true,encoding:'utf8'}));}
try {
  await invoke('prepare_preview_engine');
  assert.equal(await invoke('prepare_system_preview',{path,generation:0}),true);
  assert.equal(await invoke('activate_system_preview',{generation:0}),true);
  snapshot('activated');
  // Mirrors the old show path, without showing/activating the app itself.
  await invoke('prepare_preview_engine');
  snapshot('after redundant WebView resume');
  await invoke('unload_system_preview',{generation:0});
} finally { ws.close(); }
