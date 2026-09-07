import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PreviewDimensions } from "./document-formats";

type MediaViewerResult = {
  readonly dimensions: PreviewDimensions | null;
  destroy(): void;
};

type AudioMetadata = {
  album?: string;
  artist?: string;
  composer?: string;
  genre?: string;
  title?: string;
  track?: string;
  year?: string;
};

function extensionOf(name: string): string {
  return name.toLocaleLowerCase().split(".").pop() ?? "";
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

async function loadAudioMetadata(name: string, path: string | undefined): Promise<AudioMetadata | null> {
  if (!isTauri() || !path || extensionOf(name) !== "mp3") return null;
  try {
    return await invoke<AudioMetadata | null>("read_mp3_metadata", { path });
  } catch (error) {
    console.warn("无法读取 MP3 标签", error);
    return null;
  }
}

function appendAudioDetail(host: HTMLElement, label: string, value: string | undefined): void {
  if (!value) return;
  const detail = document.createElement("span");
  detail.textContent = `${label}：${value}`;
  detail.title = detail.textContent;
  host.append(detail);
}

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
  path: string | undefined,
  host: HTMLElement,
): Promise<MediaViewerResult> {
  const metadataPromise = loadAudioMetadata(name, path);
  const frame = document.createElement("section");
  frame.className = "audio-viewer";
  const glyph = document.createElement("div");
  glyph.className = "audio-viewer-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "♫";
  const title = document.createElement("div");
  title.className = "audio-viewer-title";
  title.textContent = name;
  const artist = document.createElement("div");
  artist.className = "audio-viewer-artist";
  const details = document.createElement("div");
  details.className = "audio-viewer-details";
  const audio = document.createElement("audio");
  audio.autoplay = true;
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
    await audio.play();
    const metadata = await metadataPromise;
    if (metadata?.title) {
      title.textContent = metadata.title;
      title.title = metadata.title;
    }
    if (metadata?.artist) {
      artist.textContent = metadata.artist;
      artist.title = metadata.artist;
      title.after(artist);
    }
    appendAudioDetail(details, "专辑", metadata?.album);
    appendAudioDetail(details, "年份", metadata?.year);
    appendAudioDetail(details, "音轨", metadata?.track);
    appendAudioDetail(details, "流派", metadata?.genre);
    appendAudioDetail(details, "作曲", metadata?.composer);
    appendAudioDetail(details, "时长", formatDuration(audio.duration));
    if (details.childElementCount > 0) audio.before(details);
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
