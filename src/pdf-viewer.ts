import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PreviewDimensions } from "./document-formats";

export type PdfViewerResult = {
  dimensions: PreviewDimensions | null;
  destroy(): void;
};

export async function renderPdfViewer(
  url: string,
  path: string | undefined,
  host: HTMLElement,
): Promise<PdfViewerResult> {
  const dimensionsPromise = path && isTauri()
    ? invoke<PreviewDimensions | null>("read_pdf_dimensions", { path }).catch(() => null)
    : Promise.resolve(null);
  const frame = document.createElement("iframe");
  frame.className = "pdf-viewer";
  frame.title = "PDF 文档";
  frame.src = `${url}#toolbar=0&view=FitH`;
  host.classList.add("is-pdf");
  host.append(frame);

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, 3000);
    frame.addEventListener("load", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    frame.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("PDF 加载失败"));
    }, { once: true });
  });

  return {
    dimensions: await dimensionsPromise,
    destroy() {
      frame.src = "about:blank";
      frame.remove();
    },
  };
}
