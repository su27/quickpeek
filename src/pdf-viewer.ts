import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PreviewDimensions } from "./document-formats";

const MAX_RETAINED_PAGES = 7;

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
): Promise<PdfViewerResult> {
  host.classList.add("is-pdf", "is-native-pdf");
  const viewer = document.createElement("div");
  viewer.className = "pdf-native-viewer";
  const pageElements = pages.map((dimensions, index) => {
    const page = document.createElement("figure");
    page.className = "pdf-native-page";
    page.dataset.pageIndex = String(index);
    page.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    const image = document.createElement("img");
    image.alt = `PDF 第 ${index + 1} 页`;
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
  const nearby = new Set<number>();
  const visibleRatios = new Map<number, number>();
  const renderOrder: number[] = [];

  const evictDistantPages = () => {
    while (rendered.size > MAX_RETAINED_PAGES) {
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
    if (destroyed || rendered.has(index)) return Promise.resolve();
    const pending = rendering.get(index);
    if (pending) return pending;
    const entry = pageElements[index];
    if (!entry) return Promise.resolve();

    const task = (async () => {
      entry.errorLabel.hidden = true;
      // A first preview is rendered while the document viewport is display:none,
      // so clientWidth can be zero. Use the already-computed window width rather
      // than accidentally rasterizing the first page at the 64px fallback size.
      const measuredWidth = viewer.clientWidth > 0 ? viewer.clientWidth - 16 : 0;
      const cssWidth = Math.max(64, previewWidth ? previewWidth - 16 : measuredWidth);
      const targetWidth = Math.min(4096, Math.ceil(cssWidth * window.devicePixelRatio));
      const payload = await invoke<ArrayBuffer | Uint8Array | number[]>("render_pdf_page", {
        pageIndex: index,
        path,
        targetWidth,
      });
      if (destroyed) return;
      const imageUrl = URL.createObjectURL(
        new Blob([normalizeIpcBytes(payload)], { type: "image/png" }),
      );
      try {
        entry.image.src = imageUrl;
        await decodeImage(entry.image);
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
      if (destroyed) return;
      entry.page.classList.add("is-ready");
      rendered.add(index);
      const previous = renderOrder.indexOf(index);
      if (previous >= 0) renderOrder.splice(previous, 1);
      renderOrder.push(index);
      evictDistantPages();
    })().catch((error) => {
      entry.page.classList.remove("is-ready");
      entry.image.removeAttribute("src");
      if (!destroyed) {
        entry.errorLabel.textContent = "此页暂时无法显示";
        entry.errorLabel.hidden = false;
      }
      throw error;
    }).finally(() => rendering.delete(index));
    rendering.set(index, task);
    return task;
  };

  // The first page is decoded before the preview window is shown. Its first
  // visible frame is therefore already rendered at the final fitted width.
  try {
    await renderPage(0);
  } catch (error) {
    destroyed = true;
    viewer.remove();
    throw error;
  }

  const loadObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.pageIndex);
      if (entry.isIntersecting) {
        nearby.add(index);
        // Later-page failures belong to their placeholder, not an unhandled
        // rejection. Re-entering the viewport can retry the page normally.
        void renderPage(index).catch(() => {});
      } else {
        nearby.delete(index);
      }
    }
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

  return {
    dimensions: pages[0] ?? null,
    pageCount: pages.length,
    destroy() {
      destroyed = true;
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
): Promise<PdfViewerResult> {
  const frame = document.createElement("iframe");
  frame.className = "pdf-viewer";
  frame.title = "PDF 文档";
  host.classList.add("is-pdf");

  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.addEventListener("error", () => reject(new Error("PDF 加载失败")), { once: true });
  });
  frame.src = `${url}#toolbar=0&view=FitH`;
  host.append(frame);
  await loaded;

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
): Promise<PdfViewerResult> {
  if (path && pages?.length && isTauri()) {
    return renderNativePdf(path, pages, previewWidth, host, onPageChange);
  }
  return renderBrowserPdf(url, dimensions, host);
}
