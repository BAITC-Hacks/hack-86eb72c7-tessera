import { isTerminal, validEvent, validSnapshot, type RunSnapshot } from "./contracts";

export type FetchSnapshot = (signal: AbortSignal) => Promise<RunSnapshot>;
export type Clock = Pick<typeof globalThis, "setTimeout" | "clearTimeout"> & { now(): number };
export type StatusView = Readonly<{
  snapshot: RunSnapshot;
  lastConfirmedAt: number;
  delayed: boolean;
  connected: boolean;
}>;

const CONNECTED_POLL_MS = 15_000;
const DISCONNECTED_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const EVENT_THROTTLE_MS = 1_000;
const READ_DEADLINE_MS = 8_000;

export function viewForRun(view: StatusView, initial: RunSnapshot, connected: boolean): StatusView {
  return view.snapshot.projectId === initial.projectId && view.snapshot.runId === initial.runId
    ? view
    : { snapshot: initial, lastConfirmedAt: 0, delayed: false, connected };
}

export class RunStatusController {
  private view: StatusView;
  private active = false;
  private pending = false;
  private inFlight = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private readonly fetchSnapshot: FetchSnapshot;
  private readonly onChange: (view: StatusView) => void;
  private readonly clock: Clock;

  constructor(
    initial: RunSnapshot, fetchSnapshot: FetchSnapshot,
    onChange: (view: StatusView) => void,
    clock: Clock = { setTimeout, clearTimeout, now: Date.now },
  ) {
    if (!validSnapshot(initial)) throw new Error("INVALID_RUN_SNAPSHOT");
    this.fetchSnapshot = fetchSnapshot;
    this.onChange = onChange;
    this.clock = clock;
    this.view = { snapshot: initial, lastConfirmedAt: clock.now(), delayed: false, connected: false };
  }

  get current(): StatusView { return this.view; }

  start(): void {
    if (this.active) return;
    this.active = true;
    if (!isTerminal(this.view.snapshot.status)) this.schedule(0);
  }

  dispose(): void {
    this.active = false;
    this.pending = false;
    this.clearTimer();
    this.abort?.abort();
    this.abort = null;
  }

  setConnected(connected: boolean): void {
    if (!this.active || this.view.connected === connected) return;
    this.emit({ ...this.view, connected, delayed: connected ? this.view.delayed : true });
    if (!isTerminal(this.view.snapshot.status)) this.invalidate();
  }

  onEvent(value: unknown): void {
    if (!this.active || !validEvent(value)) return;
    if (value.projectId !== this.view.snapshot.projectId || value.runId !== this.view.snapshot.runId) return;
    // Never apply event status/version, even if its version is implausibly high.
    this.invalidate();
  }

  focus(): void { this.invalidate(); }
  refresh(): void { this.invalidate(); }

  private emit(view: StatusView): void { this.view = view; if (this.active) this.onChange(view); }
  private clearTimer(): void { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; }
  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.active || isTerminal(this.view.snapshot.status)) return;
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.read(); }, delay);
  }
  private invalidate(): void {
    if (!this.active || isTerminal(this.view.snapshot.status)) return;
    if (this.inFlight) { this.pending = true; return; }
    const wait = Math.max(0, EVENT_THROTTLE_MS - (this.clock.now() - this.lastFetchAt));
    this.schedule(wait);
  }
  private async read(): Promise<void> {
    if (!this.active || this.inFlight || isTerminal(this.view.snapshot.status)) return;
    this.inFlight = true;
    this.lastFetchAt = this.clock.now();
    const abort = new AbortController();
    this.abort = abort;
    let timedOut = false;
    const deadline = this.clock.setTimeout(() => { timedOut = true; abort.abort(); }, READ_DEADLINE_MS);
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("READ_ABORTED"));
    abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const next = await Promise.race([this.fetchSnapshot(abort.signal), aborted]);
      if (!this.active || abort.signal.aborted) return;
      if (!validSnapshot(next) || next.projectId !== this.view.snapshot.projectId || next.runId !== this.view.snapshot.runId) throw new Error("INVALID_SCOPE");
      this.failures = 0;
      if (next.stateVersion > this.view.snapshot.stateVersion) {
        this.emit({ ...this.view, snapshot: next, lastConfirmedAt: this.clock.now(), delayed: false });
      } else if (next.stateVersion === this.view.snapshot.stateVersion) {
        if (next.status !== this.view.snapshot.status || next.stage !== this.view.snapshot.stage) {
          this.failures++;
          this.emit({ ...this.view, delayed: true });
        } else {
          this.emit({ ...this.view, lastConfirmedAt: this.clock.now(), delayed: false });
        }
      } else {
        this.failures++;
        this.emit({ ...this.view, delayed: true });
      }
    } catch {
      if (this.active && (timedOut || !abort.signal.aborted)) {
        this.failures++;
        this.emit({ ...this.view, delayed: true });
      }
    } finally {
      this.clock.clearTimeout(deadline);
      abort.signal.removeEventListener("abort", onAbort);
      this.inFlight = false;
      if (this.abort === abort) this.abort = null;
      if (!this.active || isTerminal(this.view.snapshot.status)) return;
      if (this.pending) { this.pending = false; this.invalidate(); }
      else {
        const base = this.view.connected ? CONNECTED_POLL_MS : DISCONNECTED_POLL_MS;
        this.schedule(this.failures ? Math.min(base * (2 ** Math.min(this.failures, 5)), MAX_BACKOFF_MS) : base);
      }
    }
  }
}
