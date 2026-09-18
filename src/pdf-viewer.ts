import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PreviewDimensions } from "./document-formats";
import { previewTask } from "./preview-task";
import { PreviewWorkQueue } from "./preview-work-queue";

const MAX_RETAINED_PAGES = 7;
const pdfWork = new PreviewWorkQueue(1);

export type PdfViewerResult = {
  dimensions: PreviewDimensions | null;
  pageCount: number;
  destroy(): void;
};

function normalizeIpcBytes(payload: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  const source = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return buffer;
}

async function decodeImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return;
  await image.decode();
}

async function renderNativePdf(
  path: string,
  pages: PreviewDimensions[],
  previewWidth: number | undefined,
  host: HTMLElement,
  onPageChange: (page: number, count: number) => void,
  parentSignal: AbortSignal,
  generation?: number,
): Promise<PdfViewerResult> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([parentSignal, cancellation.signal]);
  signal.throwIfAborted();
  host.classList.add("is-pdf", "is-native-pdf");
  const viewer = document.createElement("div");
  viewer.className = "pdf-native-viewer";
  const pageElements = pages.map((dimensions, index) => {
    const page = document.createElement("figure");
    page.className = "pdf-native-page";
    page.dataset.pageIndex = String(index);
    page.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    const image = document.createElement("img");
    image.alt = `PDF page ${index + 1}`;
    image.draggable = false;
    const errorLabel = document.createElement("span");
    errorLabel.className = "pdf-native-page-error";
    errorLabel.hidden = true;
    page.append(image, errorLabel);
    viewer.append(page);
    return { image, page, errorLabel };
  });
  host.append(viewer);

  let destroyed = false;
  const rendered = new Set<number>();
  const rendering = new Map<number, Promise<void>>();
  const pageCancellations = new Map<number, AbortController>();
  const nearby = new Set<number>();
  const visibleRatios = new Map<number, number>();
  const renderOrder: number[] = [];
  const widths = new Map<number, number>();
  const targetWidth = (): number => Math.min(4096, Math.ceil(Math.max(64, viewer.clientWidth > 0 ? viewer.clientWidth - 16 : (previewWidth ?? 850) - 16) * window.devicePixelRatio));
  const abort = (): void => { destroyed = true; for (const { image } of pageElements) image.removeAttribute("src"); };
  signal.addEventListener("abort", abort, { once: true });

  const evictDistantPages = () => {
    const pixels = () => [...rendered].reduce((sum, i) => sum + pageElements[i].image.naturalWidth * pageElements[i].image.naturalHeight, 0);
    while (rendered.size > MAX_RETAINED_PAGES || pixels() > 12_000_000) {
      const candidatePosition = renderOrder.findIndex((index) => !nearby.has(index));
      if (candidatePosition < 0) return;
      const [candidate] = renderOrder.splice(candidatePosition, 1);
      if (candidate === undefined) return;
      const entry = pageElements[candidate];
      entry.page.classList.remove("is-ready");
      entry.image.removeAttribute("src");
      rendered.delete(candidate);
    }
  };

  const renderPage = (index: number): Promise<void> => {
    if (destroyed || (rendered.has(index) && widths.get(index) === targetWidth())) return Promise.resolve();
    const pending = rendering.get(index);
    if (pending) return pending;
    const entry = pageElements[index];
    if (!entry) return Promise.resolve();
    const pageCancellation = new AbortController();
    pageCancellations.set(index, pageCancellation);
    const pageSignal = AbortSignal.any([signal, pageCancellation.signal]);

    const task = (async () => {
      entry.errorLabel.hidden = true;
      // A first preview is rendered while the document viewport is display:none,
      // so clientWidth can be zero. Use the already-computed window width rather
      // than accidentally rasterizing the first page at the 64px fallback size.
      const requestedWidth = targetWidth();
      // Waiting for the lane is not rendering time. Native operations have
      // their own deadline; keep the lane occupied until they actually settle.
      const payload = await pdfWork.run(pageSignal, () => invoke<ArrayBuffer | Uint8Array | number[]>("render_pdf_page", {
        pageIndex: index,
        path,
        targetWidth: requestedWidth,
        generation,
      }), () => {
        const bounds = entry.page.getBoundingClientRect();
        const viewport = viewer.getBoundingClientRect();
        const visible = bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        return (visible ? 0 : 1_000_000) + Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
      });
      pageSignal.throwIfAborted();
      const imageUrl = URL.createObjectURL(
        new Blob([normalizeIpcBytes(payload)], { type: "image/png" }),
      );
      try {
        entry.image.src = imageUrl;
        await previewTask(decodeImage(entry.image), pageSignal);
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
      pageSignal.throwIfAborted();
      entry.page.classList.add("is-ready");
      rendered.add(index);
      widths.set(index, requestedWidth);
      const previous = renderOrder.indexOf(index);
      if (previous >= 0) renderOrder.splice(previous, 1);
      renderOrder.push(index);
      evictDistantPages();
    })().catch((error) => {
      entry.page.classList.remove("is-ready");
      entry.image.removeAttribute("src");
      if (!destroyed && !pageSignal.aborted) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => { void renderPage(index).catch(() => {}); });
        entry.errorLabel.replaceChildren("This page could not be displayed. ", retry);
        entry.errorLabel.hidden = false;
      }
      throw error;
    }).finally(() => {
      rendering.delete(index);
      pageCancellations.delete(index);
      if (!destroyed && nearby.has(index) && (pageSignal.aborted || (rendered.has(index) && widths.get(index) !== targetWidth()))) void renderPage(index).catch(() => {});
    });
    rendering.set(index, task);
    return task;
  };

  // The first page is decoded before the preview window is shown. Its first
  // visible frame is therefore already rendered at the final fitted width.
  try {
    await renderPage(0);
  } catch (error) {
    destroyed = true;
    signal.removeEventListener("abort", abort);
    viewer.remove();
    throw error;
  }

  const loadObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.pageIndex);
      if (entry.isIntersecting) {
        nearby.add(index);
      } else {
        nearby.delete(index);
        pageCancellations.get(index)?.abort();
      }
    }
    // Process the whole observation batch before scheduling, so old queued pages
    // are removed and visible pages are submitted before speculative neighbors.
    const viewport = viewer.getBoundingClientRect();
    const ordered = [...nearby].sort((a, b) => {
      const distance = (i: number) => {
        const rect = pageElements[i].page.getBoundingClientRect();
        return Math.abs((rect.top + rect.bottom - viewport.top - viewport.bottom) / 2);
      };
      return distance(a) - distance(b);
    });
    for (const index of ordered) void renderPage(index).catch(() => {});
    evictDistantPages();
  }, { root: viewer, rootMargin: "100% 0px" });

  const pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.pageIndex);
      if (entry.isIntersecting) visibleRatios.set(index, entry.intersectionRatio);
      else visibleRatios.delete(index);
    }
    let currentIndex = 0;
    let currentRatio = -1;
    for (const [index, ratio] of visibleRatios) {
      if (ratio > currentRatio) {
        currentIndex = index;
        currentRatio = ratio;
      }
    }
    onPageChange(currentIndex + 1, pages.length);
  }, { root: viewer, threshold: [0.1, 0.35, 0.6, 0.9] });

  for (const { page } of pageElements) {
    loadObserver.observe(page);
    pageObserver.observe(page);
  }
  let lastWidth = targetWidth();
  const resizeObserver = new ResizeObserver(() => {
    const width = targetWidth();
    if (width === lastWidth || destroyed) return;
    lastWidth = width;
    for (const index of nearby) void renderPage(index).catch(() => {});
  });
  resizeObserver.observe(viewer);

  return {
    dimensions: pages[0] ?? null,
    pageCount: pages.length,
    destroy() {
      cancellation.abort();
      destroyed = true;
      signal.removeEventListener("abort", abort);
      resizeObserver.disconnect();
      loadObserver.disconnect();
      pageObserver.disconnect();
      for (const { image, page } of pageElements) {
        page.classList.remove("is-ready");
        image.removeAttribute("src");
      }
      rendered.clear();
      nearby.clear();
      visibleRatios.clear();
      renderOrder.length = 0;
      viewer.remove();
    },
  };
}

async function renderBrowserPdf(
  url: string,
  dimensions: PreviewDimensions | null,
  host: HTMLElement,
  signal: AbortSignal,
): Promise<PdfViewerResult> {
  const frame = document.createElement("iframe");
  frame.className = "pdf-viewer";
  frame.title = "PDF document";
  host.classList.add("is-pdf");

  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.addEventListener("error", () => reject(new Error("Could not load PDF")), { once: true });
  });
  frame.src = `${url}#toolbar=0&view=FitH`;
  host.append(frame);
  try { await previewTask(loaded, signal); }
  catch (error) { frame.src = "about:blank"; frame.remove(); throw error; }

  return {
    dimensions,
    pageCount: 0,
    destroy() {
      frame.src = "about:blank";
      frame.remove();
    },
  };
}

export async function renderPdfViewer(
  url: string,
  path: string | undefined,
  pages: PreviewDimensions[] | undefined,
  dimensions: PreviewDimensions | null,
  previewWidth: number | undefined,
  host: HTMLElement,
  onPageChange: (page: number, count: number) => void,
  signal = new AbortController().signal,
  generation?: number,
): Promise<PdfViewerResult> {
  if (path && pages?.length && isTauri()) {
    return renderNativePdf(path, pages, previewWidth, host, onPageChange, signal, generation);
  }
  return renderBrowserPdf(url, dimensions, host, signal);
}
