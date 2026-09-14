// Isolated headless Edge: exercises real lazy renderers without touching the desktop/profile.
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const archiveFixture = new URL('../testfiles/SmartProxy-v1.7-Firefox.zip', import.meta.url);
const sampleZip = existsSync(archiveFixture) ? await JSZip.loadAsync(readFileSync(archiveFixture), {createFolders:false}) : null;
const sampleEntries = sampleZip && Object.values(sampleZip.files).map(e=>({name:e.name,dir:e.dir,compressedSize:e._data?.compressedSize,uncompressedSize:e._data?.uncompressedSize}));
const names = ['font-viewer','tiff-viewer','image-viewer','image-layout','preview-task','zip-viewer','archive-tree'];
const modules = new Map(names.map(name => [`/${name}`, stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8')).replaceAll('"@tauri-apps/api/core"','"/core"').replaceAll('"@tauri-apps/api/window"','"/window"')]));
modules.set('/window', `export async function currentMonitor(){return {workArea:{size:{width:2880,height:1800}}}}`);
modules.set('/core', `export const isTauri=()=>!!window.heicTest;export async function invoke(command,args){window.calls.push([command,args]);if(command==='decode_system_image'){if(window.deferHeic)return new Promise(resolve=>window.resolveHeic=resolve);return window.heicPayload;}if(command==='read_tiff_info')return {width:32,height:32,pageCount:2};return (await fetch('/image/'+args.pageIndex)).arrayBuffer();}`);
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style"><div id="host" style="position:relative;width:850px;height:700px"></div><script type="module">
import {renderFontViewer} from '/font-viewer'; import {renderTiffViewer} from '/tiff-viewer'; import {renderArchiveDirectory} from '/zip-viewer';
import {renderImageViewer} from '/image-viewer';
window.calls=[];
window.result=(async()=>{
 const host=document.querySelector('#host');const assert=(v,m)=>{if(!v)throw new Error(m)};
 const baseline=document.fonts.size;
 for(let i=0;i<3;i++){
   const font=await renderFontViewer('/font','Segoe UI.ttf',host,new AbortController().signal);
   assert(document.fonts.size===baseline+1,'font not registered');assert(host.querySelectorAll('.font-viewer-row').length===4,'font samples');
   font.destroy();assert(document.fonts.size===baseline,'font not released');
 }
 try{await renderFontViewer('/broken','bad.ttf',host,new AbortController().signal);throw new Error('bad font accepted')}catch(e){assert(e.message!=='bad font accepted',e.message)}
 assert(document.fonts.size===baseline,'bad font leaked');
 host.className='';const abort=new AbortController();let pageLabel='';
 const tiff=await renderTiffViewer('sample.tiff',1,{host,signal:abort.signal,isActive:()=>true,setPageLabel:t=>pageLabel=t,viewport:host});
 assert(window.calls.filter(c=>c[0]==='render_tiff_page').length===1,'TIFF eagerly decoded other pages');
 host.querySelectorAll('button')[1].click();
 await new Promise((resolve,reject)=>{const deadline=performance.now()+5000;function check(){if(pageLabel==='2/2 页')return resolve();if(performance.now()>deadline)return reject(new Error('TIFF page turn timeout '+JSON.stringify({pageLabel,calls:window.calls,controls:host.querySelector('nav')?.outerHTML})));requestAnimationFrame(check)}check()});
 assert(host.querySelectorAll('.image-viewer').length===1,'TIFF retained old frame');
 tiff.destroy();assert(!host.querySelector('img')&&!host.querySelector('nav'),'TIFF resources not released');
 window.heicTest=true;
 const canvas=document.createElement('canvas');canvas.width=32;canvas.height=16;
 canvas.getContext('2d').fillRect(0,0,16,16);
 const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),urls=new Set();let blobType;
 URL.createObjectURL=blob=>{blobType=blob.type;const url=create(blob);urls.add(url);return url};
 URL.revokeObjectURL=url=>{urls.delete(url);revoke(url)};
 for(const type of ['image/jpeg','image/png']){
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,0.92));
   window.heicPayload=await blob.arrayBuffer();
   const photo=await renderImageViewer('', 'sample.heic',host,'sample.heic');
   assert(blobType===type,'incorrect HEIC transfer MIME');
   assert(photo.width===32&&photo.height===16,'HEIC image was not decoded');
   assert(window.calls.at(-1)[1].maxDimension===2880,'HEIC ignored physical monitor size');
   photo.destroy();assert(host.childElementCount===0&&urls.size===0,'HEIC close leaked image');
 }
 window.deferHeic=true;const cancellation=new AbortController();
 const cancelled=renderImageViewer('', 'cancel.heic',host,'cancel.heic',cancellation.signal).then(()=>false,()=>true);
 while(!window.resolveHeic)await new Promise(r=>requestAnimationFrame(r));
 cancellation.abort();assert(await cancelled,'HEIC cancellation did not reject');window.resolveHeic(window.heicPayload);
 await Promise.resolve();assert(host.childElementCount===0&&urls.size===0,'cancelled HEIC retained DOM/URL');
 URL.createObjectURL=create;URL.revokeObjectURL=revoke;window.heicTest=false;
 host.className='';
 const zip=renderArchiveDirectory({entries:[{name:'<img src=x onerror=alert(1)>',dir:false,uncompressedSize:40,compressedSize:12},{name:'folder/',dir:true}],truncated:false},host);
 assert(!host.querySelector('img'),'archive filename HTML injection');assert(host.querySelector('.is-folder'),'folder icon missing');
 zip.destroy();assert(host.childElementCount===0,'archive DOM not released');
 const hierarchy=renderArchiveDirectory({entries:[{name:'_locales/en/messages.json',dir:false,uncompressedSize:42},{name:'_locales/How-to.txt',dir:false},{name:'root.txt',dir:false}],truncated:false},host);
 const rows=[...host.querySelectorAll('.zip-viewer-list li')];
 assert(rows.length===5,'implicit folders not created');
 assert(rows.map(r=>r.querySelector('.zip-viewer-name').textContent).join('|')==='_locales|en|messages.json|How-to.txt|root.txt','hierarchy or basename incorrect');
 const positions=rows.map(r=>r.querySelector('.zip-viewer-size').getBoundingClientRect().left);
 assert(positions.every(x=>x===positions[0]),'size columns shifted with depth');
 const folders=host.querySelectorAll('.zip-viewer-label[aria-expanded]');
 folders[1].click(); assert(rows[2].hidden&&!rows[3].hidden,'nested folder collapse incorrect');
 folders[0].click(); assert(rows[1].hidden&&rows[3].hidden&&!rows[4].hidden,'parent collapse incorrect');
 folders[0].click(); assert(!rows[1].hidden&&rows[2].hidden&&!rows[3].hidden,'nested collapsed state was lost');
 folders[1].click(); assert(rows.every(r=>!r.hidden),'expand did not restore files');
 hierarchy.destroy(); assert(host.childElementCount===0,'tree DOM not released');
 const sampleEntries=await fetch('/archive-fixture').then(r=>r.json());
 if(sampleEntries){
   const sample=renderArchiveDirectory({entries:sampleEntries,truncated:false},host);
   assert(sample.count===129,'SmartProxy tree row count');
   assert(host.querySelectorAll('.zip-viewer-list li.is-directory').length===16,'SmartProxy missing inferred folders');
   assert(host.querySelectorAll('.zip-viewer-list li.is-file').length===113,'SmartProxy missing files');
 }
 return {fontCycles:3,fontFacesAfter:document.fonts.size-baseline,tiffPages:2,heicMimeAndCancellation:true,archiveRows:2};
})();</script>`;
const server=createServer((req,res)=>{
 if(req.url==='/archive-fixture'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(sampleEntries));return;}
 if(modules.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(modules.get(req.url));return;}
 if(req.url==='/font'){res.end(readFileSync('C:/Windows/Fonts/segoeui.ttf'));return;}
 if(req.url==='/broken'){res.end('not a font');return;}
 if(req.url?.startsWith('/image/')){res.setHeader('Content-Type','image/png');res.end(readFileSync(new URL('../src-tauri/icons/'+(req.url.endsWith('0')?'32x32.png':'128x128.png'),import.meta.url)));return;}
 if(req.url==='/style'){res.setHeader('Content-Type','text/css');res.end(readFileSync(new URL('../src/style.css',import.meta.url)));return;}
 res.setHeader('Content-Type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=mkdtempSync(join(tmpdir(),'quickpeek-formats-smoke-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',[
 '--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Edge startup timeout')),15000);edge.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});edge.on('error',e=>{clearTimeout(timer);reject(e)});});
 const tab=await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
 let sequence=0;const pending=new Map();
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}});
 const send=(method,params={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}))});
 await send('Page.enable');const loaded=new Promise(resolve=>socket.addEventListener('message',function ready(e){if(JSON.parse(e.data).method==='Page.loadEventFired'){socket.removeEventListener('message',ready);resolve()}}));
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await loaded;
 const result=await send('Runtime.evaluate',{expression:'window.result',awaitPromise:true,returnByValue:true,timeout:20000});
 assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));
 assert.ok(result.result.result.value,'test modules did not load');console.log(JSON.stringify(result.result.result.value));
 if(process.env.QUICKPEEK_ARCHIVE_SCREENSHOT){
   await send('Emulation.setDeviceMetricsOverride',{width:1000,height:850,deviceScaleFactor:1,mobile:false});
   const screenshot=await send('Page.captureScreenshot',{format:'png'});
   writeFileSync(process.env.QUICKPEEK_ARCHIVE_SCREENSHOT,Buffer.from(screenshot.result.data,'base64'));
 }
 void send('Browser.close');
}finally{socket?.close();edge.kill();server.closeAllConnections();server.close();}
