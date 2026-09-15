import { buildArchiveTree, type ArchiveDirectory } from "./archive-tree";
export type { ArchiveDirectory } from "./archive-tree";

export type ZipViewerResult = {
  readonly count: number;
  destroy(): void;
};

// Only used for browser File objects without a native path; normal previews use the native directory reader.
export async function renderBrowserZip(bytes: ArrayBuffer, host: HTMLElement): Promise<ZipViewerResult> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const values = Object.values(zip.files);
  return renderArchiveDirectory({ truncated: values.length > 5000, entries: values.slice(0, 5000).map(entry => {
    const sizes = (entry as typeof entry & { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    return { name: entry.name, dir: entry.dir, compressedSize: sizes?.compressedSize, uncompressedSize: sizes?.uncompressedSize };
  }) }, host);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function renderArchiveDirectory(
  directory: ArchiveDirectory,
  host: HTMLElement,
): ZipViewerResult {
  const { rows, truncated } = buildArchiveTree(directory);
  const folders = rows.filter(row => row.entry.dir).length;

  const frame = document.createElement("section");
  frame.className = "zip-viewer";
  const summary = document.createElement("div");
  summary.className = "zip-viewer-summary";
  summary.textContent = `${rows.length - folders} files, ${folders} folders${truncated ? " (large archive; showing partial contents)" : ""}`;
  const header = document.createElement("div");
  header.className = "zip-viewer-header";
  for (const label of ["Name", "Original size", "Compressed", "Modified"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  }
  const list = document.createElement("ol");
  list.className = "zip-viewer-list";

  const elements: HTMLLIElement[] = [];
  const collapsed = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const { entry } = row;
    const item = document.createElement("li");
    item.className = entry.dir ? "is-directory" : "is-file";
    item.dataset.path = row.path;
    item.style.setProperty("--entry-depth", String(Math.min(row.depth, 32)));
    const label = document.createElement(entry.dir ? "button" : "span");
    label.className = "zip-viewer-label";
    label.title = entry.name;
    const toggle = document.createElement("span");
    toggle.className = "zip-viewer-toggle";
    toggle.setAttribute("aria-hidden", "true");
    if (label instanceof HTMLButtonElement) {
      label.type = "button";
      label.dataset.row = String(index);
      label.setAttribute("aria-expanded", "true");
    }
    const icon = document.createElement("span");
    icon.className = `zip-viewer-icon ${entry.dir ? "is-folder" : "is-file"}`;
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "zip-viewer-name";
    name.textContent = row.name;
    name.title = entry.name;
    const sizes = entry;
    const originalSize = document.createElement("span");
    originalSize.className = "zip-viewer-size";
    originalSize.textContent = entry.dir ? "—" : formatBytes(sizes.uncompressedSize);
    const compressedSize = document.createElement("span");
    compressedSize.className = "zip-viewer-size";
    compressedSize.textContent = entry.dir ? "—" : formatBytes(sizes.compressedSize);
    const date = document.createElement("time");
    date.className = "zip-viewer-date";
    date.textContent = "—";
    if (entry.dateParts) {
      const [year, month, day, hour, minute, second] = entry.dateParts;
      const modified = new Date(year, month - 1, day, hour, minute, second);
      if (!Number.isNaN(modified.getTime())) { date.dateTime = modified.toISOString(); date.textContent = modified.toLocaleString("en-US"); }
    }
    label.append(toggle, icon, name);
    item.append(label, originalSize, compressedSize, date);
    list.append(item);
    elements.push(item);
  }

  const toggleFolder = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-row]") : null;
    if (!button) return;
    const index = Number(button.dataset.row);
    if (collapsed.has(index)) collapsed.delete(index); else collapsed.add(index);
    button.setAttribute("aria-expanded", String(!collapsed.has(index)));
    rows.forEach((row, i) => {
      elements[i].hidden = row.parent !== undefined && (elements[row.parent].hidden || collapsed.has(row.parent));
    });
  };
  list.addEventListener("click", toggleFolder);

  frame.append(summary, header, list);
  host.classList.add("is-archive");
  host.append(frame);

  return {
    count: rows.length,
    destroy() {
      list.removeEventListener("click", toggleFolder);
      frame.remove();
      elements.length = 0;
      rows.length = 0;
      collapsed.clear();
    },
  };
}
