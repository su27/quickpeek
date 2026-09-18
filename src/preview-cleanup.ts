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
