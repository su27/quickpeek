// npm dependencies only; isolated headless Edge, no desktop interaction.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

async function makeBook(version = 3) {
  const zip = new JSZip();
  zip.file('mimetype','application/epub+zip');
  zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf',`<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>在平凡的日子里，读一本书</dc:title><dc:creator>QuickPeek · 阅读排版样张</dc:creator></metadata><manifest><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="three" href="text/three.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="images/icon.png" media-type="image/png"/><item id="nav" href="nav.xhtml" properties="nav" media-type="${version===3?'application/xhtml+xml':'unused'}"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="one"/><itemref idref="two"/><itemref idref="three"/></spine></package>`.replace(version===2?'properties="nav"':'unused-marker',''));
  zip.file('OPS/nav.xhtml','<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><a href="text/one.xhtml">第一章 · 慢下来的时光</a><a href="text/two.xhtml">第二章 · 远方的来信</a><a href="text/three.xhtml">第三章 · 再出发</a></nav></body></html>');
  zip.file('OPS/toc.ncx','<ncx><navMap><navPoint><navLabel><text>第一章 · 慢下来的时光</text></navLabel><content src="text/one.xhtml"/></navPoint><navPoint><navLabel><text>第二章 · 远方的来信</text></navLabel><content src="text/two.xhtml"/></navPoint></navMap></ncx>');
  zip.file('OPS/text/one.xhtml',`<html><head><link href="https://example.invalid/evil.css"/><style>body{display:none}</style></head><body onload="window.evil=1"><h1>第一章 · 慢下来的时光</h1><p>午后的光线落在书页上。窗外的树影轻轻摇晃，时间也仿佛随着这一页文字，变得缓慢而安静。</p><p>一本书不必急着读完。让每一段文字都有呼吸的空隙，让目光在行与行之间自然停留，这就是阅读最朴素的乐趣。</p><blockquote><p>阅读不是为了走得更快，而是为了看得更清楚。</p></blockquote><h2>给文字一点空间</h2><p>The quiet pleasure of reading begins with a clear page, a comfortable rhythm, and a little room to think.</p><p>这份预览保留正文的章节、插图和基本格式，让书籍回到内容本身。<a href="two.xhtml#note">继续阅读下一章</a>，或者先看看<a href="#end">本章末尾</a>。</p><table><tr><th>阅读方式</th><th>体验</th></tr><tr><td>按章节浏览</td><td>轻巧而专注</td></tr></table><p id="end">慢慢读，不着急。</p><img src="../images/icon.png" alt="插图"/><img src="https://example.invalid/tracker.png"/><iframe src="https://example.invalid/frame"/><script>window.evil=1</script></body></html>`);
  zip.file('OPS/text/two.xhtml','<html><body><h1>第二章 · 远方的来信</h1><p id="note">新的章节，新的风景。</p></body></html>');
  zip.file('OPS/text/three.xhtml','<html><body><h1>第三章 · 再出发</h1><p>我们继续向前走。</p></body></html>');
  zip.file('OPS/images/icon.png',readFileSync(new URL('../src-tauri/icons/128x128.png',import.meta.url)));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
const fixture3 = await makeBook(3), fixture2 = await makeBook(2);
const encrypted = await JSZip.loadAsync(fixture3);
encrypted.file('META-INF/encryption.xml','<encryption><EncryptedData><CipherData><CipherReference URI="OPS/text/one.xhtml"/></CipherData></EncryptedData></encryption>');
const drmFixture = await encrypted.generateAsync({type:'nodebuffer'});
const real = process.argv[2] ? readFileSync(process.argv[2]) : null;
const modules = new Map(['epub-book','epub-viewer'].map(name => [`/${name}`,stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8')).replaceAll('"jszip"','"/zip-module"')]));
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style"><script src="/jszip"></script><div class="document-viewport is-epub" style="display:block;height:100vh;overflow:auto;width:100%"><article class="document-host" id="host"></article></div><script type="module">
import {renderEpubViewer} from '/epub-viewer'; import {bookLink,readBookEntry} from '/epub-book';
window.result=(async()=>{
 const assert=(v,m)=>{if(!v)throw new Error(m)};const host=document.querySelector('#host'),viewport=host.parentElement;
 const activeUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
 URL.createObjectURL=(b)=>{const url=create(b);activeUrls.add(url);return url};URL.revokeObjectURL=(url)=>{activeUrls.delete(url);revoke(url)};
 const context=()=>({host,viewport,signal:new AbortController().signal,isActive:()=>true,setPageLabel:()=>{}});
 const wait=async(condition)=>{const end=performance.now()+5000;while(!condition()){if(performance.now()>end)throw new Error('chapter timeout');await new Promise(requestAnimationFrame)}};
 for(const bad of ['https://evil/x','javascript:alert(1)','//evil/x','../../../escape','file:///c:/x','%2f%2fevil'])assert(bookLink('OPS/text/ch.xhtml',bad)===null,'unsafe path '+bad);
 assert(bookLink('OPS/text/ch.xhtml','../images/a%20b.png').path==='OPS/images/a b.png','relative path');
 const bomb=new JSZip();bomb.file('huge','x'.repeat(20000));const compressed=await bomb.generateAsync({type:'arraybuffer',compression:'DEFLATE'});const parsed=await JSZip.loadAsync(compressed);
 let refused=false;try{await readBookEntry(parsed,'huge',100,new AbortController().signal)}catch{refused=true}assert(refused,'oversized entry accepted');
 parsed.file('huge')._data.uncompressedSize=1;refused=false;try{await readBookEntry(parsed,'huge',100,new AbortController().signal)}catch{refused=true}assert(refused,'forged ZIP size bypassed output limit');
 const abort=new AbortController();const inflating=readBookEntry(parsed,'huge',30000,abort.signal);abort.abort();refused=false;try{await inflating}catch(e){refused=e.name==='AbortError'}assert(refused,'inflate did not cancel');
 refused=false;try{await renderEpubViewer(await (await fetch('/drm')).arrayBuffer(),context())}catch(e){refused=e.message.includes('DRM')}assert(refused&&host.childElementCount===0,'encrypted content not rejected cleanly');
 for(const kind of ['epub3','epub2']){
   const viewer=await renderEpubViewer(await (await fetch('/'+kind)).arrayBuffer(),context());
   assert(viewer.label==='1/3','spine order');assert(host.querySelector('nav button').textContent.includes('慢下'),'TOC titles');
   assert(!window.evil&&!host.querySelector('script,iframe,style,link,[onload]'),'unsafe DOM retained');
   assert(!host.querySelector('img[src^="http"]'),'remote image retained');assert(host.querySelector('table'),'table missing');
   const internal=host.querySelector('a[data-book-path="OPS/text/two.xhtml"]');internal.click();await wait(()=>viewer.label==='2/3');
   const choices=host.querySelectorAll('nav button');choices[2].click();choices[0].click();await wait(()=>viewer.label==='1/3');
   viewer.destroy();assert(activeUrls.size===0&&host.childElementCount===0,'book resources leaked');
 }
 let realChapters=null;
 if(${!!real}){const book=await renderEpubViewer(await (await fetch('/real')).arrayBuffer(),context());realChapters=book.label;book.destroy();assert(activeUrls.size===0,'real book images leaked')}
 await renderEpubViewer(await (await fetch('/epub3')).arrayBuffer(),context());
 return {epub2:true,epub3:true,chapterNavigation:true,cleanup:true,untrustedContentBlocked:true,realChapters};
})();</script>`;
const server=createServer((req,res)=>{
 if(modules.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(modules.get(req.url));return;}
 if(req.url==='/zip-module'){res.setHeader('Content-Type','text/javascript');res.end('export default window.JSZip;');return;}
 if(req.url==='/jszip'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(new URL('../node_modules/jszip/dist/jszip.min.js',import.meta.url)));return;}
 if(['/epub3','/epub2','/real','/drm'].includes(req.url)){res.end(req.url==='/epub3'?fixture3:req.url==='/epub2'?fixture2:req.url==='/drm'?drmFixture:real);return;}
 if(req.url==='/style'){res.setHeader('Content-Type','text/css');res.end(readFileSync(new URL('../src/style.css',import.meta.url)));return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=mkdtempSync(join(tmpdir(),'quickpeek-epub-smoke-'));
const edge=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Edge startup timeout')),15000);edge.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});edge.on('error',reject)});
 const tab=await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
 let sequence=0;const pending=new Map(),external=[];
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}if(m.method==='Network.requestWillBeSent'&&m.params.request.url.startsWith('http')&&!m.params.request.url.startsWith('http://127.0.0.1:'))external.push(m.params.request.url)});
 const send=(method,params={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}))});
 await send('Page.enable');await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{width:850,height:1000,deviceScaleFactor:1,mobile:false});
 const loaded=new Promise(resolve=>socket.addEventListener('message',function ready(e){if(JSON.parse(e.data).method==='Page.loadEventFired'){socket.removeEventListener('message',ready);resolve()}}));await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await loaded;
 const result=await send('Runtime.evaluate',{expression:'window.result',awaitPromise:true,returnByValue:true,timeout:30000});assert.ok(!result.error&&!result.result.exceptionDetails,JSON.stringify(result));assert.ok(result.result.result.value);assert.deepEqual(external,[]);console.log(JSON.stringify(result.result.result.value));
 const screenshot=await send('Page.captureScreenshot',{format:'png'});const screenshotPath=join(profile,'epub-preview.png');writeFileSync(screenshotPath,Buffer.from(screenshot.result.data,'base64'));console.log(screenshotPath);
 void send('Browser.close');
}finally{socket?.close();edge.kill();server.closeAllConnections();server.close();}
