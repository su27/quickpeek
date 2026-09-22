import { getDocument, PDFWorker, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PreviewDimensions } from "./document-formats";
import { previewTask } from "./preview-task";
import { PreviewWorkQueue } from "./preview-work-queue";

const SIDEBAR = 120, GAP = 16, MAX_PAGE_PIXELS = 8_000_000, MAX_CACHE_PIXELS = 20_000_000;
const work = new PreviewWorkQueue(1);
type Area = { x: number; y: number; width: number; height: number; scale: number; dpr: number };
type PageState = {
  index: number; figure: HTMLElement; thumbnail: HTMLButtonElement; thumbImage: HTMLElement;
  width: number; height: number; proxy?: PDFPageProxy; canvas?: HTMLCanvasElement; area?: Area;
  thumb?: HTMLCanvasElement; pending?: AbortController; thumbPending?: AbortController;
  used: number; failed: boolean;
};
export type PdfViewerResult = { dimensions: PreviewDimensions; pageCount: number; start(): void; destroy(): void };

function iconButton(label: string, path: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  return button;
}
function releaseCanvas(canvas?: HTMLCanvasElement): void {
  if (canvas) { canvas.remove(); canvas.width = canvas.height = 0; }
}
function scrollbarWidth(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll;visibility:hidden";
  document.body.append(probe); const width = probe.offsetWidth - probe.clientWidth; probe.remove();
  return width;
}

export async function renderPdfViewer(
  url: string, previewWidth: number | undefined, host: HTMLElement,
  onPageChange: (page: number, count: number) => void,
  parentSignal = new AbortController().signal,
): Promise<PdfViewerResult> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]); signal.throwIfAborted();
  const port = new Worker(workerUrl, { type: "module" });
  const worker = PDFWorker.create({ port });
  const resources = new URL("./pdfjs/", document.baseURI).href;
  const loading = getDocument({ url, worker, cMapUrl: `${resources}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${resources}standard_fonts/`, wasmUrl: `${resources}wasm/`, iccUrl: `${resources}iccs/`,
    disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024,
    canvasMaxAreaInBytes: 32 * 1024 * 1024, maxImageSize: 80_000_000, enableXfa: false });
  let disposed = false, started = false, documentPdf: PDFDocumentProxy;
  const states: PageState[] = [], renders = new Set<RenderTask>();
  const channel = new MessageChannel(), continuations: Array<() => void> = [];
  channel.port1.onmessage = () => { if (!disposed) continuations.shift()?.(); };
  const frame = document.createElement("section"); frame.className = "pdf-reader";
  // Staging can be inside display:none. Use the preflight size for the first
  // raster rather than showing a default size and fitting after presentation.
  if (previewWidth) frame.style.width = `${previewWidth}px`;
  const toolbar = document.createElement("div"); toolbar.className = "pdf-toolbar";
  const toggle = iconButton("Page thumbnails", "M3 4h18v16H3zM8 4v16"); toggle.setAttribute("aria-pressed", "true");
  const progress = document.createElement("span"); progress.className = "pdf-progress";
  const minus = iconButton("Zoom out", "M5 12h14"), plus = iconButton("Zoom in", "M5 12h14M12 5v14");
  const fit = iconButton("Fit width", "M8 5H4v14h4M16 5h4v14h-4M8 12h8m-6-3-3 3 3 3m4-6 3 3-3 3");
  const zoomLabel = document.createElement("span"); zoomLabel.className = "pdf-zoom-label"; zoomLabel.title = "Zoom relative to fit width";
  toolbar.append(toggle, progress, minus, zoomLabel, plus, fit);
  const sidebar = document.createElement("nav"); sidebar.className = "pdf-thumbnails"; sidebar.setAttribute("aria-label", "Page thumbnails");
  const viewport = document.createElement("div"); viewport.className = "pdf-pages"; viewport.tabIndex = 0; viewport.setAttribute("aria-label", "PDF pages");
  const stack = document.createElement("div"); stack.className = "pdf-page-stack"; viewport.append(stack);
  frame.append(toolbar, sidebar, viewport); host.classList.add("is-pdf"); host.append(frame);
  let zoom = 1, currentPage = 0, sidebarOpen = true, clock = 0;
  let fitWidth = Math.max(100, (previewWidth || host.clientWidth || 850) - SIDEBAR - GAP * 2 - scrollbarWidth());
  let resize: ResizeObserver | undefined, scheduled = false;
  const destroy = () => {
    if (disposed) return;
    disposed = true; lifetime.abort(); resize?.disconnect();
    for (const task of renders) task.cancel();
    continuations.length = 0; channel.port1.close(); channel.port2.close();
    for (const state of states) { state.pending?.abort(); state.thumbPending?.abort(); releaseCanvas(state.canvas); releaseCanvas(state.thumb); }
    void loading.destroy().catch(() => {}).finally(() => { worker.destroy(); port.terminate(); });
    signal.removeEventListener("abort", destroy); frame.remove();
  };
  signal.addEventListener("abort", destroy, { once: true });
  port.addEventListener("error", event => { console.error("PDF worker failed", event.message); lifetime.abort(new Error(event.message || "PDF worker failed")); });
  if (signal.aborted) { destroy(); signal.throwIfAborted(); }
  // Fit each page independently. A lazily discovered landscape page must not
  // widen the shared stack and shift all previously loaded portrait pages.
  const pageWidth = () => fitWidth * zoom;
  const layout = () => {
    // Fractional CSS pixels at Windows display scaling can otherwise leave an
    // empty horizontal scrollbar even when the fitted page is fully visible.
    viewport.style.overflowX = zoom <= 1 ? "hidden" : "auto";
    for (const state of states) {
      const width = pageWidth();
      state.figure.style.width = `${width}px`; state.figure.style.height = `${width * state.height / state.width}px`;
      // Keep the old raster visible during zoom until its replacement is ready.
      if (state.canvas && state.area) {
        const ratio = (width / state.width) / state.area.scale;
        Object.assign(state.canvas.style, { left: `${state.area.x * ratio}px`, top: `${state.area.y * ratio}px`,
          width: `${state.area.width * ratio}px`, height: `${state.area.height * ratio}px` });
      }
    }
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`; minus.disabled = zoom <= .25; plus.disabled = zoom >= 5;
  };
  const pageProxy = async (state: PageState, taskSignal: AbortSignal) => {
    if (state.proxy) return state.proxy;
    const proxy = await previewTask(documentPdf.getPage(state.index + 1), taskSignal);
    taskSignal.throwIfAborted(); state.proxy = proxy;
    const bounds = proxy.getViewport({ scale: 1 });
    if (state.width !== bounds.width || state.height !== bounds.height) {
      const anchor = states[currentPage], before = anchor.figure.offsetTop;
      state.width = bounds.width; state.height = bounds.height;
      state.thumbImage.style.aspectRatio = `${bounds.width}/${bounds.height}`;
      layout();
      viewport.scrollTop += anchor.figure.offsetTop - before;
    }
    return proxy;
  };
  const paint = async (proxy: PDFPageProxy, canvas: HTMLCanvasElement, area: Area, taskSignal: AbortSignal) => {
    const task = proxy.render({ canvas, viewport: proxy.getViewport({ scale: area.scale }),
      transform: [area.dpr, 0, 0, area.dpr, -area.x * area.dpr, -area.y * area.dpr], background: "rgb(255,255,255)" });
    renders.add(task);
    // Task yielding works even when a hidden native window has no animation
    // frames. This is cooperative scheduling, not a presentation delay.
    task.onContinue = (resume: () => void) => { continuations.push(resume); channel.port2.postMessage(null); };
    const cancel = () => task.cancel(); taskSignal.addEventListener("abort", cancel, { once: true });
    if (taskSignal.aborted) cancel();
    try { await previewTask(task.promise, taskSignal, 15000); }
    finally { task.cancel(); await task.promise.catch(() => {}); renders.delete(task); taskSignal.removeEventListener("abort", cancel); }
  };
  const visibleArea = (state: PageState): Area => {
    const width = pageWidth(), height = width * state.height / state.width;
    const scale = width / state.width, dpr = window.devicePixelRatio || 1;
    if (width * height * dpr * dpr <= MAX_PAGE_PIXELS) return { x: 0, y: 0, width, height, scale, dpr };
    const rect = state.figure.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    const x = Math.max(0, Math.floor((view.left - rect.left - 128) / 64) * 64);
    const y = Math.max(0, Math.floor((view.top - rect.top - 128) / 64) * 64);
    // High zoom uses a full-resolution visible-region raster, never a stretched
    // low-resolution whole-page image. The surrounding margin allows scrolling.
    return { x, y, width: Math.max(1, Math.min(width - x, (viewport.clientWidth || fitWidth) + 256)),
      height: Math.max(1, Math.min(height - y, (viewport.clientHeight || 900) + 256)), scale, dpr };
  };
  const covers = (old: Area | undefined, area: Area) => old && old.scale === area.scale && old.dpr === area.dpr &&
    old.x <= area.x && old.y <= area.y && old.x + old.width >= area.x + area.width && old.y + old.height >= area.y + area.height;
  const evict = () => {
    const cached = states.filter(s => s.canvas).sort((a,b) => a.used-b.used);
    let pixels = cached.reduce((sum,s) => sum+s.canvas!.width*s.canvas!.height,0), count = cached.length;
    for (const state of cached) {
      if (count <= 5 && pixels <= MAX_CACHE_PIXELS) break;
      if (Math.abs(state.index-currentPage) <= 1) continue;
      pixels -= state.canvas!.width*state.canvas!.height; count--;
      releaseCanvas(state.canvas); state.canvas = undefined; state.area = undefined; state.figure.classList.remove("is-ready");
      if (!state.pending && !state.thumbPending) { state.proxy?.cleanup(); state.proxy = undefined; }
    }
    let thumbs = states.filter(s => s.thumb).length;
    for (const state of states) {
      if (thumbs <= 30) break;
      if (!state.thumb || Math.abs(state.thumbnail.offsetTop-sidebar.scrollTop) < sidebar.clientHeight*3 || state.index === currentPage) continue;
      releaseCanvas(state.thumb); state.thumb = undefined; thumbs--;
      if (!state.canvas && !state.pending && !state.thumbPending) { state.proxy?.cleanup(); state.proxy = undefined; }
    }
    // Cancelled page requests can have decoded resources without a canvas.
    for (const state of states) {
      if (!state.canvas && !state.pending && !state.thumbPending && state.proxy?.cleanup()) state.proxy = undefined;
    }
  };
  const renderPage = (state: PageState, initial = false): Promise<void> => {
    if (disposed || state.pending || state.failed || covers(state.area, visibleArea(state))) return Promise.resolve();
    const controller = new AbortController(); state.pending = controller;
    const taskSignal = AbortSignal.any([signal,controller.signal]);
    return work.run(taskSignal, async () => {
      let canvas: HTMLCanvasElement | undefined;
      try {
        const proxy = await pageProxy(state,taskSignal); taskSignal.throwIfAborted();
        const area = visibleArea(state);
        canvas = document.createElement("canvas"); canvas.width = Math.ceil(area.width*area.dpr); canvas.height = Math.ceil(area.height*area.dpr);
        await paint(proxy,canvas,area,taskSignal); taskSignal.throwIfAborted();
        Object.assign(canvas.style,{ left:`${area.x}px`,top:`${area.y}px`,width:`${area.width}px`,height:`${area.height}px` });
        releaseCanvas(state.canvas); state.canvas = canvas; canvas = undefined; state.area = area; state.used = ++clock;
        state.figure.replaceChildren(state.canvas); state.figure.classList.add("is-ready"); evict();
      } finally { releaseCanvas(canvas); }
    }, () => Math.abs(state.index-currentPage)).catch(error => {
      if (!disposed && !taskSignal.aborted) {
        state.failed = true;
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "pdf-page-error";
        retry.textContent = "Could not display this page · Retry";
        retry.onclick = () => { state.failed = false; retry.remove(); void renderPage(state).catch(() => {}); };
        state.figure.append(retry);
      }
      if (initial) throw error;
    }).finally(() => { if (state.pending === controller) state.pending = undefined; if (started && !disposed) schedule(); });
  };
  const renderThumb = (state: PageState) => {
    if (state.thumb || state.thumbPending || disposed) return;
    const controller = new AbortController(); state.thumbPending = controller;
    const taskSignal = AbortSignal.any([signal,controller.signal]);
    void work.run(taskSignal, async () => {
      let canvas: HTMLCanvasElement | undefined;
      try {
        const proxy = await pageProxy(state,taskSignal); taskSignal.throwIfAborted();
        const scale = 84/state.width,dpr = Math.min(window.devicePixelRatio || 1,2);
        const area = {x:0,y:0,width:84,height:84*state.height/state.width,scale,dpr};
        canvas = document.createElement("canvas"); canvas.width = Math.ceil(area.width*dpr); canvas.height = Math.ceil(area.height*dpr);
        await paint(proxy,canvas,area,taskSignal); taskSignal.throwIfAborted();
        state.thumb = canvas; canvas = undefined; state.thumbImage.replaceChildren(state.thumb);
        // A small thumbnail must not retain the full-size decoded PDF images.
        if (!state.canvas && !state.pending && proxy.cleanup()) state.proxy = undefined;
        evict();
      } finally { releaseCanvas(canvas); }
    }, () => 10000+Math.abs(state.index-currentPage)).catch(() => {
      // The numbered navigation button stays usable if a thumbnail fails.
    }).finally(() => { if (state.thumbPending === controller) state.thumbPending = undefined; });
  };
  const update = () => {
    if (!started || disposed) return;
    const view = viewport.getBoundingClientRect();
    let best = 0,bestArea = -1;
    const nearby = new Set<PageState>();
    for (const state of states) {
      const rect = state.figure.getBoundingClientRect();
      const overlap = Math.max(0,Math.min(view.bottom,rect.bottom)-Math.max(view.top,rect.top));
      if (overlap > bestArea) { best = state.index; bestArea = overlap; }
      if (rect.bottom > view.top-100 && rect.top < view.bottom+100) nearby.add(state);
    }
    if (currentPage !== best) {
      states[currentPage].thumbnail.removeAttribute("aria-current"); currentPage = best;
      const selected = states[currentPage].thumbnail;
      if (sidebarOpen && (selected.offsetTop < sidebar.scrollTop || selected.offsetTop + selected.offsetHeight > sidebar.scrollTop + sidebar.clientHeight)) {
        sidebar.scrollTop = selected.offsetTop - (sidebar.clientHeight - selected.offsetHeight) / 2;
      }
    }
    states[currentPage].thumbnail.setAttribute("aria-current","page");
    progress.textContent = `${currentPage+1} / ${states.length}`; onPageChange(currentPage+1,states.length);
    for (const state of states) if (!nearby.has(state)) state.pending?.abort();
    for (const state of [...nearby].sort((a,b) => Math.abs(a.index-best)-Math.abs(b.index-best))) void renderPage(state).catch(() => {});
    const pagesReady = [...nearby].every(state => state.failed || covers(state.area, visibleArea(state)));
    const thumbView = sidebar.getBoundingClientRect();
    for (const state of states) {
      const rect = state.thumbnail.getBoundingClientRect();
      if (pagesReady && sidebarOpen && rect.bottom > thumbView.top-100 && rect.top < thumbView.bottom+100) renderThumb(state);
      else state.thumbPending?.abort();
    }
    evict();
  };
  function schedule() {
    if (scheduled || disposed || !started) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; update(); });
  }
  const anchoredLayout = (change: () => void,clientX?: number,clientY?: number) => {
    const view = viewport.getBoundingClientRect();
    const state = states.find(s => { const r=s.figure.getBoundingClientRect(); return r.top <= (clientY ?? view.top+40) && r.bottom > (clientY ?? view.top+40); }) ?? states[currentPage];
    const rect = state.figure.getBoundingClientRect();
    const x = clientX ?? view.left+view.width/2,y = clientY ?? Math.max(view.top+40,rect.top);
    const fx = (x-rect.left)/rect.width,fy = (y-rect.top)/rect.height;
    for (const item of states) item.pending?.abort();
    change(); layout();
    const after = state.figure.getBoundingClientRect();
    viewport.scrollLeft += after.left+fx*after.width-x; viewport.scrollTop += after.top+fy*after.height-y;
    schedule();
  };
  const setZoom = (value: number,x?: number,y?: number) => anchoredLayout(() => { zoom = Math.max(.25,Math.min(5,value)); },x,y);
  minus.onclick = () => setZoom(zoom/1.2); plus.onclick = () => setZoom(zoom*1.2); fit.onclick = () => setZoom(1);
  toggle.onclick = () => anchoredLayout(() => {
    sidebarOpen = !sidebarOpen; frame.classList.toggle("without-thumbnails",!sidebarOpen);
    toggle.setAttribute("aria-pressed",String(sidebarOpen)); fitWidth = Math.max(100,viewport.clientWidth-GAP*2);
  });
  viewport.addEventListener("wheel",event => {
    if (!event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation(); setZoom(zoom*Math.exp(-event.deltaY*.002),event.clientX,event.clientY);
  },{passive:false});
  viewport.addEventListener("keydown",event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (["+","=","-","0"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setZoom(event.key === "0" ? 1 : zoom*(event.key === "-" ? 1/1.2 : 1.2)); }
  });
  viewport.addEventListener("scroll",schedule,{passive:true}); sidebar.addEventListener("scroll",schedule,{passive:true});
  try {
    documentPdf = await previewTask(loading.promise,signal,20000);
    if (documentPdf.numPages > 10000) throw new Error("PDF has too many pages to preview");
    const first = await previewTask(documentPdf.getPage(1),signal);
    const dimensions = first.getViewport({scale:1});
    for (let index=0; index<documentPdf.numPages; index++) {
      const figure = document.createElement("figure"); figure.className = "pdf-page"; figure.dataset.pageIndex = String(index);
      const thumbnail = document.createElement("button"); thumbnail.type = "button"; thumbnail.className = "pdf-thumbnail";
      thumbnail.title = `Page ${index+1}`; thumbnail.setAttribute("aria-label",thumbnail.title);
      const thumbImage = document.createElement("span"); thumbImage.className = "pdf-thumbnail-image"; thumbImage.style.aspectRatio = `${dimensions.width}/${dimensions.height}`;
      const number = document.createElement("span"); number.textContent = String(index+1); thumbnail.append(thumbImage,number);
      thumbnail.onclick = () => { viewport.scrollTop = figure.offsetTop-stack.offsetTop; schedule(); };
      stack.append(figure); sidebar.append(thumbnail);
      states.push({index,figure,thumbnail,thumbImage,width:dimensions.width,height:dimensions.height,
        proxy:index === 0 ? first : undefined,used:0,failed:false});
    }
    layout(); progress.textContent = `1 / ${states.length}`; states[0].thumbnail.setAttribute("aria-current","page");
    await renderPage(states[0],true); signal.throwIfAborted();
    return {dimensions:{width:dimensions.width,height:dimensions.height},pageCount:states.length,
      start() {
        if (disposed || started) return; started = true; frame.style.width = "100%";
        const resized = () => {
          if (disposed || viewport.clientWidth <= 0) return;
          const nextWidth = Math.max(100,viewport.clientWidth-GAP*2);
          if (Math.abs(nextWidth-fitWidth) > 1) anchoredLayout(() => { fitWidth = nextWidth; }); else schedule();
        };
        resize = new ResizeObserver(resized); resize.observe(viewport); resized();
      },destroy};
  } catch (error) { destroy(); throw error; }
}
