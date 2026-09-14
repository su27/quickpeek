/** A close acknowledgement must follow disposal of active AND staging previews. */
export class PreviewCleanup {
  private readonly pending = new Set<Promise<void>>();

  begin(): () => void {
    let resolve!: () => void;
    const done = new Promise<void>(complete => { resolve = complete; });
    this.pending.add(done);
    return () => { this.pending.delete(done); resolve(); };
  }

  async drained(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}

/** Hidden windows may stop producing frames. Cancellation must not wait for one. */
export function nextPreviewPaint(signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let frame = 0;
    const finish = (): void => {
      cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) { finish(); return; }
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}
