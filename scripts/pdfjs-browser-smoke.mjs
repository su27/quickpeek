// Real PDF.js worker/canvas tests, including a hidden first render without rAF.
import { createServer } from 'vite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
function fixture() {
  const objects=[];const add=s=>objects.push(s);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Count 164 /Kids ['+Array.from({length:164},(_,i)=>`${4+i*2} 0 R`).join(' ')+'] >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i=0;i<164;i++){
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${i===5||i===163?'800 600':'600 800'}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const content=`0.2 0.4 0.7 RG 1 w 30 30 540 740 re S BT /F1 22 Tf 40 740 Td (Vector page ${i+1}) Tj ET\n`;
    add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  let data='%PDF-1.7\n';const offsets=[0];
  for(const [i,object] of objects.entries()){offsets.push(data.length);data+=`${i+1} 0 obj\n${object}\nendobj\n`}
  const xref=data.length;data+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1)) data+=String(offset).padStart(10,'0')+' 00000 n \n';
  data+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}
const html=`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/src/style.css"><style>#host{position:relative;width:850px;height:700px}</style><div id="host" style="display:none"></div><script type="module">
import {renderPdfViewer} from '/src/pdf-viewer.ts';
window.result=(async()=>{
 const assert=(ok,message)=>{if(!ok)throw Error(message)};
 const until=async test=>{const end=performance.now()+15000;while(!test()){if(performance.now()>end)throw Error('State timed out');await new Promise(r=>setTimeout(r,30))}};
 const originalRaf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
 const host=document.querySelector('#host');const controller=new AbortController();
 const viewer=await renderPdfViewer('/fixture.pdf',850,host,()=>{},controller.signal);
 const figure=host.querySelector('.pdf-page'),original=figure.querySelector('canvas'),width=figure.style.width;
 assert(original?.width>500,'hidden first page did not render at fitted resolution');
 host.style.display='block';viewer.start();await new Promise(r=>setTimeout(r,100));
 assert(figure.style.width===width,'first appearance changed page scale');
 await until(()=>host.querySelectorAll('.pdf-thumbnail canvas').length>1);
 const pages=host.querySelector('.pdf-pages'),figures=[...host.querySelectorAll('.pdf-page')];
 const initialLeft=figure.getBoundingClientRect().left,initialScrollWidth=pages.scrollWidth;
 // The final landscape page starts with portrait placeholder dimensions.
 pages.scrollTop=pages.scrollHeight;
 await until(()=>figures[163].classList.contains('is-ready'));
 assert(parseFloat(figures[163].style.width)>parseFloat(figures[163].style.height),'landscape fixture was not discovered');
 assert(pages.scrollWidth===initialScrollWidth&&pages.scrollWidth<=pages.clientWidth+1,'late landscape page widened the document');
 assert(figures[163].style.width===width,'landscape page did not fit the viewport');
 assert(getComputedStyle(pages).overflowX==='hidden','fit width retained an empty horizontal scrollbar');
 pages.scrollTop=0;
 await until(()=>figure.classList.contains('is-ready'));
 assert(Math.abs(figure.getBoundingClientRect().left-initialLeft)<1&&pages.scrollLeft===0,'returning to portrait pages shifted them sideways');
 const beforeZoom=figure.querySelector('canvas');
 const oldPixels=beforeZoom.width;host.querySelector('[aria-label="Zoom in"]').click();
 await until(()=>figure.querySelector('canvas')!==beforeZoom);
 assert(figure.querySelector('canvas').width>oldPixels,'zoom only stretched the old image');
 assert(getComputedStyle(pages).overflowX==='auto','zoom disabled horizontal browsing');
 const zoomedScrollWidth=pages.scrollWidth;pages.scrollLeft=40;
 host.querySelector('[aria-label="Page 6"]').click();
 await until(()=>figures[5].classList.contains('is-ready'));
 assert(pages.scrollWidth===zoomedScrollWidth&&pages.scrollLeft===40,'discovering landscape while zoomed changed horizontal layout');
 assert(figures[5].style.width===figure.style.width,'mixed pages use different fitted widths');
 host.querySelector('[aria-label="Page 1"]').click();
 await until(()=>figure.classList.contains('is-ready'));
 for(let i=0;i<12;i++)host.querySelector('[aria-label="Zoom in"]').click();
 await until(()=>{const c=figure.querySelector('canvas');return c&&Math.abs(c.width-parseFloat(c.style.width)*devicePixelRatio)<2&&parseFloat(c.style.width)<parseFloat(figure.style.width)});
 host.querySelector('[aria-label="Fit width"]').click();
 await until(()=>figure.style.width===width);
 host.querySelector('[aria-label="Page 100"]').click();
 await until(()=>host.querySelectorAll('.pdf-page')[99].classList.contains('is-ready'));
 assert(host.querySelector('[aria-current="page"]').title==='Page 100','thumbnail did not navigate');
 for(const page of [150,31,106]){host.querySelector('[aria-label="Page '+page+'"]').click();await until(()=>host.querySelectorAll('.pdf-page')[page-1].classList.contains('is-ready'))}
 assert(host.querySelectorAll('.pdf-page canvas').length<=5,'page cache is unbounded');
 host.querySelector('[aria-label="Zoom in"]').click();
 const captured=[...host.querySelectorAll('canvas')];viewer.destroy();
 assert(host.childElementCount===0&&captured.every(c=>c.width===0),'close did not release canvases');
 const cancelled=new AbortController();const pending=renderPdfViewer('/fixture.pdf',850,host,()=>{},cancelled.signal).then(()=>false,()=>true);cancelled.abort();
 assert(await pending,'cancelled document remained pending');assert(host.childElementCount===0,'cancel left document DOM');
 assert(await renderPdfViewer('/broken.pdf',850,host,()=>{}).then(()=>false,()=>true),'invalid PDF did not fail');
 assert(host.childElementCount===0,'invalid PDF retained document DOM');
 const reopened=await renderPdfViewer('/fixture.pdf',850,host,()=>{});reopened.start();
 await until(()=>host.querySelectorAll('.pdf-thumbnail canvas').length>1);
 window.requestAnimationFrame=originalRaf;
 return {hiddenFirstRender:true,noInitialScaleJump:true,mixedPageWidthsStable:true,zoomRerenders:true,highZoomCropped:true,thumbnailsNavigate:true,rapidJumps:true,boundedCache:true,cancellation:true,invalidFileCleanup:true,reopenAfterCancellation:true};
})();</script>`;
const server=await createServer({optimizeDeps:{noDiscovery:true},server:{port:0,strictPort:false},plugins:[{name:'pdf-test-page',configureServer(s){s.middlewares.use((req,res,next)=>{
 if(req.url==='/pdf-test'){res.setHeader('Content-Type','text/html');res.end(html)}
 else if(req.url==='/fixture.pdf'){res.setHeader('Content-Type','application/pdf');res.end(fixture())}
 else if(req.url==='/broken.pdf'){res.setHeader('Content-Type','application/pdf');res.end('Not a PDF')}
 else next();
})}}]});await server.listen();
const profile=mkdtempSync(join(tmpdir(),'quickpeek-pdfjs-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Edge timeout')),15000);edge.stderr.on('data',data=>{log+=data;const m=log.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1])}});edge.on('error',reject)});
 const tab=await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
 let sequence=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);pending.delete(m.id)});
 const send=(method,params={})=>new Promise(r=>{const id=++sequence;pending.set(id,r);socket.send(JSON.stringify({id,method,params}))});
 await send('Runtime.enable');await send('Log.enable');
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')console.error('browser:',m.params.entry.text)});
 await send('Page.enable');const loaded=new Promise(r=>socket.addEventListener('message',function ready(e){if(JSON.parse(e.data).method==='Page.loadEventFired'){socket.removeEventListener('message',ready);r()}}));
 await send('Page.navigate',{url:server.resolvedUrls.local[0]+'pdf-test'});await loaded;
 const result=await send('Runtime.evaluate',{expression:'window.result',awaitPromise:true,returnByValue:true,timeout:60000});
 assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));assert.ok(result.result.result.value);console.log(result.result.result.value);
 const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(profile,'pdf.png'),Buffer.from(shot.result.data,'base64'));
 console.log(join(profile,'pdf.png'));
 void send('Browser.close');
}finally{socket?.close();edge.kill();await server.close()}
