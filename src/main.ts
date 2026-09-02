import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderDocx } from "./docx-preview-adapter";
import type { DocumentViewerController, SearchStatus } from "./viewer-types";
import "./style.css";

type DocumentKind = "docx" | "xlsx" | "pptx" | "image" | "text";

const imageExtensions = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const textExtensions = new Set([
  "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs", "css",
  "csv", "dart", "env", "erl", "ex", "exs", "go", "h", "hpp", "hrl", "htm", "html", "ini", "java",
  "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua", "md", "markdown", "mjs", "php",
  "pl", "ps1", "py", "pyw", "r", "rb", "rs", "scala", "scss", "sh", "sql", "svelte", "toml", "ts",
  "swift", "tsv", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);

const imageMimeTypes: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const fileInput = $<HTMLInputElement>("#fileInput");
const app = $<HTMLElement>("#app");
const emptyOpenButton = $<HTMLButtonElement>("#emptyOpenButton");
const workspace = $<HTMLElement>("#workspace");
const loadingState = $<HTMLElement>("#loadingState");
const documentViewport = $<HTMLElement>("#documentViewport");
const documentHost = $<HTMLElement>("#documentHost");
const toast = $<HTMLElement>("#toast");
const searchInput = $<HTMLInputElement>("#searchInput");
const searchCount = $<HTMLElement>("#searchCount");
const previousMatch = $<HTMLButtonElement>("#previousMatch");
const nextMatch = $<HTMLButtonElement>("#nextMatch");

const officeMimeTypes: Record<"docx" | "xlsx" | "pptx", string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

let currentFile: File | null = null;
let currentKind: DocumentKind | null = null;
let activeController: DocumentViewerController | null = null;
let lightweightCleanup: (() => void) | null = null;
let fixedPageLabel: string | null = null;
let currentDisplayName = "";
let currentSourceSize = 0;
let currentPageLabel = "";
let currentPreviewDimensions: { height: number; width: number } | null = null;
let lastWindowTitle = "";
let dragDepth = 0;
let toastTimer = 0;
let searchTimer = 0;
let matchRanges: Range[] = [];
let currentMatch = -1;
let pageIndicatorFrame = 0;
let queuedNativePath: string | null = null;
let nativeLoadInProgress = false;

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
  const title = currentDisplayName
    ? `${currentDisplayName} - ${formatBytes(currentSourceSize)}${currentPageLabel ? ` ${currentPageLabel}` : ""}`
    : "quickeye";
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
  if (currentPreviewDimensions) return currentPreviewDimensions;

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
    const maximumWidth = Math.max(320, workArea.width * 0.88);
    const maximumHeight = Math.max(220, workArea.height * 0.84);
    const dimensions = measurePreviewDimensions(kind);
    let width: number;
    let height: number;

    if (kind === "image" && dimensions) {
      const maximumScale = Math.min(
        maximumWidth / dimensions.width,
        maximumHeight / dimensions.height,
      );
      const comfortableScale = Math.max(
        1,
        420 / dimensions.width,
        300 / dimensions.height,
      );
      const scale = Math.min(maximumScale, comfortableScale);
      width = dimensions.width * scale;
      height = dimensions.height * scale;
    } else if (kind === "docx" && dimensions) {
      width = clamp(
        dimensions.width + 40,
        Math.min(420, maximumWidth),
        maximumWidth,
      );
      height = clamp(
        dimensions.height + 32,
        Math.min(360, maximumHeight),
        maximumHeight,
      );
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
  } catch (error) {
    console.warn("无法自动调整预览窗口", error);
  }
}

function extensionOf(name: string): string {
  return name.toLocaleLowerCase().split(".").pop() ?? "";
}

function getDocumentKind(name: string): DocumentKind | null {
  const extension = extensionOf(name);
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return extension;
  if (imageExtensions.has(extension)) return "image";
  if (textExtensions.has(extension)) return "text";
  return null;
}

function getMimeType(name: string, kind: DocumentKind): string {
  if (kind === "image") return imageMimeTypes[extensionOf(name)] ?? "application/octet-stream";
  if (kind === "text") return "text/plain";
  return officeMimeTypes[kind];
}

function normalizeIpcBytes(payload: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  const source = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return buffer;
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

function configureControlsForKind(kind: DocumentKind): void {
  const searchable = kind !== "image";
  searchInput.disabled = !searchable;
  if (!searchable) {
    previousMatch.disabled = true;
    nextMatch.disabled = true;
  }
}

function setLoading(loading: boolean): void {
  workspace.classList.toggle("is-loading", loading);
  loadingState.setAttribute("aria-hidden", String(!loading));
  emptyOpenButton.disabled = loading;
  if (loading) setControlsEnabled(false);
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
  activeController?.clearSearch();
  highlightRegistry?.delete("docx-search-results");
  highlightRegistry?.delete("docx-search-current");
}

function openSearch(): void {
  if (!currentFile || currentKind === "image") return;
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

function clearRenderedDocument(): void {
  activeController?.destroy();
  activeController = null;
  lightweightCleanup?.();
  lightweightCleanup = null;
  fixedPageLabel = null;
  currentPreviewDimensions = null;
  documentHost.replaceChildren();
  documentHost.className = "document-host";
  documentViewport.className = "document-viewport";
  documentViewport.scrollTop = 0;
  documentViewport.scrollLeft = 0;
}

function resetViewer(): void {
  closeSearch();
  clearRenderedDocument();
  currentFile = null;
  currentKind = null;
  currentDisplayName = "";
  currentSourceSize = 0;
  currentPageLabel = "";
  updateWindowTitle();
  workspace.classList.add("is-empty");
  workspace.classList.remove("has-document");
  setControlsEnabled(false);
}

function countDocxPages(): number {
  const sections = documentHost.querySelectorAll("section.docx").length;
  if (sections > 0) return sections;
  return documentHost.childElementCount > 0 ? 1 : 0;
}

function updatePageIndicator(): void {
  if (activeController) {
    setPageLabel(activeController.getPageLabel());
    return;
  }

  if (fixedPageLabel) {
    setPageLabel(fixedPageLabel);
    return;
  }

  const pages = Array.from(documentHost.querySelectorAll<HTMLElement>("section.docx"));
  if (pages.length === 0) {
    setPageLabel(documentHost.childElementCount > 0 ? "1/1 页" : "0/0 页");
    return;
  }

  const viewport = documentViewport.getBoundingClientRect();
  const viewportCenter = viewport.top + viewport.height / 2;
  let nearestPage = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  pages.forEach((page, index) => {
    const rect = page.getBoundingClientRect();
    const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = index;
    }
  });

  setPageLabel(`${nearestPage + 1}/${pages.length} 页`);
}

function schedulePageIndicatorUpdate(): void {
  if (pageIndicatorFrame) return;
  pageIndicatorFrame = window.requestAnimationFrame(() => {
    pageIndicatorFrame = 0;
    updatePageIndicator();
  });
}

async function renderDocxDocument(file: File): Promise<void> {
  await renderDocx(file, documentHost, documentHost, {
    className: "docx",
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    renderChanges: false,
    useBase64URL: false,
    experimental: true,
    debug: false,
  });
}

async function renderDocument(file: File, kind: DocumentKind, sourceSize: number): Promise<void> {
  if (kind === "docx") {
    await renderDocxDocument(file);
    return;
  }

  if (kind === "image") {
    const { renderImageViewer } = await import("./image-viewer");
    const viewer = await renderImageViewer(file, documentHost);
    lightweightCleanup = viewer.destroy;
    currentPreviewDimensions = { width: viewer.width, height: viewer.height };
    fixedPageLabel = "1/1 页";
    return;
  }

  if (kind === "text") {
    const { renderTextViewer } = await import("./text-viewer");
    await renderTextViewer(file, documentHost, sourceSize);
    fixedPageLabel = "1/1 页";
    return;
  }

  const buffer = await file.arrayBuffer();
  if (kind === "xlsx") {
    const { renderExcelViewer } = await import("./excel-viewer");
    activeController = await renderExcelViewer(buffer, documentHost, {
      onSheetChange(index, count) {
        setPageLabel(`${index + 1}/${count} 页`);
      },
    });
    return;
  }

  const { renderPptxViewer } = await import("./pptx-viewer");
  activeController = await renderPptxViewer(buffer, documentHost, documentViewport, {
    onSlideChange(index, count) {
      setPageLabel(count > 0 ? `${index + 1}/${count} 页` : "0/0 页");
    },
  });
}

async function loadDocument(file: File, sourceSize = file.size): Promise<void> {
  const kind = getDocumentKind(file.name);
  if (!kind) {
    showToast("暂不支持这种文件格式", "error");
    return;
  }

  closeSearch();
  setLoading(true);
  workspace.classList.remove("is-empty", "has-document");
  clearRenderedDocument();
  currentFile = null;
  currentKind = kind;
  currentDisplayName = file.name;
  currentSourceSize = sourceSize;
  currentPageLabel = "";
  updateWindowTitle();
  documentViewport.classList.add(`is-${kind}`);

  try {
    await renderDocument(file, kind, sourceSize);
    currentFile = file;
    workspace.classList.add("has-document");
    setControlsEnabled(true);
    configureControlsForKind(kind);

    if (kind === "docx") {
      const pages = countDocxPages();
      setPageLabel(pages > 0 ? `1/${pages} 页` : "0/0 页");
    } else {
      updatePageIndicator();
    }

    await resizeWindowForPreview(kind);
  } catch (error) {
    console.error(error);
    if (isTauri()) {
      const details = error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
        : String(error);
      void invoke("log_frontend_error", { message: `render ${file.name}: ${details}` });
    }
    clearRenderedDocument();
    currentKind = null;
    setPageLabel("打开失败");
    workspace.classList.add("is-empty");
    setControlsEnabled(false);
    showToast("文件打开失败，请确认文件未损坏且格式受支持", "error");
  } finally {
    setLoading(false);
  }
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

async function loadDocumentFromPath(path: string): Promise<void> {
  try {
    const name = fileNameFromPath(path);
    const kind = getDocumentKind(name);
    if (!kind) return;
    const [sourceSize, payload] = await Promise.all([
      invoke<number>("get_file_size", { path }),
      invoke<ArrayBuffer | Uint8Array | number[]>("read_preview_file", { path }),
    ]);
    const bytes = normalizeIpcBytes(payload);
    await loadDocument(
      new File([bytes], name, { type: getMimeType(name, kind) }),
      sourceSize,
    );
    await invoke("show_preview_window");
  } catch (error) {
    reportFrontendError(`read ${path}`, error);
    showToast("无法读取选中的文件", "error");
  }
}

async function enqueueNativePreview(path: string): Promise<void> {
  queuedNativePath = path;
  if (nativeLoadInProgress) return;

  nativeLoadInProgress = true;
  try {
    while (queuedNativePath) {
      const nextPath = queuedNativePath;
      queuedNativePath = null;
      await loadDocumentFromPath(nextPath);
    }
  } finally {
    nativeLoadInProgress = false;
  }
}

async function initializeNativePreview(): Promise<void> {
  if (!isTauri()) return;

  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("preview-file", (event) => {
    void enqueueNativePreview(event.payload);
  });

  const initialPath = await invoke<string | null>("get_initial_file_path");
  if (initialPath) await enqueueNativePreview(initialPath);
}

function collectTextRanges(query: string): Range[] {
  const ranges: Range[] = [];
  const normalized = query.toLocaleLowerCase();
  const searchRoot = currentKind === "text"
    ? documentHost.querySelector(".text-viewer code") ?? documentHost
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
  if (!query || !currentFile) return;

  if (activeController) {
    applySearchStatus(activeController.search(query));
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
  if (activeController) {
    applySearchStatus(activeController.moveMatch(delta));
    return;
  }
  if (matchRanges.length === 0) return;
  currentMatch = (currentMatch + delta + matchRanges.length) % matchRanges.length;
  updateCurrentDocxHighlight();
}

emptyOpenButton.addEventListener("click", openPicker);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadDocument(file);
});

documentViewport.addEventListener("scroll", schedulePageIndicatorUpdate, { passive: true });
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
  if (files[0]) void loadDocument(files[0]);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isTauri()) {
    event.preventDefault();
    if (app.classList.contains("is-search-open")) closeSearch();
    else void invoke("hide_preview_window");
    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLocaleLowerCase();

  if (key === "o") {
    event.preventDefault();
    openPicker();
  } else if (key === "f" && currentFile && currentKind !== "image") {
    event.preventDefault();
    openSearch();
  } else if (key === "p" && currentFile) {
    event.preventDefault();
    if (currentKind === "docx") window.print();
    else showToast("当前格式暂不支持打印");
  }
});

resetViewer();
void initializeNativePreview();
