import type { DocumentViewerController } from "./viewer-types";

export type DocumentKind = "docx" | "xlsx" | "pptx" | "image" | "text";

export type PreviewDimensions = {
  height: number;
  width: number;
};

export type PreviewSource = {
  bytes: ArrayBuffer;
  mimeType: string;
  name: string;
  size: number;
};

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
  maxReadBytes?: number;
  mimeType: string | Readonly<Record<string, string>>;
  searchable: boolean;
  render(source: PreviewSource, context: RenderContext): Promise<RenderedDocument>;
};

const MAX_TEXT_BYTES = 20 * 1024 * 1024;

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

const formats: readonly DocumentFormat[] = [
  {
    kind: "docx",
    extensions: ["docx"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    searchable: true,
    async render(source, { host }) {
      const { renderDocx } = await import("./docx-preview-adapter");
      await renderDocx(source.bytes, host, host, {
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
    extensions: ["xlsx"],
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    searchable: true,
    async render(source, context) {
      const { renderExcelViewer } = await import("./excel-viewer");
      const controller = await renderExcelViewer(source.bytes, context.host, {
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
    extensions: ["pptx"],
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    searchable: true,
    async render(source, context) {
      const { renderPptxViewer } = await import("./pptx-viewer");
      const controller = await renderPptxViewer(
        source.bytes,
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
    kind: "image",
    extensions: ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"],
    mimeType: {
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    },
    searchable: false,
    async render(source, { host }) {
      const { renderImageViewer } = await import("./image-viewer");
      const viewer = await renderImageViewer(
        source.bytes,
        source.name,
        source.mimeType,
        host,
      );
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
    kind: "text",
    extensions: [
      "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs",
      "css", "csv", "dart", "env", "erl", "ex", "exs", "go", "h", "hpp", "hrl", "htm",
      "html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua",
      "md", "markdown", "mjs", "php", "pl", "ps1", "py", "pyw", "r", "rb", "rs", "scala",
      "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsv", "tsx", "txt", "vue", "xml",
      "yaml", "yml", "zsh",
    ],
    mimeType: "text/plain",
    maxReadBytes: MAX_TEXT_BYTES,
    searchable: true,
    async render(source, { host }) {
      const { renderTextViewer } = await import("./text-viewer");
      await renderTextViewer(source.bytes, source.name, host, source.size);
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

export function findDocumentFormat(name: string): DocumentFormat | null {
  return formatsByExtension.get(extensionOf(name)) ?? null;
}

export function mimeTypeFor(name: string, format: DocumentFormat): string {
  if (typeof format.mimeType === "string") return format.mimeType;
  return format.mimeType[extensionOf(name)] ?? "application/octet-stream";
}

export function acceptedFileExtensions(): string {
  return Array.from(formatsByExtension.keys(), (extension) => `.${extension}`).join(",");
}
