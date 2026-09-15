import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PreviewDimensions } from "./document-formats";
import { createMediaSession } from "./media-lifecycle";

type MediaViewerResult = {
  readonly dimensions: PreviewDimensions | null;
  start(): void;
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
    console.warn("Could not read MP3 tags", error);
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

function showMediaError(frame: HTMLElement, message: string): void {
  const error = document.createElement("p");
  error.className = "media-error";
  error.textContent = message;
  frame.replaceChildren(error);
}

export async function renderVideoViewer(
  url: string,
  host: HTMLElement,
  signal: AbortSignal,
): Promise<MediaViewerResult> {
  const frame = document.createElement("section");
  frame.className = "video-viewer";
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  frame.append(video);
  host.classList.add("is-video");
  host.append(frame);
  const session = createMediaSession(video, signal, (message) => showMediaError(frame, message));

  try {
    await session.load(url);
  } catch (error) {
    session.dispose();
    frame.remove();
    throw error;
  }

  return {
    start: session.start,
    dimensions: video.videoWidth > 0 && video.videoHeight > 0
      ? { width: video.videoWidth, height: video.videoHeight }
      : null,
    destroy() {
      session.dispose();
      frame.remove();
    },
  };
}

export async function renderAudioViewer(
  url: string,
  name: string,
  path: string | undefined,
  host: HTMLElement,
  signal: AbortSignal,
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
  audio.controls = true;
  audio.preload = "metadata";
  frame.append(glyph, title, audio);
  host.classList.add("is-audio");
  host.append(frame);
  const session = createMediaSession(audio, signal, (message) => showMediaError(frame, message));

  try {
    await session.load(url);
    void metadataPromise.then((metadata) => {
      if (session.disposed) return;
      if (metadata?.title) {
        title.textContent = metadata.title;
        title.title = metadata.title;
      }
      if (metadata?.artist) {
        artist.textContent = metadata.artist;
        artist.title = metadata.artist;
        title.after(artist);
      }
      appendAudioDetail(details, "Album", metadata?.album);
      appendAudioDetail(details, "Year", metadata?.year);
      appendAudioDetail(details, "Track", metadata?.track);
      appendAudioDetail(details, "Genre", metadata?.genre);
      appendAudioDetail(details, "Composer", metadata?.composer);
      appendAudioDetail(details, "Duration", formatDuration(audio.duration));
      if (details.childElementCount > 0) audio.before(details);
    });
  } catch (error) {
    session.dispose();
    frame.remove();
    throw error;
  }

  return {
    start: session.start,
    dimensions: null,
    destroy() {
      session.dispose();
      frame.remove();
    },
  };
}
