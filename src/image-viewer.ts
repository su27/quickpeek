export type ImageViewerResult = {
  readonly width: number;
  readonly height: number;
  destroy(): void;
};

export async function renderImageViewer(
  file: File,
  host: HTMLElement,
): Promise<ImageViewerResult> {
  const objectUrl = URL.createObjectURL(file);
  const frame = document.createElement("div");
  frame.className = "image-viewer";

  const image = document.createElement("img");
  image.alt = file.name;
  image.draggable = false;
  frame.append(image);
  host.classList.add("is-image");
  host.append(frame);

  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("图片解码失败")), { once: true });
      image.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    frame.remove();
    throw error;
  }

  const updatePixelFit = (): void => {
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    if (frameWidth <= 0 || frameHeight <= 0) return;

    const scale = Math.min(
      frameWidth / image.naturalWidth,
      frameHeight / image.naturalHeight,
    );
    const unusedWidth = frameWidth - image.naturalWidth * scale;
    const unusedHeight = frameHeight - image.naturalHeight * scale;
    frame.classList.toggle("is-pixel-fit", Math.max(unusedWidth, unusedHeight) <= 2);
  };
  const resizeObserver = new ResizeObserver(updatePixelFit);
  resizeObserver.observe(frame);
  updatePixelFit();

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    destroy() {
      resizeObserver.disconnect();
      image.removeAttribute("src");
      URL.revokeObjectURL(objectUrl);
      frame.remove();
    },
  };
}
