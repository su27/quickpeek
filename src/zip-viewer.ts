import JSZip from "jszip";

export type ZipViewerResult = {
  readonly count: number;
  destroy(): void;
};

function entryDepth(path: string): number {
  return Math.max(0, path.replace(/\/$/, "").split("/").length - 1);
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
  summary.textContent = `${entries.length} 项 · 仅显示目录，不解压文件`;
  const list = document.createElement("ol");
  list.className = "zip-viewer-list";

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = entry.dir ? "is-directory" : "is-file";
    item.style.setProperty("--entry-depth", String(entryDepth(entry.name)));
    const icon = document.createElement("span");
    icon.className = "zip-viewer-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.dir ? "▸" : "";
    const name = document.createElement("span");
    name.className = "zip-viewer-name";
    name.textContent = entry.name;
    const date = document.createElement("time");
    date.className = "zip-viewer-date";
    date.dateTime = entry.date.toISOString();
    date.textContent = entry.date.toLocaleString();
    item.append(icon, name, date);
    list.append(item);
  }

  frame.append(summary, list);
  host.classList.add("is-archive");
  host.append(frame);

  return {
    count: entries.length,
    destroy() {
      frame.remove();
    },
  };
}
