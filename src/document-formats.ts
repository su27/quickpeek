import type { DocumentViewerController } from "./viewer-types";

export type DocumentKind =
  | "archive"
  | "audio"
  | "docx"
  | "epub"
  | "file"
  | "folder"
  | "font"
  | "image"
  | "pdf"
  | "pptx"
  | "system"
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
  systemGeneration?: number;
  pdfPages?: PreviewDimensions[];
  previewDimensions?: PreviewDimensions | null;
  shellIcon?: ShellIcon;
  loadShellIcon?: () => Promise<ShellIcon | undefined>;
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
  activate?(): Promise<void>;
  start?(): void;
  destroy(): void;
};

export type RenderContext = {
  signal: AbortSignal;
  host: HTMLElement;
  isActive(): boolean;
  previewWidth?: number;
  setPageLabel(label: string): void;
  contentChanged?(): void;
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
  if (source.type !== "buffer") throw new Error("This viewer requires file data");
  return source.bytes;
}

function requireUrl(source: PreviewSource): string {
  if (source.type !== "url") throw new Error("This viewer requires a file URL");
  return source.url;
}

async function officeBytes(source: PreviewSource, signal: AbortSignal): Promise<ArrayBuffer> {
  if (source.size > 32 * 1024 * 1024) throw new Error("Office file exceeds the 32 MB preview limit");
  const bytes = requireBytes(source);
  if (new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength)).join(",") !== "80,75") return bytes;
  const { prepareOfficeInput } = await import("./office-input");
  return prepareOfficeInput(bytes, signal);
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
    kind: "epub",
    extensions: ["epub"],
    loadMode: "buffer",
    maxReadBytes: 64 * 1024 * 1024,
    mimeType: "application/epub+zip",
    searchable: true,
    async render(source, context) {
      if (source.size > 64 * 1024 * 1024) throw new Error("EPUB exceeds the 64 MB preview limit");
      const { renderEpubViewer } = await import("./epub-viewer");
      const viewer = await renderEpubViewer(requireBytes(source), context);
      return { ...noController(), get fixedPageLabel() { return viewer.label; }, destroy: viewer.destroy };
    },
  },
  {
    kind: "font",
    extensions: ["ttf", "otf", "woff", "woff2"],
    loadMode: "url",
    mimeType: "application/octet-stream",
    searchable: false,
    async render(source, { host, signal }) {
      if (source.size > 20 * 1024 * 1024) throw new Error("Font exceeds the 20 MB preview limit");
      const { renderFontViewer } = await import("./font-viewer");
      const viewer = await renderFontViewer(requireUrl(source), source.name, host, signal);
      return noController({ fixedPageLabel: "" }, viewer.destroy);
    },
  },
  {
    kind: "image",
    extensions: ["tif", "tiff"],
    loadMode: "metadata",
    mimeType: "image/tiff",
    searchable: false,
    async render(source, context) {
      if (!source.path || source.systemGeneration === undefined) throw new Error("TIFF preview requires a local file path");
      const { renderTiffViewer } = await import("./tiff-viewer");
      const viewer = await renderTiffViewer(source.path, source.systemGeneration, context);
      return noController({ fixedPageLabel: viewer.info.pageCount > 1 ? `1/${viewer.info.pageCount}` : "",
        previewDimensions: viewer.info }, viewer.destroy);
    },
  },
  {
    kind: "system",
    extensions: ["doc", "ppt", "pps", "pot", "rtf"],
    loadMode: "metadata",
    mimeType: { doc: "application/msword", ppt: "application/vnd.ms-powerpoint", pps: "application/vnd.ms-powerpoint", pot: "application/vnd.ms-powerpoint", rtf: "application/rtf" },
    searchable: false,
    async render(source, { host }) {
      const { invoke } = await import("@tauri-apps/api/core");
      const generation = source.systemGeneration;
      if (!source.path || generation === undefined) throw new Error("System preview requires a local file path");
      if (!await invoke<boolean>("prepare_system_preview", { path: source.path, generation })) {
        throw new Error("System preview is unavailable or was cancelled");
      }
      host.classList.add("is-system-preview");
      return {
        ...noController({ fixedPageLabel: "" }),
        async activate() {
          if (!await invoke<boolean>("activate_system_preview", { generation })) {
            throw new Error("System preview could not be shown or was cancelled");
          }
        },
        destroy() {
          void invoke("unload_system_preview", { generation }).catch(console.warn);
        },
      };
    },
  },
  {
    kind: "docx",
    extensions: ["docm", "docx", "dotm", "dotx"],
    loadMode: "buffer",
    maxReadBytes: 32 * 1024 * 1024,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    searchable: true,
    async render(source, { host, signal }) {
      const { renderDocx } = await import("./docx-preview-adapter");
      const viewer = await renderDocx(await officeBytes(source, signal), host, host, {
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
      }, signal);
      return noController({}, viewer.destroy);
    },
  },
  {
    kind: "xlsx",
    extensions: ["csv", "ods", "tsv", "xls", "xlsb", "xlsm", "xlsx", "xltm", "xltx"],
    loadMode: "buffer",
    maxReadBytes: 32 * 1024 * 1024,
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
      const controller = await renderExcelViewer(await officeBytes(source, context.signal), context.host, {
        signal: context.signal,
        convertWorkbook: !["xlsm", "xlsx", "xltm", "xltx"].includes(extension),
        onSheetChange(index, count) {
          if (context.isActive()) context.setPageLabel(`${index + 1}/${count}`);
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
    maxReadBytes: 32 * 1024 * 1024,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    searchable: true,
    async render(source, context) {
      const { renderPptxViewer } = await import("./pptx-viewer");
      const controller = await renderPptxViewer(
        await officeBytes(source, context.signal),
        context.host,
        context.viewport,
        {
          signal: context.signal,
          onSlideChange(index, count) {
            if (context.isActive()) {
              context.setPageLabel(count > 0 ? `${index + 1}/${count}` : "0/0");
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
    async render(source, { host, isActive, previewWidth, setPageLabel, signal }) {
      const { renderPdfViewer } = await import("./pdf-viewer");
      const viewer = await renderPdfViewer(
        requireUrl(source),
        source.path,
        source.pdfPages,
        source.previewDimensions ?? null,
        previewWidth,
        host,
        (page, count) => {
          if (isActive()) setPageLabel(`${page}/${count}`);
        },
        signal,
        source.systemGeneration,
      );
      return noController(
        { fixedPageLabel: viewer.pageCount > 0 ? `1/${viewer.pageCount}` : "", previewDimensions: viewer.dimensions },
        viewer.destroy,
      );
    },
  },
  {
    kind: "image",
    extensions: ["apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jfif", "jpeg", "jpg", "png", "svg", "webp"],
    loadMode: "url",
    mimeType: {
      apng: "image/apng",
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      heic: "image/heic",
      heif: "image/heif",
      ico: "image/x-icon",
      jfif: "image/jpeg",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    },
    searchable: false,
    async render(source, { host, signal }) {
      const { renderImageViewer } = await import("./image-viewer");
      const viewer = await renderImageViewer(requireUrl(source), source.name, host, source.path, signal);
      return noController(
        {
          fixedPageLabel: "",
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
    async render(source, { host, signal }) {
      const { renderVideoViewer } = await import("./media-viewer");
      const viewer = await renderVideoViewer(requireUrl(source), host, signal);
      return noController(
        {
          fixedPageLabel: "",
          previewDimensions: viewer.dimensions,
          start: viewer.start,
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
    async render(source, { host, signal }) {
      const { renderAudioViewer } = await import("./media-viewer");
      const viewer = await renderAudioViewer(
        requireUrl(source),
        source.name,
        source.path,
        host,
        signal,
      );
      return noController({ fixedPageLabel: "", start: viewer.start }, viewer.destroy);
    },
  },
  {
    kind: "archive",
    extensions: ["zip", "jar", "war", "apk", "vsix", "nupkg", "tar", "tgz", "tbz2", "txz", "7z", "rar"],
    loadMode: "metadata",
    mimeType: "application/zip",
    searchable: true,
    async render(source, { host, signal }) {
      if (source.type === "buffer") {
        const { renderBrowserZip } = await import("./zip-viewer");
        const viewer = await renderBrowserZip(source.bytes, host);
        return noController({ fixedPageLabel: `${viewer.count} items` }, viewer.destroy);
      }
      if (!source.path || source.systemGeneration === undefined) throw new Error("Archive preview requires a local file path");
      const { invoke } = await import("@tauri-apps/api/core");
      const { previewTask } = await import("./preview-task");
      const { renderArchiveDirectory } = await import("./zip-viewer");
      const directory = await previewTask(invoke<import("./zip-viewer").ArchiveDirectory>("read_archive_directory", { path: source.path, generation: source.systemGeneration }), signal);
      const viewer = renderArchiveDirectory(directory, host);
      return noController({ fixedPageLabel: `${viewer.count} items` }, viewer.destroy);
    },
  },
  {
    kind: "text",
    extensions: [
      "adoc", "ahk", "asm", "asciidoc", "ass", "astro", "awk", "bash", "bat", "bib", "c",
      "cc", "cfg", "cjs", "clj", "cljs", "cmake", "cmd", "coffee", "conf", "cpp", "cs", "css",
      "dart", "diff", "dockerfile", "dockerignore", "editorconfig", "elm", "eml", "env", "erl",
      "ex", "exs", "fish", "fs", "fsx", "gitattributes", "gitignore", "gitmodules", "go", "gql",
      "gradle", "graphql", "groovy", "h", "handlebars", "hbs", "hpp", "hrl", "hs", "htm", "html",
      "http", "ics", "ini", "java", "jl", "js", "json", "jsonc", "jsonl", "jsx", "kt", "kts",
      "less", "lhs", "lock", "log", "lrc", "lua", "m", "makefile", "manifest", "markdown", "md",
      "mdx", "mjs", "mm", "nim", "njk", "npmrc", "nu", "pas", "patch", "pem", "php", "pl",
      "pp", "procfile", "properties", "prop", "proto", "ps1", "py", "pyw", "r", "rakefile", "rb",
      "readme", "reg", "rs", "rst", "s", "scala", "scss", "sh", "sol", "sql", "srt", "ssa",
      "svelte", "swift", "tex", "tf", "tfvars", "toml", "ts", "tsx", "txt", "vb", "vbs", "vcf",
      "vtt", "vue", "xml", "yaml", "yml", "zig", "zsh", "gemfile", "license",
    ],
    loadMode: "buffer",
    mimeType: "text/plain",
    maxReadBytes: MAX_TEXT_BYTES,
    searchable: true,
    async render(source, { host }) {
      const { renderTextViewer } = await import("./text-viewer");
      await renderTextViewer(requireBytes(source), source.name, host, source.size);
      return noController({ fixedPageLabel: "" });
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
  const lowerName = name.toLocaleLowerCase();
  if ([".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"].some(suffix => lowerName.endsWith(suffix))) {
    return formatsByExtension.get("tar")!;
  }
  const normalizedName = lowerName.startsWith(".") ? lowerName.slice(1) : lowerName;
  if (
    normalizedName.startsWith("env.")
    || normalizedName.startsWith("dockerfile.")
    || normalizedName.startsWith("makefile.")
  ) {
    return formats.find((format) => format.kind === "text") ?? unknownFormat;
  }
  return formatsByExtension.get(extensionOf(name)) ?? unknownFormat;
}

export function fileInfoDocumentFormat(isDirectory = false): DocumentFormat {
  return isDirectory ? folderFormat : unknownFormat;
}

export function mimeTypeFor(name: string, format: DocumentFormat): string {
  if (typeof format.mimeType === "string") return format.mimeType;
  return format.mimeType[extensionOf(name)] ?? "application/octet-stream";
}
