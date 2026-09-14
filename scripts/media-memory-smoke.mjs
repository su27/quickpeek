// Connect only to a deliberately diagnostic QuickPeek instance on localhost.
// Exercises the real bundled renderer + native asset protocol without showing UI.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [path, rootPid] = process.argv.slice(2);
const suspend = process.argv.includes('--suspend');
assert.ok(path && /^\d+$/.test(rootPid), 'usage: node scripts/media-memory-smoke.mjs <video> <QuickPeek PID>');
const tabs = await fetch('http://127.0.0.1:9229/json/list').then(r=>r.json());
const tab = tabs.find(t=>t.url.startsWith('http://tauri.localhost') || t.url.startsWith('https://tauri.localhost'));
assert.ok(tab, 'diagnostic QuickPeek WebView not found');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let seq=0; const pending=new Map();
socket.addEventListener('message',event=>{ const m=JSON.parse(event.data); if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);} });
const send=(method,params={})=>new Promise((resolve,reject)=>{ const id=++seq; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},15000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});socket.send(JSON.stringify({id,method,params})); });
const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function snapshot(stage){
 const command=`$ids=@(${rootPid});$rows=Get-CimInstance Win32_Process;do{$children=@($rows|Where-Object{$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids});$ids+=@($children|ForEach-Object{[int]$_.ProcessId})}while($children.Count -gt 0);$rows|Where-Object{$_.ProcessId -in $ids}|ForEach-Object{$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{pid=$_.ProcessId;type=([regex]::Match($_.CommandLine,'--type=([^ ]+)').Groups[1].Value);ws=[math]::Round($p.WorkingSet64/1MB,1);commit=[math]::Round($p.PrivateMemorySize64/1MB,1)}}}|ConvertTo-Json -Compress`;
 const rows=JSON.parse(execFileSync('powershell',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8'}));
 const resident=JSON.parse(execFileSync('powershell',['-NoProfile','-Command',`Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $_.IDProcess -in @(${rows.map(r=>r.pid).join(',')}) } | Select-Object IDProcess,WorkingSetPrivate | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'}));
 for(const row of rows) row.privateWs=Math.round((resident.find(r=>r.IDProcess===row.pid)?.WorkingSetPrivate || 0)/1048576*10)/10;
 console.log(JSON.stringify({stage,rows}));
}
const module=readdirSync('dist/assets').find(n=>/^media-viewer-.*\.js$/.test(n));
try {
 await send('Media.enable');
 await run(`(async()=>{window.memoryTest = {module: await import('/assets/${module}')}; await window.__TAURI_INTERNALS__.invoke('allow_preview_asset',{path:${JSON.stringify(path)}})})()`);
 snapshot('fresh');
 for(let cycle=0;cycle<Number(process.env.QUICKPEEK_MEMORY_CYCLES || 3);cycle++){
  const info=await run(`(async()=>{const begun=performance.now();${suspend ? "await window.__TAURI_INTERNALS__.invoke('prepare_preview_engine');" : ''}const t=window.memoryTest; t.host=document.createElement('article');document.body.append(t.host);t.abort=new AbortController();t.viewer=await t.module.renderVideoViewer(window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(path)},'asset'),t.host,t.abort.signal);const video=t.host.querySelector('video');video.muted=true;t.viewer.start();await video.play();return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,readyMs:performance.now()-begun};})()`);
  await pause(2000); console.log(JSON.stringify({cycle,info}));snapshot('playing-'+cycle);
  console.log(await run(`(()=>{const t=window.memoryTest;const v=t.host.querySelector('video');t.viewer.destroy();t.abort.abort();t.host.remove();const state={paused:v.paused,network:v.networkState,ready:v.readyState,src:v.getAttribute('src'),mediaNodes:document.querySelectorAll('video,audio').length};t.viewer=null;t.abort=null;t.host=null;return state;})()`));
  if(suspend) await run("void window.__TAURI_INTERNALS__.invoke('hide_preview_window')");
  await pause(500);snapshot('closed-'+cycle);
 }
 if(!suspend){await send('HeapProfiler.collectGarbage');await pause(1000);snapshot('after-gc');
 await send('Memory.simulatePressureNotification',{level:'critical'});await pause(1500);snapshot('after-pressure');}
}finally{await run('delete window.memoryTest').catch(()=>{});socket.close();}
if(suspend){
 for(const seconds of [1,2,5]){await pause(seconds*1000);snapshot('disconnected-idle-'+seconds);}
}
