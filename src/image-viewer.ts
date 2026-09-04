import { initialImageScale } from "./image-layout";

export type ImageViewerResult = {
  readonly width: number;
  readonly height: number;
  destroy(): void;
};

export async function renderImageViewer(
  bytes: ArrayBuffer,
  name: string,
  mimeType: string,
  host: HTMLElement,
): Promise<ImageViewerResult> {
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const frame = document.createElement("div");
  frame.className = "image-viewer";
  const canvas = document.createElement("div");
  canvas.className = "image-viewer-canvas";

  const image = document.createElement("img");
  image.alt = name;
  image.draggable = false;
  canvas.append(image);
  frame.append(canvas);
  host.classList.add("is-image");
  host.append(frame);

  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("图片解码失败")), { once: true });
      image.src = objectUrl;
    });
    if (typeof image.decode === "function") {
      try {
        await image.decode();
      } catch {
        if (!image.complete || image.naturalWidth === 0) throw new Error("图片解码失败");
      }
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
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
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    if (frameWidth <= 0 || frameHeight <= 0) return;
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

    const frameBounds = frame.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    const localX = event.clientX - frameBounds.left;
    const localY = event.clientY - frameBounds.top;
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
    frame.scrollLeft = image.offsetLeft + sourceX * scale - localX;
    frame.scrollTop = image.offsetTop + sourceY * scale - localY;
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
      URL.revokeObjectURL(objectUrl);
      frame.remove();
    },
  };
}
