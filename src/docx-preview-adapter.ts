import {
  parseAsync,
  renderDocument,
  type Options,
  type WordDocument,
} from "docx-preview";
import type { PreviewDimensions } from "./document-formats";

function pageDimensions(host: HTMLElement): PreviewDimensions | null {
  // Inline page geometry remains available while the native window or staging
  // host is hidden, unlike getBoundingClientRect(). docx-preview emits points.
  const page = host.querySelector<HTMLElement>("section.docx");
  const pixels = (length = "") => {
    const match = /^([\d.]+)(pt|px)$/.exec(length);
    return match ? Number(match[1]) * (match[2] === "pt" ? 4 / 3 : 1) : 0;
  };
  const width = pixels(page?.style.width), height = pixels(page?.style.minHeight);
  return width > 0 && height > 0 ? { width, height } : null;
}

type DocumentNode = {
  type?: string;
  cssStyle?: Record<string, string>;
  children?: DocumentNode[];
  props?: SectionLayout;
  sectionProps?: SectionLayout;
};

type SectionLayout = {
  pageMargins?: Record<string, string | null | undefined>;
  pageSize?: { width?: string | null };
};

// docx-preview parses section margins as point lengths. Apply the reading
// minimum before rendering so headers/footers use the same adjusted margins.
function ensureReadingMargins(node: DocumentNode | undefined, isBody = false): void {
  if (!node) return;
  const section = isBody ? (node.props ??= {}) : node.sectionProps;
  if (section) {
    // Without a page width, the max-content host stretches to the longest
    // paragraph. Give incomplete documents an A4 reading width so text wraps.
    const size = section.pageSize ??= {};
    if (!size.width) size.width = "595.3pt";
    const margins = section.pageMargins ??= {};
    for (const side of ["top", "right", "bottom", "left"]) {
      const value = margins[side];
      if (!value || (value.endsWith("pt") && Number.parseFloat(value) < 24)) {
        margins[side] = "24pt";
      }
    }
  }
  for (const child of node.children ?? []) ensureReadingMargins(child);
}

function normalizeTableCellTextDirections(node: DocumentNode | undefined): number {
  if (!node) return 0;

  let correctedCells = 0;
  const style = node.cssStyle;

  // ECMA-376 ST_TextDirection `lrTb` is normal horizontal text. docx-preview
  // 0.4.0 uniquely represents that parsed value as vertical-lr + no transform.
  // Normalize the parsed document model before any DOM nodes are generated.
  if (
    node.type === "cell" &&
    style?.["writing-mode"] === "vertical-lr" &&
    style.transform === "none"
  ) {
    style["writing-mode"] = "horizontal-tb";
    delete style.transform;
    correctedCells += 1;
  }

  for (const child of node.children ?? []) {
    correctedCells += normalizeTableCellTextDirections(child);
  }

  return correctedCells;
}

export async function renderDocx(
  data: Blob | ArrayBuffer | Uint8Array,
  bodyContainer: HTMLElement,
  styleContainer: HTMLElement = bodyContainer,
  options?: Partial<Options>,
  signal?: AbortSignal,
): Promise<WordDocument & { previewDimensions: PreviewDimensions | null; destroy(): void }> {
  signal?.throwIfAborted();
  const document = await parseAsync(data, options);
  signal?.throwIfAborted();
  const urls = new Set<string>();
  let disposed = false;
  const destroy = (): void => {
    disposed = true;
    signal?.removeEventListener("abort", destroy);
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  // Scope URL ownership to this document, including images/fonts completing
  // after cancellation. Never patch the process-wide URL factory.
  const owner = document as WordDocument & { blobToURL(blob: Blob, path: string): string | null | Promise<string> };
  const createUrl = owner.blobToURL.bind(owner);
  owner.blobToURL = (blob: Blob, path: string) => {
    if (disposed) return null;
    const result = createUrl(blob, path);
    if (typeof result === "string" && result.startsWith("blob:")) urls.add(result);
    return result;
  };
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    ensureReadingMargins(document.documentPart?.body, true);
    const correctedCells = normalizeTableCellTextDirections(document.documentPart?.body);
    const nodes = await renderDocument(document, options);
    signal?.throwIfAborted();

    bodyContainer.replaceChildren();
    if (styleContainer !== bodyContainer) styleContainer.replaceChildren();

    for (const node of nodes) {
      const container = node.nodeName === "STYLE" ? styleContainer : bodyContainer;
      container.appendChild(node);
    }

    if (correctedCells > 0) {
      console.info(`Normalized horizontal text direction in ${correctedCells} table cells.`);
    }

    return Object.assign(document, { previewDimensions: pageDimensions(bodyContainer), destroy });
  } catch (error) {
    destroy();
    throw error;
  }
}
