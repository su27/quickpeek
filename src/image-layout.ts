export type ImageOverflowMode = "contain" | "scroll-x" | "scroll-y";

export const MIN_READABLE_IMAGE_WIDTH = 520;
export const MIN_READABLE_IMAGE_HEIGHT = 360;

// A genuinely tiny, narrow bitmap should stay narrow. Scroll mode is reserved for
// images whose cross-axis has enough source pixels to be useful at a readable size.
const MIN_SCROLL_SOURCE_WIDTH = 320;
const MIN_SCROLL_SOURCE_HEIGHT = 240;

export function imageOverflowMode(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ImageOverflowMode {
  if (
    imageWidth <= 0
    || imageHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
  ) return "contain";

  const fitScale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  if (fitScale >= 1) return "contain";

  const fittedWidth = imageWidth * fitScale;
  const fittedHeight = imageHeight * fitScale;
  if (
    imageWidth >= MIN_SCROLL_SOURCE_WIDTH
    && fittedWidth < Math.min(MIN_READABLE_IMAGE_WIDTH, viewportWidth)
  ) return "scroll-y";

  if (
    imageHeight >= MIN_SCROLL_SOURCE_HEIGHT
    && fittedHeight < Math.min(MIN_READABLE_IMAGE_HEIGHT, viewportHeight)
  ) return "scroll-x";

  return "contain";
}

export function initialImageScale(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const containScale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  const mode = imageOverflowMode(imageWidth, imageHeight, viewportWidth, viewportHeight);
  if (mode === "scroll-y") return Math.min(1, viewportWidth / imageWidth);

  // Leave room for the horizontal scrollbar so it does not introduce a tiny,
  // unwanted vertical overflow after the image is fitted to the viewport height.
  if (mode === "scroll-x") {
    return Math.min(1, Math.max(1, viewportHeight - 18) / imageHeight);
  }
  return containScale;
}
