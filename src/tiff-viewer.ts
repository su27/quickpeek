import { invoke } from "@tauri-apps/api/core";
import { renderImageViewer, type ImageViewerResult } from "./image-viewer";
import { previewTask } from "./preview-task";
import type { RenderContext } from "./document-formats";

export async function renderTiffViewer(path: string, generation: number, context: RenderContext) {
  const { host, signal } = context;
  const info = await previewTask(invoke<{ width: number; height: number; pageCount: number }>("read_tiff_info", { path, generation }), signal);
  if (!info.pageCount || !info.width || !info.height) throw new Error("Invalid TIFF page count or dimensions");
  let viewer: ImageViewerResult | null = null;
  let url: string | null = null;
  let disposed = false;
  let busy = false;
  let page = 0;
  const controls = document.createElement("nav"); controls.className = "tiff-pages";
  const previous = document.createElement("button"); previous.textContent = "Previous page";
  const label = document.createElement("span");
  const next = document.createElement("button"); next.textContent = "Next page";
  controls.append(previous, label, next);
  const update = (): void => {
    label.textContent = `${page + 1}/${info.pageCount}`;
    previous.disabled = busy || page === 0; next.disabled = busy || page + 1 === info.pageCount;
  };
  const show = async (index: number): Promise<void> => {
    if (busy || disposed) return;
    busy = true; update();
    let newUrl: string | null = null;
    let candidate: ImageViewerResult | null = null;
    try {
      const payload = await previewTask(invoke<ArrayBuffer | number[]>("render_tiff_page", { path, generation, pageIndex: index }), signal);
      if (disposed) return;
      newUrl = URL.createObjectURL(new Blob([payload instanceof ArrayBuffer ? payload : new Uint8Array(payload)], { type: "image/png" }));
      // Keep the old page visible until replacement decoding completes, with at most two bounded frames briefly alive.
      candidate = await renderImageViewer(newUrl, path, host, undefined, signal);
      if (disposed || signal.aborted) return;
      viewer?.destroy(); if (url) URL.revokeObjectURL(url);
      viewer = candidate; candidate = null; url = newUrl; newUrl = null; page = index;
      if (context.isActive() && info.pageCount > 1) context.setPageLabel(`${page + 1}/${info.pageCount}`);
    } finally {
      candidate?.destroy(); if (newUrl) URL.revokeObjectURL(newUrl);
      busy = false; update();
    }
  };
  const turn = (delta: number): void => { void show(page + delta).catch(error => { label.textContent = String(error instanceof Error ? error.message : error); }); };
  previous.onclick = () => turn(-1); next.onclick = () => turn(1);
  const destroy = (): void => {
    disposed = true; signal.removeEventListener("abort", destroy);
    viewer?.destroy(); viewer = null; if (url) URL.revokeObjectURL(url); url = null;
    controls.remove();
  };
  signal.addEventListener("abort", destroy, { once: true });
  try { await show(0); signal.throwIfAborted(); } catch (error) { destroy(); throw error; }
  if (info.pageCount > 1) host.append(controls);
  return { info, destroy };
}
