import type { DocumentViewerController } from "./viewer-types";

export type DocumentKind =
  | "archive"
  | "audio"
  | "docx"
  | "file"
  | "folder"
  | "image"
  | "pdf"
  | "pptx"
  | "text"
  | "video"
  | "xlsx";

export type PreviewDimensions = {
  height: number;
  width: number;
};

export type ShellIcon = {
  height: number;
  pixels: Uint8ClampedArray;
  width: number;
};

type PreviewMetadata = {
  isDirectory?: boolean;
  mimeType: string;
  modifiedAt?: number;
  name: string;
  path?: string;
  shellIcon?: ShellIcon;
  size: number;
  release?: () => void;
};

export type PreviewSource = PreviewMetadata & (
  | { bytes: ArrayBuffer; type: "buffer" }
  | { type: "metadata" }
  | { type: "url"; url: string }
);

export type RenderedDocument = {
  controller: DocumentViewerController | null;
  fixedPageLabel: string | null;
  previewDimensions: PreviewDimensions | null;
  destroy(): void;
};

export type RenderContext = {
  host: HTMLElement;
  isActive(): boolean;
  setPageLabel(label: string): void;
  viewport: HTMLElement;
};

export type DocumentFormat = {
  extensions: readonly string[];
  kind: DocumentKind;
  loadMode: "buffer" | "metadata" | "url";
  maxReadBytes?: number;
  mimeType: string | Readonly<Record<string, string>>;
  searchable: boolean;
  render(source: PreviewSource, context: RenderContext): Promise<RenderedDocument>;
};

const MAX_TEXT_BYTES = 20 * 1024 * 1024;

function requireBytes(source: PreviewSource): ArrayBuffer {
  if (source.type !== "buffer") throw new Error("此查看器需要文件数据");
  return source.bytes;
}

function requireUrl(source: PreviewSource): string {
  if (source.type !== "url") throw new Error("此查看器需要文件地址");
  return source.url;
}

function noController(
  overrides: Partial<Omit<RenderedDocument, "controller" | "destroy">> = {},
  destroy: () => void = () => {},
): RenderedDocument {
  return {
    controller: null,
    fixedPageLabel: null,
    previewDimensions: null,
    destroy,
    ...overrides,
  };
}

const unknownFormat: DocumentFormat = {
  kind: "file",
  extensions: [],
  loadMode: "metadata",
  mimeType: "application/octet-stream",
  searchable: false,
  async render(source, { host }) {
    const { renderFileInfoViewer } = await import("./file-info-viewer");
    const viewer = renderFileInfoViewer(source, host);
    return noController({ fixedPageLabel: "" }, viewer.destroy);
  },
};

const folderFormat: DocumentFormat = {
  kind: "folder",
  extensions: [],
  loadMode: "metadata",
  mimeType: "inode/directory",
  searchable: false,
  async render(source, { host }) {
    const { renderFileInfoViewer } = await import("./file-info-viewer");
    const viewer = renderFileInfoViewer(source, host);
    return noController({ fixedPageLabel: "" }, viewer.destroy);
  },
};

const formats: readonly DocumentFormat[] = [
  {
    kind: "docx",
    extensions: ["docm", "docx", "dotm", "dotx"],
    loadMode: "buffer",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    searchable: true,
    async render(source, { host }) {
      const { renderDocx } = await import("./docx-preview-adapter");
      await renderDocx(requireBytes(source), host, host, {
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
      return noController();
    },
  },
  {
    kind: "xlsx",
    extensions: ["csv", "ods", "tsv", "xls", "xlsb", "xlsm", "xlsx", "xltm", "xltx"],
    loadMode: "buffer",
    mimeType: {
      csv: "text/csv",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      tsv: "text/tab-separated-values",
      xls: "application/vnd.ms-excel",
      xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
      xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xltm: "application/vnd.ms-excel.template.macroEnabled.12",
      xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    },
    searchable: true,
    async render(source, context) {
      const { renderExcelViewer } = await import("./excel-viewer");
      const extension = extensionOf(source.name);
      const controller = await renderExcelViewer(requireBytes(source), context.host, {
        convertWorkbook: !["xlsm", "xlsx", "xltm", "xltx"].includes(extension),
        onSheetChange(index, count) {
          if (context.isActive()) context.setPageLabel(`${index + 1}/${count} 页`);
        },
      });
      return {
        controller,
        fixedPageLabel: null,
        previewDimensions: null,
        destroy: () => controller.destroy(),
      };
    },
  },
  {
    kind: "pptx",
    extensions: ["potm", "potx", "ppsm", "ppsx", "pptm", "pptx"],
    loadMode: "buffer",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    searchable: true,
    async render(source, context) {
      const { renderPptxViewer } = await import("./pptx-viewer");
      const controller = await renderPptxViewer(
        requireBytes(source),
        context.host,
        context.viewport,
        {
          onSlideChange(index, count) {
            if (context.isActive()) {
              context.setPageLabel(count > 0 ? `${index + 1}/${count} 页` : "0/0 页");
            }
          },
        },
      );
      return {
        controller,
        fixedPageLabel: null,
        previewDimensions: null,
        destroy: () => controller.destroy(),
      };
    },
  },
  {
    kind: "pdf",
    extensions: ["pdf"],
    loadMode: "url",
    mimeType: "application/pdf",
    searchable: false,
    async render(source, { host }) {
      const { renderPdfViewer } = await import("./pdf-viewer");
      const viewer = await renderPdfViewer(requireUrl(source), source.path, host);
      return noController(
        { fixedPageLabel: "", previewDimensions: viewer.dimensions },
        viewer.destroy,
      );
    },
  },
  {
    kind: "image",
    extensions: ["apng", "avif", "bmp", "gif", "ico", "jfif", "jpeg", "jpg", "png", "svg", "webp"],
    loadMode: "url",
    mimeType: {
      apng: "image/apng",
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      ico: "image/x-icon",
      jfif: "image/jpeg",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    },
    searchable: false,
    async render(source, { host }) {
      const { renderImageViewer } = await import("./image-viewer");
      const viewer = await renderImageViewer(requireUrl(source), source.name, host);
      return noController(
        {
          fixedPageLabel: "1/1 页",
          previewDimensions: { width: viewer.width, height: viewer.height },
        },
        viewer.destroy,
      );
    },
  },
  {
    kind: "video",
    extensions: ["m4v", "mov", "mp4", "ogv", "webm"],
    loadMode: "url",
    mimeType: {
      m4v: "video/mp4",
      mov: "video/quicktime",
      mp4: "video/mp4",
      ogv: "video/ogg",
      webm: "video/webm",
    },
    searchable: false,
    async render(source, { host }) {
      const { renderVideoViewer } = await import("./media-viewer");
      const viewer = await renderVideoViewer(requireUrl(source), source.mimeType, host);
      return noController(
        {
          fixedPageLabel: "1/1 页",
          previewDimensions: viewer.dimensions,
        },
        viewer.destroy,
      );
    },
  },
  {
    kind: "audio",
    extensions: ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"],
    loadMode: "url",
    mimeType: {
      aac: "audio/aac",
      flac: "audio/flac",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      opus: "audio/ogg; codecs=opus",
      wav: "audio/wav",
    },
    searchable: false,
    async render(source, { host }) {
      const { renderAudioViewer } = await import("./media-viewer");
      const viewer = await renderAudioViewer(
        requireUrl(source),
        source.mimeType,
        source.name,
        source.path,
        host,
      );
      return noController({ fixedPageLabel: "1/1 页" }, viewer.destroy);
    },
  },
  {
    kind: "archive",
    extensions: ["zip"],
    loadMode: "buffer",
    mimeType: "application/zip",
    searchable: true,
    async render(source, { host }) {
      const { renderZipViewer } = await import("./zip-viewer");
      const viewer = await renderZipViewer(requireBytes(source), host);
      return noController({ fixedPageLabel: `${viewer.count} 项` }, viewer.destroy);
    },
  },
  {
    kind: "text",
    extensions: [
      "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs",
      "css", "dart", "env", "erl", "ex", "exs", "go", "h", "hpp", "hrl", "htm", "html",
      "ini", "java", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua", "md",
      "markdown", "mjs", "php", "pl", "ps1", "py", "pyw", "r", "rb", "rs", "scala", "scss",
      "sh", "sql", "srt", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml",
      "yml", "zsh",
    ],
    loadMode: "buffer",
    mimeType: "text/plain",
    maxReadBytes: MAX_TEXT_BYTES,
    searchable: true,
    async render(source, { host }) {
      const { renderTextViewer } = await import("./text-viewer");
      await renderTextViewer(requireBytes(source), source.name, host, source.size);
      return noController({ fixedPageLabel: "1/1 页" });
    },
  },
];

const formatsByExtension = new Map<string, DocumentFormat>();
for (const format of formats) {
  for (const extension of format.extensions) formatsByExtension.set(extension, format);
}

export function extensionOf(name: string): string {
  return name.toLocaleLowerCase().split(".").pop() ?? "";
}

export function findDocumentFormat(name: string, isDirectory = false): DocumentFormat {
  if (isDirectory) return folderFormat;
  return formatsByExtension.get(extensionOf(name)) ?? unknownFormat;
}

export function fileInfoDocumentFormat(isDirectory = false): DocumentFormat {
  return isDirectory ? folderFormat : unknownFormat;
}

export function mimeTypeFor(name: string, format: DocumentFormat): string {
  if (typeof format.mimeType === "string") return format.mimeType;
  return format.mimeType[extensionOf(name)] ?? "application/octet-stream";
}

export function acceptedFileExtensions(): string {
  return "";
}
