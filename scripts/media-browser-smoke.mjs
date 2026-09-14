// Isolated, headless Edge smoke test. No desktop windows or user browser profile.
// node scripts/media-browser-smoke.mjs C:\path\to\sample.mov
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, createReadStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";

const fixtures = process.argv.slice(2).map(path => ({path,size:statSync(path).size}));
assert.ok(fixtures.length>0,'provide at least one media fixture');
const lifecycle = stripTypeScriptTypes(readFileSync(new URL("../src/media-lifecycle.ts", import.meta.url), "utf8"));
const html = `<html><body><script type="module">
import {createMediaSession} from '/lifecycle.js';
window.result = (async () => {
  const original=document.createElement('video'); original.autoplay=true;
  original.preload='metadata'; original.style.visibility='hidden';
  const source=document.createElement('source');source.type='video/quicktime';source.src='/fixture/0';
  const legacy=await new Promise(resolve=>{
    const done=(event)=>{clearTimeout(timer);resolve({event,declaredTypeSupport:original.canPlayType('video/quicktime')});};
    const timer=setTimeout(()=>done('no media event'),2000);
    original.addEventListener('loadedmetadata',()=>done('loadedmetadata'),{once:true});
    source.addEventListener('error',()=>done('source error'),{once:true});
    original.append(source);document.body.append(original);original.load();
  });
  original.pause();source.remove();original.load();original.remove();
  const cycles = [];
  for (let i=0;i<${fixtures.length}*3;i++) {
    const media=document.createElement('video');
    media.preload='metadata'; media.muted=true; media.style.visibility='hidden';
    document.body.append(media);
    const abort=new AbortController(); const errors=[];
    const session=createMediaSession(media,abort.signal,(message)=>errors.push(message),3000);
    const cycle={fixture:i%${fixtures.length}};
    try {
      await session.load('/fixture/'+cycle.fixture);
      cycle.dimensions=[media.videoWidth,media.videoHeight];
      cycle.beforeStartPaused=media.paused;
      media.style.visibility='visible';
      const playing = new Promise(resolve=>media.addEventListener('playing',()=>resolve('playing'),{once:true}));
      session.start();
      cycle.playback=await Promise.race([playing,new Promise(resolve=>setTimeout(()=>resolve('timeout'),3500))]);
    } catch(error) { cycle.loadError=error.message; }
    abort.abort(); session.dispose();
    cycle.released=!media.getAttribute('src') && media.paused && session.disposed;
    cycle.errors=errors;
    media.remove(); cycles.push(cycle);
  }
  return {legacy,cycles};
})();
</script></body></html>`;
const server=createServer((req,res)=>{
  if(req.url==='/lifecycle.js') {res.setHeader('Content-Type','text/javascript');res.end(lifecycle);return;}
  if(req.url?.startsWith('/fixture/')) {
    const fixture=fixtures[Number(req.url.split('/').pop())];
    if(!fixture){res.writeHead(404);res.end();return;}
    const {path,size}=fixture;
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??'');
    const start=range?Number(range[1]):0;
    const end=range&&range[2]?Math.min(size-1,Number(range[2])):size-1;
    res.writeHead(range?206:200,{'Content-Type':path.toLowerCase().endsWith('.mp3')?'audio/mpeg':'video/quicktime','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    createReadStream(path,{start,end}).pipe(res);return;
  }
  res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=mkdtempSync(join(tmpdir(),'quickpeek-media-smoke-'));
const edge=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
  '--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,
  '--remote-debugging-port=0','--autoplay-policy=no-user-gesture-required','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try {
  const endpoint=await new Promise((resolve,reject)=>{
    let log='';const timer=setTimeout(()=>reject(new Error('headless Edge startup timeout')),15000);
    edge.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    edge.on('error',error=>{clearTimeout(timer);reject(error);});
  });
  const address=new URL(endpoint).host;
  const tab=await fetch(`http://${address}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  let sequence=0; const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}});
  const send=(method,params={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
  await send('Page.enable');
  const loaded=new Promise(resolve=>socket.addEventListener('message',function ready(event){if(JSON.parse(event.data).method==='Page.loadEventFired'){socket.removeEventListener('message',ready);resolve();}}));
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await loaded;
  const result=await send('Runtime.evaluate',{
    expression:'window.result',
    awaitPromise:true,returnByValue:true,timeout:20000,
  });
  assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));
  const {legacy,cycles}=result.result.result.value;
  console.log(JSON.stringify({legacy,cycles},null,2));
  assert.equal(cycles.length,fixtures.length*3);
  assert.ok(cycles.every(c=>c.released));
  assert.ok(cycles.every(c=>c.loadError||c.beforeStartPaused));
  void send('Browser.close');
} finally {
  socket?.close();
  edge.kill();
  server.closeAllConnections();server.close();
}
