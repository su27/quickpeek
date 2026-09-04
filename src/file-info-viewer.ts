import { extensionOf, type PreviewSource } from "./document-formats";

type FileInfoViewerResult = {
  destroy(): void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function addDetail(list: HTMLDListElement, label: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  detail.title = value;
  list.append(term, detail);
}

export function renderFileInfoViewer(
  source: PreviewSource,
  host: HTMLElement,
): FileInfoViewerResult {
  const isDirectory = source.isDirectory === true;
  const extension = extensionOf(source.name);
  const frame = document.createElement("section");
  frame.className = "file-info-viewer";

  const icon = document.createElement("div");
  icon.className = "file-info-icon";
  if (isDirectory) icon.classList.add("is-folder");
  icon.setAttribute("aria-hidden", "true");
  const badge = document.createElement("span");
  badge.textContent = isDirectory
    ? "文件夹"
    : extension
      ? extension.slice(0, 7).toLocaleUpperCase()
      : "FILE";
  icon.append(badge);

  const name = document.createElement("h1");
  name.textContent = source.name;
  name.title = source.name;

  const type = document.createElement("p");
  type.className = "file-info-type";
  type.textContent = isDirectory
    ? "文件夹"
    : extension
      ? `${extension.toLocaleUpperCase()} 文件`
      : "文件";

  const details = document.createElement("dl");
  details.className = "file-info-details";
  if (!isDirectory) addDetail(details, "大小", formatBytes(source.size));
  if (source.modifiedAt) {
    addDetail(details, "修改时间", new Date(source.modifiedAt).toLocaleString());
  }
  if (source.path) addDetail(details, "位置", source.path);

  frame.append(icon, name, type, details);
  host.classList.add("is-file-info");
  host.append(frame);

  return {
    destroy() {
      frame.remove();
    },
  };
}
