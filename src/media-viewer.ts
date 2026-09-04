import type { PreviewDimensions } from "./document-formats";

type MediaViewerResult = {
  readonly dimensions: PreviewDimensions | null;
  destroy(): void;
};

function waitForMetadata(media: HTMLMediaElement, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`${label}解码失败或系统缺少相应编解码器`));
    };
    const cleanup = (): void => {
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("error", onError);
    };
    media.addEventListener("loadedmetadata", onLoaded, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

function releaseMedia(media: HTMLMediaElement): void {
  media.pause();
  media.removeAttribute("src");
  media.querySelectorAll("source").forEach((source) => source.remove());
  media.load();
}

export async function renderVideoViewer(
  url: string,
  mimeType: string,
  host: HTMLElement,
): Promise<MediaViewerResult> {
  const frame = document.createElement("section");
  frame.className = "video-viewer";
  const video = document.createElement("video");
  video.autoplay = true;
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  const source = document.createElement("source");
  source.src = url;
  source.type = mimeType;
  video.append(source);
  frame.append(video);
  host.classList.add("is-video");
  host.append(frame);
  video.load();

  try {
    await waitForMetadata(video, "视频");
    await video.play();
  } catch (error) {
    releaseMedia(video);
    frame.remove();
    throw error;
  }

  return {
    dimensions: video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight }
      : null,
    destroy() {
      releaseMedia(video);
      frame.remove();
    },
  };
}

export async function renderAudioViewer(
  url: string,
  mimeType: string,
  name: string,
  host: HTMLElement,
): Promise<MediaViewerResult> {
  const frame = document.createElement("section");
  frame.className = "audio-viewer";
  const glyph = document.createElement("div");
  glyph.className = "audio-viewer-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "♫";
  const title = document.createElement("div");
  title.className = "audio-viewer-title";
  title.textContent = name;
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  const source = document.createElement("source");
  source.src = url;
  source.type = mimeType;
  audio.append(source);
  frame.append(glyph, title, audio);
  host.classList.add("is-audio");
  host.append(frame);
  audio.load();

  try {
    await waitForMetadata(audio, "音频");
  } catch (error) {
    releaseMedia(audio);
    frame.remove();
    throw error;
  }

  return {
    dimensions: null,
    destroy() {
      releaseMedia(audio);
      frame.remove();
    },
  };
}
