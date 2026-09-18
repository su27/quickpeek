// Production bundle with only the native transport fault-injected.
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
  try { res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${mkdtempSync(join(tmpdir(),'quickpeek-lifecycle-'))}`,'--remote-debugging-port=0','about:blank'], {windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try {
  const endpoint = await new Promise((resolve,reject) => { let log=''; const timer=setTimeout(()=>reject(Error('Edge startup timeout')),15000); edge.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}}); edge.on('error',reject); });
  const tab=await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
  const send=(method,params={})=>new Promise(r=>{const next=++id;pending.set(next,r);socket.send(JSON.stringify({id:next,method,params}));});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.isTauri=true;window.events={};window.callbacks={};window.calls=[];window.blocked={};window.rejections=[];
    addEventListener('unhandledrejection',e=>window.rejections.push(String(e.reason)));
    let callback=0;
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}},transformCallback:fn=>{window.callbacks[++callback]=fn;return callback;},invoke:async(command,args={})=>{
      calls.push([command,args]);
      if(command==='plugin:event|listen'){events[args.event]=callbacks[args.handler];return args.handler;}
      if(command==='get_initial_preview'||command==='plugin:window|current_monitor')return null;
      if(command==='read_preview_file'){
        if(args.path.startsWith('hang'))return new Promise(r=>blocked[args.path]=r);
        return new TextEncoder().encode('const sample = "'+args.path+'";').buffer;
      }
      if(command==='read_shell_icon')return new Promise(()=>{});
      if(command==='prepare_browser_preview')return 30;
    }};
  `});
  await send('Page.enable');
  const loaded=new Promise(r=>socket.addEventListener('message',function done(e){if(JSON.parse(e.data).method==='Page.loadEventFired'){socket.removeEventListener('message',done);r();}}));
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await loaded;
  const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,timeout:20000,expression:`(async()=>{
    const assert=(v,m)=>{if(!v)throw Error(m)};
    const until=async predicate=>{const end=performance.now()+5000;while(!predicate()){if(performance.now()>end)throw Error('State timeout '+document.title);await new Promise(r=>setTimeout(r,10));}};
    await until(()=>events['preview-file']);
    // No requestAnimationFrame is delivered: a hidden preview must still finish.
    window.requestAnimationFrame=()=>1;
    const open=(generation,path)=>events['preview-file']({payload:{generation,path,size:120,isDirectory:false}});
    const shown=g=>calls.some(([c,a])=>c==='show_preview_window'&&a.generation===g);
    open(1,'hang-one.ts');await until(()=>blocked['hang-one.ts']);
    open(2,'two.ts');await until(()=>shown(2));
    assert(document.querySelector('#documentHost').textContent.includes('two.ts'),'hung old read blocked new file');
    blocked['hang-one.ts'](new TextEncoder().encode('STALE').buffer);await Promise.resolve();
    assert(!shown(1),'late read displayed stale file');
    // Failure after commit must leave the new host alive.
    const search=document.querySelector('#searchInput');
    Object.defineProperty(search,'disabled',{configurable:true,set(value){if(!value){delete this.disabled;throw Error('injected control failure');}}});
    open(3,'three.ts');await until(()=>shown(3));
    assert(document.querySelector('#documentHost').textContent.includes('three.ts'),'post-commit failure destroyed active host');
    open(4,'hang-close.ts');await until(()=>blocked['hang-close.ts']);
    events['preview-hidden']({payload:5});await until(()=>calls.some(([c,a])=>c==='preview_cleanup_complete'&&a.generation===5));
    open(6,'six.ts');await until(()=>shown(6));
    events['preview-hidden']({payload:5});
    assert(document.querySelector('#documentHost').textContent.includes('six.ts'),'stale hide cleared new preview');
    open(7,'unknown.zzz');await until(()=>shown(7));
    assert(document.querySelector('.file-info-viewer'),'slow shell icon blocked fallback');
    const transfer=new DataTransfer();transfer.items.add(new File(['browser file'],'browser.txt'));
    const input=document.querySelector('#fileInput');input.files=transfer.files;input.dispatchEvent(new Event('change'));
    await until(()=>shown(30));assert(calls.some(([c])=>c==='prepare_browser_preview'),'browser file retained old native target');
    assert(rejections.length===0,'unhandled rejection: '+rejections.join(','));
    return {cancelledHungRead:true,lateResultIgnored:true,postCommitFailureSafe:true,hiddenWindowWithoutFrames:true,closeAndReopen:true,slowShellIconNonblocking:true,browserFilePresented:true};
  })()`});
  assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));console.log(result.result.result.value);
  void send('Browser.close');
} finally {socket?.close();edge.kill();server.closeAllConnections();server.close();}
