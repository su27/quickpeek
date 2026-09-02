import {
  PptxViewer,
  RECOMMENDED_ZIP_LIMITS,
  type SearchHighlightHandle,
  type TextSearchResult,
} from "@aiden0z/pptx-renderer";
import type { DocumentViewerController, SearchStatus } from "./viewer-types";

type PptxViewerOptions = {
  onSlideChange: (index: number, count: number) => void;
};

export async function renderPptxViewer(
  input: ArrayBuffer,
  host: HTMLElement,
  scrollContainer: HTMLElement,
  options: PptxViewerOptions,
): Promise<DocumentViewerController> {
  const container = document.createElement("section");
  container.className = "pptx-viewer";
  container.setAttribute("aria-label", "PPTX 演示文稿");
  host.classList.add("is-pptx");
  host.append(container);

  const abortController = new AbortController();
  let pageSyncFrame = 0;

  function visibleSlideIndex(fallback: number): number {
    const viewport = scrollContainer.getBoundingClientRect();
    const viewportCenter = (viewport.top + viewport.bottom) / 2;
    let bestIndex = fallback;
    let bestVisibleRatio = -1;
    let bestCenterDistance = Number.POSITIVE_INFINITY;

    container.querySelectorAll<HTMLElement>("[data-slide-index]").forEach((slide) => {
      const index = Number(slide.dataset.slideIndex);
      if (!Number.isInteger(index)) return;
      const bounds = slide.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(viewport.bottom, bounds.bottom) - Math.max(viewport.top, bounds.top),
      );
      const visibleRatio = visibleHeight / Math.max(1, Math.min(viewport.height, bounds.height));
      const centerDistance = Math.abs((bounds.top + bounds.bottom) / 2 - viewportCenter);
      if (
        visibleRatio > bestVisibleRatio + 0.01 ||
        (Math.abs(visibleRatio - bestVisibleRatio) <= 0.01 && centerDistance < bestCenterDistance)
      ) {
        bestIndex = index;
        bestVisibleRatio = visibleRatio;
        bestCenterDistance = centerDistance;
      }
    });

    return bestIndex;
  }

  const viewer = new PptxViewer(container, {
    fitMode: "contain",
    onSlideChange(index) {
      options.onSlideChange(index, viewer.slideCount);
    },
    pdfjs: false,
    scrollContainer,
    zipLimits: RECOMMENDED_ZIP_LIMITS,
  });

  try {
    await viewer.open(input, {
      lazyMedia: true,
      lazySlides: true,
      listOptions: {
        batchSize: 4,
        initialSlides: 4,
        overscanViewport: 1.25,
        windowed: true,
      },
      renderMode: "list",
    });
  } catch (error) {
    abortController.abort();
    viewer.destroy();
    container.remove();
    throw error;
  }

  let matches: TextSearchResult[] = [];
  let currentMatch = -1;
  let highlightHandle: SearchHighlightHandle | null = null;
  let highlightGeneration = 0;

  function syncVisiblePage(): void {
    pageSyncFrame = 0;
    options.onSlideChange(visibleSlideIndex(viewer.currentSlideIndex), viewer.slideCount);
  }

  scrollContainer.addEventListener(
    "scroll",
    () => {
      if (pageSyncFrame) cancelAnimationFrame(pageSyncFrame);
      pageSyncFrame = requestAnimationFrame(syncVisiblePage);
    },
    { passive: true, signal: abortController.signal },
  );

  function status(): SearchStatus {
    return {
      current: currentMatch >= 0 ? currentMatch + 1 : 0,
      total: matches.length,
    };
  }

  function clearSearch(): void {
    highlightGeneration += 1;
    highlightHandle?.dispose();
    highlightHandle = null;
    viewer.clearSearchHighlights();
    matches = [];
    currentMatch = -1;
  }

  function showCurrentMatch(): void {
    const match = matches[currentMatch];
    if (!match) return;
    const generation = ++highlightGeneration;
    highlightHandle?.dispose();
    highlightHandle = null;
    void viewer
      .highlightSearchResult(match, {
        backgroundColor: "rgba(255, 206, 48, 0.34)",
        borderColor: "#f39a1f",
        borderRadius: 3,
        borderWidth: 2,
        scrollIntoView: { behavior: "smooth", block: "center" },
      })
      .then((handle) => {
        if (!handle) return;
        if (generation !== highlightGeneration) {
          handle.dispose();
          return;
        }
        highlightHandle = handle;
      });
  }

  options.onSlideChange(viewer.currentSlideIndex, viewer.slideCount);

  return {
    kind: "pptx",
    clearSearch,
    destroy() {
      abortController.abort();
      if (pageSyncFrame) cancelAnimationFrame(pageSyncFrame);
      clearSearch();
      viewer.destroy();
      container.remove();
    },
    getPageLabel() {
      return `${visibleSlideIndex(viewer.currentSlideIndex) + 1} / ${viewer.slideCount} 页`;
    },
    moveMatch(delta) {
      if (matches.length === 0) return status();
      currentMatch = (currentMatch + delta + matches.length) % matches.length;
      showCurrentMatch();
      return status();
    },
    search(query) {
      clearSearch();
      const normalized = query.trim();
      if (!normalized) return status();
      matches = viewer.searchText(normalized, { includeGroups: true });
      if (matches.length > 0) {
        currentMatch = 0;
        showCurrentMatch();
      }
      return status();
    },
  };
}
