import { invoke, isTauri } from "@tauri-apps/api/core";
import { imageOverflowMode, initialImageScale, photoPreviewPixelLimit } from "./image-layout";
import { previewTask } from "./preview-task";

export type ImageViewerResult = {
  readonly width: number;
  readonly height: number;
  destroy(): void;
};

export async function renderImageViewer(
  url: string,
  name: string,
  host: HTMLElement,
  path?: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<ImageViewerResult> {
  const frame = document.createElement("div");
  frame.className = "image-viewer";
  frame.style.visibility = "hidden";
  const canvas = document.createElement("div");
  canvas.className = "image-viewer-canvas";
  const surface = document.createElement("div");
  surface.className = "image-viewer-surface";

  const image = document.createElement("img");
  image.alt = name;
  image.draggable = false;
  surface.append(image);
  canvas.append(surface);
  frame.append(canvas);
  host.classList.add("is-image");
  host.append(frame);

  let decodedUrl: string | null = null;
  const extension = name.toLocaleLowerCase().split(".").pop() ?? "";
  try {
    if (path && isTauri() && (extension === "heic" || extension === "heif")) {
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const monitor = await previewTask(currentMonitor().catch(() => null), signal);
      const maxDimension = photoPreviewPixelLimit(
        monitor?.workArea.size.width ?? screen.availWidth * window.devicePixelRatio,
        monitor?.workArea.size.height ?? screen.availHeight * window.devicePixelRatio,
      );
      const payload = await previewTask(invoke<ArrayBuffer | Uint8Array | number[]>("decode_system_image", {
        maxDimension,
        path,
      }), signal);
      const source = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload);
      const signature = source instanceof ArrayBuffer ? new Uint8Array(source, 0, Math.min(2, source.byteLength)) : source;
      // Native photos use JPEG; images with alpha retain PNG transparency.
      const mime = signature[0] === 0xff && signature[1] === 0xd8 ? "image/jpeg" : "image/png";
      decodedUrl = URL.createObjectURL(new Blob([source], { type: mime }));
    }

    await previewTask(new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("图片解码失败")), { once: true });
      image.src = decodedUrl ?? url;
    }), signal);
    if (typeof image.decode === "function") {
      try {
        await previewTask(image.decode(), signal);
      } catch {
        if (!image.complete || image.naturalWidth === 0) throw new Error("图片解码失败");
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    image.removeAttribute("src");
    if (decodedUrl) URL.revokeObjectURL(decodedUrl);
    frame.remove();
    throw error;
  }

  let scale = 1;
  let userZoomed = false;
  let resizeFrame = 0;
  let pan: {
    pointerId: number;
    scrollLeft: number;
    scrollTop: number;
    x: number;
    y: number;
  } | null = null;

  const updatePanState = (): void => {
    frame.classList.toggle(
      "can-pan",
      frame.scrollWidth > frame.clientWidth + 1 || frame.scrollHeight > frame.clientHeight + 1,
    );
  };

  const applyScale = (nextScale: number): void => {
    scale = nextScale;
    image.style.width = `${image.naturalWidth * scale}px`;
    image.style.height = `${image.naturalHeight * scale}px`;
    updatePanState();
  };

  const updateInitialScale = (): void => {
    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const overflowMode = imageOverflowMode(
      image.naturalWidth,
      image.naturalHeight,
      bounds.width,
      bounds.height,
    );
    frame.classList.toggle("is-scroll-y", overflowMode === "scroll-y");

    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    if (!userZoomed) {
      applyScale(initialImageScale(
        image.naturalWidth,
        image.naturalHeight,
        frameWidth,
        frameHeight,
      ));
      frame.scrollLeft = 0;
      frame.scrollTop = 0;
    } else {
      updatePanState();
    }
  };
  const scheduleInitialScale = (): void => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      updateInitialScale();
    });
  };
  const resizeObserver = new ResizeObserver(scheduleInitialScale);
  resizeObserver.observe(frame);
  updateInitialScale();
  frame.style.visibility = "";

  const onWheel = (event: WheelEvent): void => {
    const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.deltaX;
    if (rawDelta === 0) return;
    event.preventDefault();

    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(1, frame.clientHeight)
        : 1;
    const delta = rawDelta * unit;
    const minimumScale = Math.min(
      1,
      frame.clientWidth / image.naturalWidth,
      frame.clientHeight / image.naturalHeight,
    );
    const nextScale = Math.max(
      minimumScale,
      Math.min(8, scale * Math.exp(-delta * 0.0015)),
    );
    if (Math.abs(nextScale - scale) < 0.00001) return;

    const imageBounds = image.getBoundingClientRect();
    const sourceX = Math.max(0, Math.min(
      image.naturalWidth,
      (event.clientX - imageBounds.left) / scale,
    ));
    const sourceY = Math.max(0, Math.min(
      image.naturalHeight,
      (event.clientY - imageBounds.top) / scale,
    ));

    userZoomed = true;
    applyScale(nextScale);
    const nextImageBounds = image.getBoundingClientRect();
    frame.scrollLeft += nextImageBounds.left + sourceX * scale - event.clientX;
    frame.scrollTop += nextImageBounds.top + sourceY * scale - event.clientY;
  };

  const finishPan = (event: PointerEvent): void => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    pan = null;
    frame.classList.remove("is-panning");
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !frame.classList.contains("can-pan")) return;
    event.preventDefault();
    pan = {
      pointerId: event.pointerId,
      scrollLeft: frame.scrollLeft,
      scrollTop: frame.scrollTop,
      x: event.clientX,
      y: event.clientY,
    };
    frame.classList.add("is-panning");
    frame.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    frame.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
    frame.scrollTop = pan.scrollTop - (event.clientY - pan.y);
  };

  frame.addEventListener("wheel", onWheel, { passive: false });
  frame.addEventListener("pointerdown", onPointerDown);
  frame.addEventListener("pointermove", onPointerMove);
  frame.addEventListener("pointerup", finishPan);
  frame.addEventListener("pointercancel", finishPan);

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    destroy() {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      frame.removeEventListener("wheel", onWheel);
      frame.removeEventListener("pointerdown", onPointerDown);
      frame.removeEventListener("pointermove", onPointerMove);
      frame.removeEventListener("pointerup", finishPan);
      frame.removeEventListener("pointercancel", finishPan);
      image.removeAttribute("src");
      if (decodedUrl) URL.revokeObjectURL(decodedUrl);
      frame.remove();
    },
  };
}
