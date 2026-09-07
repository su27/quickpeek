import JSZip from "jszip";

export type ZipViewerResult = {
  readonly count: number;
  destroy(): void;
};

function entryDepth(path: string): number {
  return Math.max(0, path.replace(/\/$/, "").split("/").length - 1);
}

type CompressedEntryData = {
  compressedSize?: number;
  uncompressedSize?: number;
};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function entrySizes(entry: JSZip.JSZipObject): CompressedEntryData {
  const data = (entry as JSZip.JSZipObject & { _data?: CompressedEntryData })._data;
  return {
    compressedSize: data?.compressedSize,
    uncompressedSize: data?.uncompressedSize,
  };
}

export async function renderZipViewer(
  bytes: ArrayBuffer,
  host: HTMLElement,
): Promise<ZipViewerResult> {
  const archive = await JSZip.loadAsync(bytes, { createFolders: false });
  const entries = Object.values(archive.files).sort((left, right) => {
    const leftPath = left.name.toLocaleLowerCase();
    const rightPath = right.name.toLocaleLowerCase();
    return leftPath.localeCompare(rightPath, undefined, { numeric: true });
  });

  const frame = document.createElement("section");
  frame.className = "zip-viewer";
  const summary = document.createElement("div");
  summary.className = "zip-viewer-summary";
  summary.textContent = `${entries.length} 项`;
  const header = document.createElement("div");
  header.className = "zip-viewer-header";
  for (const label of ["", "名称", "原始大小", "压缩后", "修改时间"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  }
  const list = document.createElement("ol");
  list.className = "zip-viewer-list";

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = entry.dir ? "is-directory" : "is-file";
    item.style.setProperty("--entry-depth", String(entryDepth(entry.name)));
    const icon = document.createElement("span");
    icon.className = `zip-viewer-icon ${entry.dir ? "is-folder" : "is-file"}`;
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "zip-viewer-name";
    name.textContent = entry.name;
    name.title = entry.name;
    const sizes = entrySizes(entry);
    const originalSize = document.createElement("span");
    originalSize.className = "zip-viewer-size";
    originalSize.textContent = entry.dir ? "—" : formatBytes(sizes.uncompressedSize);
    const compressedSize = document.createElement("span");
    compressedSize.className = "zip-viewer-size";
    compressedSize.textContent = entry.dir ? "—" : formatBytes(sizes.compressedSize);
    const date = document.createElement("time");
    date.className = "zip-viewer-date";
    date.dateTime = entry.date.toISOString();
    date.textContent = entry.date.toLocaleString();
    item.append(icon, name, originalSize, compressedSize, date);
    list.append(item);
  }

  frame.append(summary, header, list);
  host.classList.add("is-archive");
  host.append(frame);

  return {
    count: entries.length,
    destroy() {
      frame.remove();
    },
  };
}
