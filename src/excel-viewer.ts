import jsPreviewExcel, {
  type JsExcelPreview,
  type Options as ExcelPreviewOptions,
} from "@js-preview/excel";
import "@js-preview/excel/lib/index.css";
import type { DocumentViewerController, SearchStatus } from "./viewer-types";

const maximumSearchMatches = 5000;

type ExcelSearchMatch = {
  column: number;
  row: number;
  sheet: number;
};

type PreviewCell = {
  text?: unknown;
};

type PreviewRow = {
  cells?: Record<string, PreviewCell>;
};

type PreviewSheet = {
  name?: string;
  rows: Record<string, PreviewRow | number> & { len?: number };
};

type PreviewScrollbar = {
  move: (offset: { left?: number; top?: number }) => void;
};

type SpreadsheetInternals = {
  bottombar?: {
    clickSwap2: (item: unknown) => void;
    items: unknown[];
  };
  datas?: Array<{
    cols: { sumWidth: (start: number, end: number) => number };
    rows: { sumHeight: (start: number, end: number) => number };
  }>;
  getData?: () => PreviewSheet[];
  reRender?: () => void;
  sheet?: {
    horizontalScrollbar?: PreviewScrollbar;
    selector?: { set: (row: number, column: number, updateIndexes?: boolean) => void };
    table?: { render: () => void };
    reload?: () => void;
    verticalScrollbar?: PreviewScrollbar;
  };
};

type ExcelPreviewInternals = JsExcelPreview & {
  sheetIndex?: number;
  xs?: SpreadsheetInternals;
};

type StyleAwarePreviewOptions = ExcelPreviewOptions & {
  transformData?: (sheets: PreviewSheet[]) => PreviewSheet[];
  xls?: boolean;
};

type ExcelViewerOptions = {
  convertWorkbook: boolean;
  onSheetChange: (index: number, count: number) => void;
};

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export async function renderExcelViewer(
  input: ArrayBuffer,
  host: HTMLElement,
  options: ExcelViewerOptions,
): Promise<DocumentViewerController> {
  const abortController = new AbortController();
  const root = document.createElement("section");
  root.className = "excel-viewer";
  root.setAttribute("aria-label", "XLSX 工作簿");
  host.classList.add("is-excel");
  host.append(root);

  let workbookData: PreviewSheet[] = [];
  const previewOptions: StyleAwarePreviewOptions = {
    minColLength: 0,
    minRowLength: 0,
    showContextmenu: false,
    xls: options.convertWorkbook,
    transformData(sheets) {
      workbookData = sheets;
      return sheets;
    },
  };
  const previewer = jsPreviewExcel.init(root, previewOptions) as ExcelPreviewInternals;

  try {
    await previewer.preview(input);
  } catch (error) {
    abortController.abort();
    previewer.destroy();
    root.remove();
    throw error;
  }

  workbookData = workbookData.length > 0 ? workbookData : (previewer.xs?.getData?.() ?? []);
  if (workbookData.length === 0) {
    previewer.destroy();
    root.remove();
    throw new Error("工作簿中没有工作表");
  }

  let searchMatches: ExcelSearchMatch[] = [];
  let currentSearchMatch = -1;
  let resizeFrame = 0;

  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (root.clientWidth > 0 && root.clientHeight > 0) previewer.xs?.sheet?.reload?.();
    });
  });
  resizeObserver.observe(root);

  function currentSheetIndex(): number {
    const index = Number(previewer.sheetIndex ?? 0);
    return Math.max(0, Math.min(workbookData.length - 1, Number.isFinite(index) ? index : 0));
  }

  function syncSheetStatus(): void {
    options.onSheetChange(currentSheetIndex(), workbookData.length);
  }

  function selectSheet(index: number): void {
    if (index === currentSheetIndex()) return;
    const bottomBar = previewer.xs?.bottombar;
    const item = bottomBar?.items[index];
    if (bottomBar && item) bottomBar.clickSwap2(item);
    syncSheetStatus();
  }

  function showCurrentMatch(): void {
    const match = searchMatches[currentSearchMatch];
    if (!match) return;
    selectSheet(match.sheet);

    requestAnimationFrame(() => {
      const spreadsheet = previewer.xs;
      const sheet = spreadsheet?.sheet;
      const data = spreadsheet?.datas?.[match.sheet];
      if (!sheet || !data) return;

      const top = data.rows.sumHeight(0, match.row);
      const left = data.cols.sumWidth(0, match.column);
      sheet.verticalScrollbar?.move({ top: Math.max(0, top - 80) });
      sheet.horizontalScrollbar?.move({ left: Math.max(0, left - 120) });
      requestAnimationFrame(() => {
        sheet.selector?.set(match.row, match.column, true);
        sheet.table?.render();
      });
    });
  }

  function status(): SearchStatus {
    return {
      current: currentSearchMatch >= 0 ? currentSearchMatch + 1 : 0,
      total: searchMatches.length,
    };
  }

  root.addEventListener(
    "click",
    (event) => {
      if ((event.target as Element).closest(".x-spreadsheet-bottombar li")) {
        requestAnimationFrame(syncSheetStatus);
      }
    },
    { signal: abortController.signal },
  );

  syncSheetStatus();

  return {
    kind: "xlsx",
    clearSearch() {
      searchMatches = [];
      currentSearchMatch = -1;
    },
    destroy() {
      abortController.abort();
      resizeObserver.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      previewer.destroy();
      root.remove();
    },
    getPageLabel() {
      return `${currentSheetIndex() + 1} / ${workbookData.length} 页`;
    },
    moveMatch(delta) {
      if (searchMatches.length === 0) return status();
      currentSearchMatch = (currentSearchMatch + delta + searchMatches.length) % searchMatches.length;
      showCurrentMatch();
      return status();
    },
    search(query) {
      searchMatches = [];
      currentSearchMatch = -1;
      const normalized = query.trim().toLocaleLowerCase();
      if (!normalized) return status();

      outer: for (let sheetIndex = 0; sheetIndex < workbookData.length; sheetIndex += 1) {
        const rows = workbookData[sheetIndex].rows;
        for (const [rowKey, rowValue] of Object.entries(rows)) {
          if (rowKey === "len" || typeof rowValue !== "object" || !rowValue?.cells) continue;
          for (const [columnKey, cell] of Object.entries(rowValue.cells)) {
            if (cellText(cell.text).toLocaleLowerCase().includes(normalized)) {
              searchMatches.push({
                sheet: sheetIndex,
                row: Number(rowKey),
                column: Number(columnKey),
              });
              if (searchMatches.length >= maximumSearchMatches) break outer;
            }
          }
        }
      }

      if (searchMatches.length > 0) {
        currentSearchMatch = 0;
        showCurrentMatch();
      }
      return status();
    },
  };
}
