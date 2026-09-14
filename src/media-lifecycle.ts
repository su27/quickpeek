// Metadata events and play() may never settle for an unsupported codec.
export function createMediaSession(
  media: HTMLMediaElement,
  signal: AbortSignal,
  onFailure: (message: string) => void,
  timeoutMs = 10_000,
) {
  let disposed = false;
  let started = false;
  let cancelMetadata: (() => void) | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  const message = "无法播放：系统不支持此音视频编码，或加载已超时。可使用标题栏的默认程序打开。";
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelMetadata?.();
    clearTimeout(playbackTimer);
    signal.removeEventListener("abort", dispose);
    media.removeEventListener("error", fail);
    media.pause();
    media.removeAttribute("src");
    media.querySelectorAll("source").forEach((source) => source.remove());
    media.load();
  }
  function fail(): void {
    if (disposed) return;
    dispose();
    onFailure(message);
  }
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) dispose();
  function load(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new DOMException("预览已取消", "AbortError")); return; }
      const cleanup = (): void => {
        clearTimeout(timer);
        media.removeEventListener("loadedmetadata", loaded);
        media.removeEventListener("error", error);
        cancelMetadata = undefined;
      };
      const loaded = (): void => { cleanup(); resolve(); };
      const error = (): void => { cleanup(); dispose(); reject(new Error(message)); };
      cancelMetadata = () => { cleanup(); reject(new DOMException("预览已取消", "AbortError")); };
      const timer = setTimeout(error, timeoutMs);
      // <source> errors do not reliably propagate to the media element.
      media.addEventListener("loadedmetadata", loaded, { once: true });
      media.addEventListener("error", error, { once: true });
      media.src = url;
      media.load();
    });
  }
  function start(): void {
    if (disposed || started) return;
    started = true;
    media.addEventListener("error", fail, { once: true });
    playbackTimer = setTimeout(fail, timeoutMs);
    // Never hold up the preview queue waiting for a hidden video to play.
    void media.play().then(() => clearTimeout(playbackTimer), fail);
  }
  return { load, start, dispose, get disposed() { return disposed; } };
}
