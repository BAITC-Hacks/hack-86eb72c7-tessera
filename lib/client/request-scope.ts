export type ScopeOutcome = "applied" | "failed" | "stale";
export type ScopeHandlers<T> = Readonly<{ onSuccess(value: T): void; onError(error: unknown): void }>;

export class RequestScope {
  private key: string | null = null;
  private generation = 0;
  private disposed = false;
  private controllers = new Set<AbortController>();

  setScope(projectId: string | null, runId: string | null): void {
    if (this.disposed) return;
    const next = projectId === null ? null : JSON.stringify([projectId, runId]);
    if (next === this.key) return;
    this.invalidate();
    this.key = next;
  }

  logout(): void { this.setScope(null, null); }
  dispose(): void { if (this.disposed) return; this.invalidate(); this.disposed = true; }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, handlers: ScopeHandlers<T>): Promise<ScopeOutcome> {
    if (this.disposed || this.key === null) return "stale";
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error("SCOPE_ABORTED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let value: T;
    try {
      value = await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("SCOPE_ABORTED");
        return operation(controller.signal);
      }), aborted]);
    } catch (error) {
      if (this.disposed || this.key === null || this.generation !== generation || controller.signal.aborted) return "stale";
      handlers.onError(error);
      return "failed";
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
    if (this.disposed || this.key === null || this.generation !== generation) return "stale";
    handlers.onSuccess(value);
    return "applied";
  }

  private invalidate(): void {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
