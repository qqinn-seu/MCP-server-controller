import type { BackendCallbacks, BackendFactory, ProcessHandle, SpawnSpec } from '../../src/core/pty-backend.js';

interface PendingSend {
  resolve(): void;
  reject(error: Error): void;
  detach(): void;
}

/**
 * In-memory ProcessHandle for lifecycle tests.  It deliberately never calls
 * process.kill: tests control root exit and output EOF independently, just as
 * a PTY backend may observe them in either order.
 */
export class FakeProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly pgid: number;
  readonly sent: Buffer[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly callbacks: BackendCallbacks;

  closeOutputCalls = 0;
  disposed = false;
  private groupLive = true;
  private outputIsClosed = false;
  private exited = false;
  private blockWrites = false;
  private pendingSends: PendingSend[] = [];

  constructor(pid: number, callbacks: BackendCallbacks) {
    this.pid = pid;
    this.pgid = pid;
    this.callbacks = callbacks;
  }

  async send(data: Buffer, signal?: AbortSignal): Promise<void> {
    if (this.disposed || this.outputIsClosed) throw new Error('fake handle is closed');
    signal?.throwIfAborted();
    this.sent.push(Buffer.from(data));
    if (!this.blockWrites) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        this.pendingSends = this.pendingSends.filter(item => item !== pending);
        action();
      };
      const onAbort = () => settle(() => reject(new DOMException('Aborted', 'AbortError')));
      const pending: PendingSend = {
        resolve: () => settle(resolve),
        reject: error => settle(() => reject(error)),
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      this.pendingSends.push(pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  signalGroup(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    // A forced KILL clears this fake group, but does not synthesize root-exit
    // or EOF callbacks.  Tests intentionally arrange those observations.
    if (signal === 'SIGKILL') this.groupLive = false;
  }

  groupExists(): boolean {
    return this.groupLive;
  }

  rootExists(): boolean {
    return !this.exited;
  }

  closeOutput(): void {
    this.closeOutputCalls += 1;
    this.emitClosed(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('fake handle disposed');
    for (const pending of [...this.pendingSends]) pending.reject(error);
  }

  setGroupExists(exists: boolean): void {
    this.groupLive = exists;
  }

  setWriteBlocked(blocked: boolean): void {
    this.blockWrites = blocked;
  }

  releaseNextWrite(): void {
    this.pendingSends[0]?.resolve();
  }

  releaseAllWrites(): void {
    for (const pending of [...this.pendingSends]) pending.resolve();
  }

  emitData(data: Buffer | string): void {
    if (!this.outputIsClosed) this.callbacks.data(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  emitError(error: Error): void {
    this.callbacks.error(error);
  }

  emitExit(code: number | null = 0, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.callbacks.exit(code, signal);
  }

  emitClosed(complete = true): void {
    if (this.outputIsClosed) return;
    this.outputIsClosed = true;
    this.callbacks.closed(complete);
  }

  /** Resolve teardown without relying on manager drain-timeout fallbacks. */
  finish(code: number | null = 0, signal: string | null = null, complete = true): void {
    this.groupLive = false;
    this.emitExit(code, signal);
    this.emitClosed(complete);
    this.releaseAllWrites();
  }
}

export class FakeBackend {
  readonly handles: FakeProcessHandle[] = [];
  readonly spawns: Array<{ spec: SpawnSpec; callbacks: BackendCallbacks }> = [];
  private nextPid = 40_000;
  private failures: Error[] = [];

  readonly factory: BackendFactory = (spec, callbacks) => {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const handle = new FakeProcessHandle(this.nextPid++, callbacks);
    this.spawns.push({
      spec: { ...spec, args: [...spec.args], env: { ...spec.env } },
      callbacks,
    });
    this.handles.push(handle);
    return handle;
  };

  get latest(): FakeProcessHandle {
    const handle = this.handles.at(-1);
    if (!handle) throw new Error('fake backend has no spawned handle');
    return handle;
  }

  failNextSpawn(error = new Error('fake spawn failure')): void {
    this.failures.push(error);
  }

  finishAll(): void {
    for (const handle of this.handles) handle.finish();
  }
}
