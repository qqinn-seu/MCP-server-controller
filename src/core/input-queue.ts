import { CoreError } from '../contracts/errors.js';
export interface QueueEntry { writeId: string; data: Buffer }
export class InputQueue {
  private entries: QueueEntry[] = [];
  private bytes = 0;
  private running = false;
  private scheduled?: NodeJS.Immediate;
  private stopped = false;
  private currentAbort?: AbortController;
  constructor(private readonly capacity: number,
    private readonly deliver: (entry: QueueEntry, signal: AbortSignal) => Promise<void>,
    private readonly report: (type: 'sent' | 'failed' | 'dropped', entry: QueueEntry, error?: unknown) => void) {}
  get pendingBytes() { return this.bytes; }
  enqueue(entry: QueueEntry): void {
    if (this.stopped) throw new CoreError('SESSION_NOT_RUNNING', '输入队列已停止。');
    if (this.bytes + entry.data.byteLength > this.capacity)
      throw new CoreError('INPUT_QUEUE_FULL', '输入队列已满；本次输入完全未入队。', true);
    this.entries.push(entry); this.bytes += entry.data.byteLength;
    if (!this.running && !this.scheduled)
      this.scheduled = setImmediate(() => { this.scheduled = undefined; void this.drain(); });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.currentAbort?.abort();
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    for (const entry of this.entries) { this.bytes -= entry.data.byteLength; this.report('dropped', entry); }
    this.entries = [];
  }
  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped && this.entries.length) {
        const entry = this.entries.shift()!;
        this.currentAbort = new AbortController();
        try { await this.deliver(entry, this.currentAbort.signal); this.report('sent', entry); }
        catch (error) { this.report('failed', entry, error); }
        finally { this.bytes -= entry.data.byteLength; this.currentAbort = undefined; }
      }
    } finally { this.running = false; }
  }
}
