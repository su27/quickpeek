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

  let icon: HTMLElement;
  if (source.shellIcon) {
    const canvas = document.createElement("canvas");
    canvas.className = "file-info-shell-icon";
    canvas.width = source.shellIcon.width;
    canvas.height = source.shellIcon.height;
    canvas.setAttribute("aria-hidden", "true");
    canvas.getContext("2d")?.putImageData(
      new ImageData(
        new Uint8ClampedArray(source.shellIcon.pixels),
        source.shellIcon.width,
        source.shellIcon.height,
      ),
      0,
      0,
    );
    icon = canvas;
  } else {
    const fallbackIcon = document.createElement("div");
    fallbackIcon.className = "file-info-icon";
    if (isDirectory) fallbackIcon.classList.add("is-folder");
    fallbackIcon.setAttribute("aria-hidden", "true");
    const badge = document.createElement("span");
    badge.textContent = isDirectory
      ? "文件夹"
      : extension
        ? extension.slice(0, 7).toLocaleUpperCase()
        : "FILE";
    fallbackIcon.append(badge);
    icon = fallbackIcon;
  }

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
