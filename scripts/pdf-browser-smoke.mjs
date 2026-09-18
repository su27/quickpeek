// Real headless browser/IntersectionObserver; native rendering is held to simulate
// outrunning the renderer. Never opens the user's PDF or touches their desktop.
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
const module = stripTypeScriptTypes(readFileSync(new URL('../src/pdf-viewer.ts',import.meta.url),'utf8')).replaceAll('"@tauri-apps/api/core"','"/core"');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style"><div id="host" style="width:850px;height:700px"></div><script type="module">
import {renderPdfViewer} from '/pdf';
window.pending=new Map();window.failFirst=false;window.rejections=[];window.held=-1;window.widths=[];
addEventListener('unhandledrejection',e=>{window.rejections.push(String(e.reason));e.preventDefault()});
window.result=(async()=>{
 const assert=(v,m)=>{if(!v)throw Error(m)};
 const until=predicate=>new Promise((resolve,reject)=>{const deadline=performance.now()+8000;const check=()=>{if(predicate())return resolve();if(performance.now()>deadline)return reject(Error('PDF state timeout: '+JSON.stringify({held:window.held,pending:[...window.pending.keys()],requests:window.widths.slice(-12)})));requestAnimationFrame(check)};check()});
 const png=await fetch('/image').then(r=>r.arrayBuffer());window.png=png;
 const urls=new Set();const create=URL.createObjectURL;const revoke=URL.revokeObjectURL;
 URL.createObjectURL=blob=>{const url=create(blob);urls.add(url);return url};URL.revokeObjectURL=url=>{urls.delete(url);revoke(url)};
 const host=document.querySelector('#host');const pages=Array.from({length:100},()=>({width:600,height:800}));
 const result=await renderPdfViewer('', 'sample.pdf',pages,pages[0],850,host,()=>{});
 const viewer=host.firstElementChild;const figures=[...viewer.querySelectorAll('figure')];
 const ready=i=>figures[i].classList.contains('is-ready');
 const invisible=i=>getComputedStyle(figures[i].querySelector('img')).visibility==='hidden';
 assert(ready(0)&&!invisible(0),'first page not decoded before presentation');
 const originalWidth=window.widths.find(([page])=>page===0)[1];
 host.style.width='1000px';
 await until(()=>window.widths.some(([page,width])=>page===0&&width>originalWidth));
 await until(()=>ready(0));
 assert(figures.every((_,i)=>ready(i)||invisible(i)),'unrendered images exposed');
 const visit=async i=>{window.held=i;viewer.scrollTop=figures[i].offsetTop-viewer.offsetTop;await until(()=>window.pending.has(i));assert(invisible(i),'pending page shows broken image');};
 const finish=async i=>{window.pending.get(i).resolve(png);window.pending.delete(i);await until(()=>ready(i));assert(!invisible(i),'decoded image not revealed');};
 // A slow in-flight page must not leave obsolete neighbors ahead of the final
 // destination. Cancelled active work still owns the single native lane.
 window.holdAll=true;
 await visit(12);
 const requestStart=window.widths.length;
 for(const i of [30,55,90]){
   viewer.scrollTop=figures[i].offsetTop-viewer.offsetTop;
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 }
 assert(window.pending.size===1,'cancelled active render released its lane early');
 await new Promise(r=>setTimeout(r,12500));
 assert(figures[90].querySelector('.pdf-native-page-error').hidden,'queue wait incorrectly counted as page timeout');
 window.held=90;window.holdAll=false;
 window.pending.get(12).resolve(png);window.pending.delete(12);
 await until(()=>window.pending.has(90));
 assert(window.widths[requestStart][0]===90,'destination was not rendered first');
 assert(!window.widths.slice(requestStart).some(([i])=>i===30||i===55),'obsolete jump pages rendered');
 await finish(90);
 await visit(12);await finish(12);
 // Decode enough distant pages to force the seven-page cache to evict page 0.
 for(const i of [20,30,40,50,60,70,80]){await visit(i);await finish(i)}
 assert(!ready(0)&&invisible(0)&&!figures[0].querySelector('img').hasAttribute('src'),'evicted page exposes broken image');
 await visit(0);await finish(0);
 await visit(90);window.pending.get(90).reject(Error('native page failed'));window.pending.delete(90);
 await until(()=>!figures[90].querySelector('.pdf-native-page-error').hidden);
 assert(invisible(90),'failed page exposed');
 figures[90].querySelector('button').click();await until(()=>window.pending.has(90));await finish(90);
 await visit(96);window.pending.get(96).resolve(new Uint8Array([1,2,3]).buffer);window.pending.delete(96);
 await until(()=>!figures[96].querySelector('.pdf-native-page-error').hidden);
 assert(invisible(96),'decode failure exposed broken image');
 // Retry a page after leaving and re-entering its neighborhood.
 viewer.scrollTop=figures[50].offsetTop-viewer.offsetTop;
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 await visit(96);await finish(96);
 assert(figures[96].querySelector('.pdf-native-page-error').hidden,'retry retains error label');
 await visit(98);result.destroy();
 for(const pending of window.pending.values())pending.resolve(png);window.pending.clear();
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 assert(host.childElementCount===0&&urls.size===0,'destroy leaked DOM or blob URLs');
 window.failFirst=true;let failed=false;
 try{await renderPdfViewer('', 'bad.pdf',pages,pages[0],850,host,()=>{})}catch{failed=true}
 assert(failed&&host.childElementCount===0,'first-page failure did not clean up');
 window.failFirst=false;window.held=0;const cancellation=new AbortController();
 const cancelled=renderPdfViewer('', 'cancel.pdf',pages,pages[0],850,host,()=>{},cancellation.signal).then(()=>false,()=>true);
 await until(()=>window.pending.has(0));cancellation.abort();
 assert(await cancelled,'first-page cancellation did not settle');
 window.pending.get(0).resolve(png);window.pending.delete(0);await Promise.resolve();
 assert(host.childElementCount===0&&urls.size===0,'cancelled first page leaked resources');
 assert(window.rejections.length===0,'unhandled page rejection');
 URL.createObjectURL=create;URL.revokeObjectURL=revoke;
 return {jumpDestinationFirst:true,obsoletePagesCancelled:true,explicitRetry:true,resizeRerasterizes:true,firstPageCancellation:true,pendingHidden:true,decodedVisible:true,evictionAndReload:true,nativeAndDecodeFailuresHandled:true,closeDuringRendering:true,blobUrlsRemaining:urls.size};
})();</script>`;
const server=createServer((req,res)=>{
 if(['/preview-task','/preview-work-queue'].includes(req.url)){res.setHeader('Content-Type','text/javascript');res.end(stripTypeScriptTypes(readFileSync(new URL('../src'+req.url+'.ts',import.meta.url),'utf8')));return}
 if(req.url==='/pdf'){res.setHeader('Content-Type','text/javascript');res.end(module);return}
 if(req.url==='/core'){res.setHeader('Content-Type','text/javascript');res.end(`export const isTauri=()=>true;export function invoke(command,{pageIndex,targetWidth}){window.widths.push([pageIndex,targetWidth]);if(window.failFirst)return Promise.reject(Error('first page failed'));if(!window.holdAll&&pageIndex!==window.held)return Promise.resolve(window.png);return new Promise((resolve,reject)=>window.pending.set(pageIndex,{resolve,reject}))}`);return}
 if(req.url==='/style'){res.setHeader('Content-Type','text/css');res.end(readFileSync(new URL('../src/style.css',import.meta.url)));return}
 if(req.url==='/image'){res.setHeader('Content-Type','image/png');res.end(readFileSync(new URL('../src-tauri/icons/32x32.png',import.meta.url)));return}
 res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=mkdtempSync(join(tmpdir(),'quickpeek-pdf-smoke-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
 '--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Edge startup timeout')),15000);edge.stderr.on('data',data=>{log+=data;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1])}});edge.on('error',reject)});
 const tab=await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
 let sequence=0;const pending=new Map();
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}});
 const send=(method,params={})=>new Promise(r=>{const id=++sequence;pending.set(id,r);socket.send(JSON.stringify({id,method,params}))});
 await send('Page.enable');const loaded=new Promise(r=>socket.addEventListener('message',function ready(e){if(JSON.parse(e.data).method==='Page.loadEventFired'){socket.removeEventListener('message',ready);r()}}));
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await loaded;
 const result=await send('Runtime.evaluate',{expression:'window.result',awaitPromise:true,returnByValue:true,timeout:30000});
 assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));
 assert.ok(result.result.result.value,'PDF test did not load');console.log(result.result.result.value);
 void send('Browser.close');
}finally{socket?.close();edge.kill();server.closeAllConnections();server.close()}
