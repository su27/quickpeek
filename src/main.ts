import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  acceptedFileExtensions,
  fileInfoDocumentFormat,
  findDocumentFormat,
  mimeTypeFor,
  type DocumentFormat,
  type DocumentKind,
  type PreviewSource,
  type RenderedDocument,
  type ShellIcon,
} from "./document-formats";
import {
  imageOverflowMode,
  MIN_READABLE_IMAGE_HEIGHT,
  MIN_READABLE_IMAGE_WIDTH,
} from "./image-layout";
import type { SearchStatus } from "./viewer-types";
import "./style.css";

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const fileInput = $<HTMLInputElement>("#fileInput");
const app = $<HTMLElement>("#app");
const emptyOpenButton = $<HTMLButtonElement>("#emptyOpenButton");
const workspace = $<HTMLElement>("#workspace");
const documentViewport = $<HTMLElement>("#documentViewport");
let documentHost = $<HTMLElement>("#documentHost");
const toast = $<HTMLElement>("#toast");
const searchInput = $<HTMLInputElement>("#searchInput");
const searchCount = $<HTMLElement>("#searchCount");
const previousMatch = $<HTMLButtonElement>("#previousMatch");
const nextMatch = $<HTMLButtonElement>("#nextMatch");

type ActiveDocument = {
  format: DocumentFormat;
  isDirectory: boolean;
  name: string;
  pageElements: HTMLElement[];
  rendered: RenderedDocument;
  size: number;
};

type NativePreviewRequest = {
  isDirectory: boolean;
  modifiedAt?: number;
  path: string;
  size: number;
};

let activeDocument: ActiveDocument | null = null;
let currentPageLabel = "";
let lastWindowTitle = "";
let dragDepth = 0;
let toastTimer = 0;
let searchTimer = 0;
let matchRanges: Range[] = [];
let currentMatch = -1;
let pageIndicatorFrame = 0;
let queuedNativeRequest: NativePreviewRequest | null = null;
let nativeLoadInProgress = false;
let loadSequence = 0;

const MAX_PREVIEW_WORK_AREA_WIDTH = 0.94;
const MAX_PREVIEW_WORK_AREA_HEIGHT = 0.92;
const READING_PREVIEW_WIDTH = 850;

fileInput.accept = acceptedFileExtensions();

type HighlightRegistry = {
  clear(): void;
  delete(name: string): boolean;
  set(name: string, highlight: unknown): void;
};

type HighlightConstructor = new (...ranges: Range[]) => unknown;

const highlightRegistry = (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights;
const HighlightClass = (window as typeof window & { Highlight?: HighlightConstructor }).Highlight;

function openPicker(): void {
  fileInput.value = "";
  fileInput.click();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compactPageLabel(label: string): string {
  return label.replace(/\s*\/\s*/g, "/").trim();
}

function updateWindowTitle(): void {
  const title = activeDocument
    ? `${activeDocument.name} - ${activeDocument.isDirectory ? "文件夹" : formatBytes(activeDocument.size)}${currentPageLabel ? ` ${currentPageLabel}` : ""}`
    : "QuickPeek";
  if (title === lastWindowTitle) return;

  lastWindowTitle = title;
  document.title = title;
  if (isTauri()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (lastWindowTitle !== title) return;
        return getCurrentWindow().setTitle(title);
      })
      .catch((error) => console.warn("无法更新窗口标题", error));
  }
}

function setPageLabel(label: string): void {
  currentPageLabel = compactPageLabel(label);
  updateWindowTitle();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function measurePreviewDimensions(kind: DocumentKind): { height: number; width: number } | null {
  if (activeDocument?.rendered.previewDimensions) {
    return activeDocument.rendered.previewDimensions;
  }

  const selector = kind === "docx"
    ? "section.docx"
    : kind === "pptx"
      ? "[data-slide-index]"
      : null;
  if (!selector) return null;

  const element = documentHost.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const bounds = element.getBoundingClientRect();
  if (kind === "docx") {
    const styles = window.getComputedStyle(element);
    const pageHeight = Number.parseFloat(styles.minHeight);
    if (bounds.width > 0 && Number.isFinite(pageHeight) && pageHeight > 0) {
      return { width: bounds.width, height: pageHeight };
    }
  }
  return bounds.width > 0 && bounds.height > 0
    ? { width: bounds.width, height: bounds.height }
    : null;
}

async function resizeWindowForPreview(kind: DocumentKind): Promise<void> {
  if (!isTauri()) return;

  try {
    await nextPaint();
    const { currentMonitor, getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    const monitor = await currentMonitor();
    if (!monitor) return;

    const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
    const maximumWidth = Math.max(320, workArea.width * MAX_PREVIEW_WORK_AREA_WIDTH);
    const maximumHeight = Math.max(220, workArea.height * MAX_PREVIEW_WORK_AREA_HEIGHT);
    const dimensions = measurePreviewDimensions(kind);
    let width: number;
    let height: number;

    if (kind === "image" && dimensions) {
      const fitScale = Math.min(
        maximumWidth / dimensions.width,
        maximumHeight / dimensions.height,
      );
      const overflowMode = imageOverflowMode(
        dimensions.width,
        dimensions.height,
        maximumWidth,
        maximumHeight,
      );
      if (overflowMode === "scroll-y") {
        width = Math.min(maximumWidth, MIN_READABLE_IMAGE_WIDTH);
        height = maximumHeight;
      } else if (overflowMode === "scroll-x") {
        width = maximumWidth;
        height = Math.min(maximumHeight, MIN_READABLE_IMAGE_HEIGHT);
      } else {
        const comfortableScale = Math.max(
          1,
          MIN_READABLE_IMAGE_WIDTH / dimensions.width,
          MIN_READABLE_IMAGE_HEIGHT / dimensions.height,
        );
        const scale = Math.min(fitScale, comfortableScale);
        width = dimensions.width * scale;
        height = dimensions.height * scale;
      }
    } else if (kind === "video" && dimensions) {
      const fitScale = Math.min(
        maximumWidth / dimensions.width,
        maximumHeight / dimensions.height,
      );
      const comfortableScale = Math.max(
        1,
        Math.min(1.75, 640 / dimensions.width, 360 / dimensions.height),
      );
      const scale = Math.min(fitScale, comfortableScale);
      width = dimensions.width * scale;
      height = dimensions.height * scale;
    } else if (kind === "audio") {
      width = Math.min(maximumWidth, 620);
      height = Math.min(maximumHeight, 300);
    } else if (kind === "file" || kind === "folder") {
      width = Math.min(maximumWidth, 540);
      height = Math.min(maximumHeight, 360);
    } else if (kind === "pdf" && dimensions) {
      const ratio = dimensions.width / dimensions.height;
      width = clamp(workArea.width * 0.72, Math.min(720, maximumWidth), maximumWidth);
      height = width / ratio;
      if (height > maximumHeight) {
        height = maximumHeight;
        width = height * ratio;
      }
    } else if (kind === "pdf") {
      width = clamp(workArea.width * 0.72, Math.min(720, maximumWidth), maximumWidth);
      height = maximumHeight;
    } else if (kind === "docx") {
      width = clamp(READING_PREVIEW_WIDTH, Math.min(460, maximumWidth), maximumWidth);
      height = dimensions
        ? clamp(dimensions.height + 32, Math.min(360, maximumHeight), maximumHeight)
        : clamp(workArea.height * 0.76, Math.min(440, maximumHeight), maximumHeight);
    } else if (kind === "text") {
      width = clamp(READING_PREVIEW_WIDTH, Math.min(460, maximumWidth), maximumWidth);
      height = maximumHeight;
    } else if (kind === "pptx" && dimensions) {
      const ratio = dimensions.width / dimensions.height;
      width = maximumWidth;
      height = width / ratio;
      if (height > maximumHeight) {
        height = maximumHeight;
        width = height * ratio;
      }
    } else {
      width = clamp(workArea.width * 0.78, Math.min(640, maximumWidth), maximumWidth);
      height = clamp(workArea.height * 0.76, Math.min(440, maximumHeight), maximumHeight);
    }

    const appWindow = getCurrentWindow();
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
    await appWindow.setSize(new LogicalSize(Math.round(width), Math.round(height)));
    await appWindow.center();
    await nextPaint();
  } catch (error) {
    console.warn("无法自动调整预览窗口", error);
  }
}

function normalizeIpcBytes(payload: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  const source = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return buffer;
}

async function loadShellIcon(path: string): Promise<ShellIcon | undefined> {
  try {
    const payload = await invoke<ArrayBuffer | Uint8Array | number[]>("read_shell_icon", { path });
    const bytes = normalizeIpcBytes(payload);
    if (bytes.byteLength < 8) return undefined;
    const view = new DataView(bytes);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const expectedBytes = width * height * 4;
    if (width === 0 || height === 0 || bytes.byteLength !== expectedBytes + 8) return undefined;
    const pixels = new Uint8ClampedArray(expectedBytes);
    pixels.set(new Uint8Array(bytes, 8));
    return { height, pixels, width };
  } catch (error) {
    reportFrontendError(`read Windows icon for ${path}`, error);
    return undefined;
  }
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setControlsEnabled(enabled: boolean): void {
  searchInput.disabled = !enabled;
  if (!enabled) {
    previousMatch.disabled = true;
    nextMatch.disabled = true;
  }
}

function configureControlsForFormat(format: DocumentFormat): void {
  searchInput.disabled = !format.searchable;
  if (!format.searchable) {
    previousMatch.disabled = true;
    nextMatch.disabled = true;
  }
}

function applySearchStatus(status: SearchStatus): void {
  searchCount.textContent = status.total > 0 ? `${status.current} / ${status.total}` : "0 / 0";
  previousMatch.disabled = status.total === 0;
  nextMatch.disabled = status.total === 0;
}

function clearSearch(): void {
  window.clearTimeout(searchTimer);
  matchRanges = [];
  currentMatch = -1;
  searchCount.textContent = "";
  previousMatch.disabled = true;
  nextMatch.disabled = true;
  activeDocument?.rendered.controller?.clearSearch();
  highlightRegistry?.delete("docx-search-results");
  highlightRegistry?.delete("docx-search-current");
}

function openSearch(): void {
  if (!activeDocument?.format.searchable) return;
  app.classList.add("is-search-open");
  window.requestAnimationFrame(() => {
    searchInput.focus();
    searchInput.select();
  });
}

function closeSearch(): void {
  app.classList.remove("is-search-open");
  searchInput.value = "";
  searchInput.blur();
  clearSearch();
}

function destroyRenderedDocument(rendered: RenderedDocument | undefined): void {
  if (!rendered) return;
  try {
    rendered.destroy();
  } catch (error) {
    reportFrontendError("dispose preview", error);
  }
}

function keepSourceAlive(
  rendered: RenderedDocument,
  release: (() => void) | undefined,
): RenderedDocument {
  if (!release) return rendered;
  let released = false;
  return {
    ...rendered,
    destroy() {
      try {
        rendered.destroy();
      } finally {
        if (!released) {
          released = true;
          release();
        }
      }
    },
  };
}

function clearRenderedDocument(): void {
  if (pageIndicatorFrame) cancelAnimationFrame(pageIndicatorFrame);
  pageIndicatorFrame = 0;
  const previous = activeDocument;
  activeDocument = null;
  destroyRenderedDocument(previous?.rendered);
  documentHost.replaceChildren();
  documentHost.className = "document-host";
  documentViewport.className = "document-viewport";
  documentViewport.scrollTop = 0;
  documentViewport.scrollLeft = 0;
}

function resetViewer(): void {
  closeSearch();
  clearRenderedDocument();
  currentPageLabel = "";
  updateWindowTitle();
  workspace.classList.add("is-empty");
  workspace.classList.remove("has-document");
  setControlsEnabled(false);
}

function countDocxPages(): number {
  const sections = activeDocument?.pageElements.length ?? 0;
  if (sections > 0) return sections;
  return documentHost.childElementCount > 0 ? 1 : 0;
}

function updatePageIndicator(): void {
  const controller = activeDocument?.rendered.controller;
  if (controller) {
    setPageLabel(controller.getPageLabel());
    return;
  }

  const fixedPageLabel = activeDocument?.rendered.fixedPageLabel;
  if (fixedPageLabel !== null && fixedPageLabel !== undefined) {
    setPageLabel(fixedPageLabel);
    return;
  }

  const pages = activeDocument?.pageElements ?? [];
  if (pages.length === 0) {
    setPageLabel(documentHost.childElementCount > 0 ? "1/1 页" : "0/0 页");
    return;
  }

  const viewport = documentViewport.getBoundingClientRect();
  const viewportCenter = viewport.top + viewport.height / 2;
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const bounds = pages[middle].getBoundingClientRect();
    if (bounds.top + bounds.height / 2 < viewportCenter) low = middle + 1;
    else high = middle;
  }
  let nearestPage = low;
  if (low > 0) {
    const current = pages[low].getBoundingClientRect();
    const previous = pages[low - 1].getBoundingClientRect();
    const currentDistance = Math.abs(current.top + current.height / 2 - viewportCenter);
    const previousDistance = Math.abs(previous.top + previous.height / 2 - viewportCenter);
    if (previousDistance < currentDistance) nearestPage = low - 1;
  }

  setPageLabel(`${nearestPage + 1}/${pages.length} 页`);
}

function schedulePageIndicatorUpdate(): void {
  if (pageIndicatorFrame) return;
  pageIndicatorFrame = window.requestAnimationFrame(() => {
    pageIndicatorFrame = 0;
    updatePageIndicator();
  });
}

function discardStagedDocument(
  host: HTMLElement | null,
  rendered: RenderedDocument | null,
): void {
  destroyRenderedDocument(rendered ?? undefined);
  host?.remove();
}

function commitStagedDocument(
  host: HTMLElement,
  rendered: RenderedDocument,
  source: PreviewSource,
  format: DocumentFormat,
): void {
  const oldHost = documentHost;
  const oldDocument = activeDocument;

  oldHost.removeAttribute("id");
  host.id = "documentHost";
  host.classList.remove("is-staging");
  host.removeAttribute("aria-hidden");
  oldHost.replaceWith(host);
  documentHost = host;

  activeDocument = {
    format,
    isDirectory: source.isDirectory === true,
    name: source.name,
    pageElements: format.kind === "docx"
      ? Array.from(host.querySelectorAll<HTMLElement>("section.docx"))
      : [],
    rendered,
    size: source.size,
  };
  currentPageLabel = "";

  documentViewport.className = `document-viewport is-${format.kind}`;
  documentViewport.scrollTop = 0;
  documentViewport.scrollLeft = 0;
  workspace.classList.remove("is-empty");
  workspace.classList.add("has-document");

  destroyRenderedDocument(oldDocument?.rendered);
  oldHost.replaceChildren();
}

async function loadPreview(
  format: DocumentFormat,
  request: number,
  readSource: () => Promise<PreviewSource>,
  errorContext: string,
  showFailureToast = true,
): Promise<boolean> {
  closeSearch();
  let host: HTMLElement | null = null;
  let rendered: RenderedDocument | null = null;
  let releaseSource: (() => void) | undefined;

  try {
    const source = await readSource();
    releaseSource = source.release;
    if (request !== loadSequence) {
      discardStagedDocument(host, rendered);
      return false;
    }

    host = document.createElement("article");
    host.className = "document-host is-staging";
    host.setAttribute("aria-hidden", "true");
    documentViewport.append(host);
    const formatRendered = await format.render(source, {
      host,
      viewport: documentViewport,
      isActive: () => host === documentHost,
      setPageLabel,
    });
    rendered = keepSourceAlive(formatRendered, releaseSource);
    releaseSource = undefined;
    if (request !== loadSequence) {
      discardStagedDocument(host, rendered);
      return false;
    }

    commitStagedDocument(host, rendered, source, format);
    setControlsEnabled(true);
    configureControlsForFormat(format);

    if (format.kind === "docx") {
      const pages = countDocxPages();
      setPageLabel(pages > 0 ? `1/${pages} 页` : "0/0 页");
    } else {
      updatePageIndicator();
    }

    await resizeWindowForPreview(format.kind);
    return request === loadSequence && activeDocument?.rendered === rendered;
  } catch (error) {
    reportFrontendError(errorContext, error);
    discardStagedDocument(host, rendered);
    if (!activeDocument) {
      resetViewer();
      setPageLabel("打开失败");
    } else {
      setControlsEnabled(true);
      configureControlsForFormat(activeDocument.format);
    }
    if (showFailureToast) {
      showToast("文件打开失败，请确认文件未损坏且格式受支持", "error");
    }
    return false;
  } finally {
    releaseSource?.();
  }
}

async function loadFile(file: File, request: number): Promise<boolean> {
  const format = findDocumentFormat(file.name);

  return loadPreview(
    format,
    request,
    async () => {
      if (format.loadMode === "metadata") {
        return {
          type: "metadata" as const,
          mimeType: file.type || "application/octet-stream",
          modifiedAt: file.lastModified,
          name: file.name,
          size: file.size,
        };
      }
      if (format.loadMode === "url") {
        const url = URL.createObjectURL(file);
        return {
          type: "url" as const,
          url,
          release: () => URL.revokeObjectURL(url),
          mimeType: file.type || mimeTypeFor(file.name, format),
          modifiedAt: file.lastModified,
          name: file.name,
          size: file.size,
        };
      }
      const end = Math.min(file.size, format.maxReadBytes ?? file.size);
      return {
        type: "buffer" as const,
        bytes: await file.slice(0, end).arrayBuffer(),
        mimeType: file.type || mimeTypeFor(file.name, format),
        modifiedAt: file.lastModified,
        name: file.name,
        size: file.size,
      };
    },
    `open ${file.name}`,
  );
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function reportFrontendError(context: string, error: unknown): void {
  console.error(error);
  if (!isTauri()) return;

  const details = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);
  void invoke("log_frontend_error", { message: `${context}: ${details}` });
}

async function loadDocumentFromPath(
  preview: NativePreviewRequest,
  request: number,
): Promise<void> {
  const { isDirectory, modifiedAt, path, size: sourceSize } = preview;
  const name = fileNameFromPath(path);
  const format = findDocumentFormat(name, isDirectory);
  let shellIconPromise: Promise<ShellIcon | undefined> | null = null;
  const metadataSource = async (): Promise<PreviewSource> => ({
    type: "metadata",
    isDirectory,
    mimeType: isDirectory ? "inode/directory" : "application/octet-stream",
    modifiedAt,
    name,
    path,
    shellIcon: await (shellIconPromise ??= loadShellIcon(path)),
    size: sourceSize,
  });

  const loaded = await loadPreview(
    format,
    request,
    async () => {
      if (format.loadMode === "metadata") {
        return metadataSource();
      }
      if (format.loadMode === "url") {
        await invoke("allow_preview_asset", { path });
        return {
          type: "url" as const,
          isDirectory,
          url: convertFileSrc(path),
          mimeType: mimeTypeFor(name, format),
          modifiedAt,
          name,
          path,
          size: sourceSize,
        };
      }
      const payload = await invoke<ArrayBuffer | Uint8Array | number[]>("read_preview_file", { path });
      return {
        type: "buffer" as const,
        bytes: normalizeIpcBytes(payload),
        isDirectory,
        mimeType: mimeTypeFor(name, format),
        modifiedAt,
        name,
        path,
        size: sourceSize,
      };
    },
    `open ${path}`,
    false,
  );
  if (loaded) {
    await invoke("show_preview_window");
    return;
  }

  if (request !== loadSequence || format.kind === "file" || format.kind === "folder") return;
  const fallbackLoaded = await loadPreview(
    fileInfoDocumentFormat(isDirectory),
    request,
    metadataSource,
    `show file information for ${path}`,
  );
  if (fallbackLoaded) await invoke("show_preview_window");
}

async function enqueueNativePreview(preview: NativePreviewRequest): Promise<void> {
  queuedNativeRequest = preview;
  loadSequence += 1;
  if (nativeLoadInProgress) return;

  nativeLoadInProgress = true;
  try {
    while (queuedNativeRequest) {
      const nextPreview = queuedNativeRequest;
      const request = loadSequence;
      queuedNativeRequest = null;
      await loadDocumentFromPath(nextPreview, request);
    }
  } finally {
    nativeLoadInProgress = false;
  }
}

async function initializeNativePreview(): Promise<void> {
  if (!isTauri()) return;

  const { listen } = await import("@tauri-apps/api/event");
  await listen<NativePreviewRequest>("preview-file", (event) => {
    void enqueueNativePreview(event.payload);
  });
  await listen("preview-hidden", () => {
    loadSequence += 1;
    queuedNativeRequest = null;
    resetViewer();
  });

  const initialPreview = await invoke<NativePreviewRequest | null>("get_initial_preview");
  if (initialPreview) await enqueueNativePreview(initialPreview);
}

function collectTextRanges(query: string): Range[] {
  const ranges: Range[] = [];
  const normalized = query.toLocaleLowerCase();
  const searchRoot = activeDocument?.format.kind === "text"
    ? documentHost.querySelector(".text-viewer") ?? documentHost
    : documentHost;
  const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("style, script")) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const segments: Array<{ end: number; node: Text; start: number }> = [];
  const chunks: string[] = [];
  let length = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    if (text.length > 0) {
      chunks.push(text);
      segments.push({ node: node as Text, start: length, end: length + text.length });
      length += text.length;
    }
    node = walker.nextNode();
  }

  const text = chunks.join("");
  const lower = text.toLocaleLowerCase();
  let matchStart = 0;
  let segmentIndex = 0;
  while (matchStart < lower.length && ranges.length < 2000) {
    const index = lower.indexOf(normalized, matchStart);
    if (index < 0) break;
    const matchEnd = index + query.length;

    while (segments[segmentIndex] && segments[segmentIndex].end <= index) segmentIndex += 1;
    const startSegment = segments[segmentIndex];
    let endSegmentIndex = segmentIndex;
    while (segments[endSegmentIndex] && segments[endSegmentIndex].end < matchEnd) {
      endSegmentIndex += 1;
    }
    const endSegment = segments[endSegmentIndex];
    if (!startSegment || !endSegment) break;

    const range = document.createRange();
    range.setStart(startSegment.node, index - startSegment.start);
    range.setEnd(endSegment.node, matchEnd - endSegment.start);
    ranges.push(range);
    matchStart = index + Math.max(query.length, 1);
  }

  return ranges;
}

function updateCurrentDocxHighlight(scroll = true): void {
  highlightRegistry?.delete("docx-search-current");
  if (currentMatch < 0 || !matchRanges[currentMatch] || !HighlightClass || !highlightRegistry) return;

  const range = matchRanges[currentMatch];
  highlightRegistry.set("docx-search-current", new HighlightClass(range));
  searchCount.textContent = `${currentMatch + 1} / ${matchRanges.length}`;

  if (scroll) {
    const matchRect = range.getBoundingClientRect();
    const viewportRect = documentViewport.getBoundingClientRect();
    documentViewport.scrollBy({
      top: matchRect.top - viewportRect.top - documentViewport.clientHeight * 0.3,
      behavior: "smooth",
    });
  }
}

function performSearch(): void {
  clearSearch();
  const query = searchInput.value.trim();
  if (!query || !activeDocument) return;

  const controller = activeDocument.rendered.controller;
  if (controller) {
    applySearchStatus(controller.search(query));
    return;
  }

  if (!HighlightClass || !highlightRegistry) {
    searchCount.textContent = "不可用";
    return;
  }

  matchRanges = collectTextRanges(query);
  if (matchRanges.length === 0) {
    applySearchStatus({ current: 0, total: 0 });
    return;
  }

  highlightRegistry.set("docx-search-results", new HighlightClass(...matchRanges));
  currentMatch = 0;
  previousMatch.disabled = false;
  nextMatch.disabled = false;
  updateCurrentDocxHighlight();
}

function moveMatch(delta: 1 | -1): void {
  const controller = activeDocument?.rendered.controller;
  if (controller) {
    applySearchStatus(controller.moveMatch(delta));
    return;
  }
  if (matchRanges.length === 0) return;
  currentMatch = (currentMatch + delta + matchRanges.length) % matchRanges.length;
  updateCurrentDocxHighlight();
}

emptyOpenButton.addEventListener("click", openPicker);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file, ++loadSequence);
});

documentViewport.addEventListener("scroll", () => {
  if (activeDocument?.format.kind === "docx") schedulePageIndicatorUpdate();
}, { passive: true });
previousMatch.addEventListener("click", () => moveMatch(-1));
nextMatch.addEventListener("click", () => moveMatch(1));

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(performSearch, 140);
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    moveMatch(event.shiftKey ? -1 : 1);
  }
});

workspace.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  workspace.classList.add("is-dragging");
});

workspace.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

workspace.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) workspace.classList.remove("is-dragging");
});

workspace.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  workspace.classList.remove("is-dragging");
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 1) showToast("一次只会打开第一个受支持的文件");
  if (files[0]) void loadFile(files[0], ++loadSequence);
});

document.addEventListener("keydown", (event) => {
  const dismissesPreview = event.key === "Escape"
    || (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey);
  if (dismissesPreview && isTauri() && activeDocument) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) void invoke("hide_preview_window");
    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLocaleLowerCase();

  if (key === "o") {
    event.preventDefault();
    openPicker();
  } else if (key === "f" && activeDocument?.format.searchable) {
    event.preventDefault();
    openSearch();
  } else if (key === "p" && activeDocument) {
    event.preventDefault();
    if (activeDocument.format.kind === "docx") window.print();
    else showToast("当前格式暂不支持打印");
  }
}, { capture: true });

resetViewer();
void initializeNativePreview();
