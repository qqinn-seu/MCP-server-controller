import { describe, expect, it } from 'vitest';
import { CoreError } from '../../src/contracts/errors.js';
import { InputQueue, type QueueEntry } from '../../src/core/input-queue.js';

function entry(writeId: string, text: string): QueueEntry {
  return { writeId, data: Buffer.from(text) };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function expectCoreError(operation: () => void, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CoreError);
  expect(thrown).toMatchObject({ code });
}

describe('InputQueue', () => {
  it('rejects a full write in its entirety without adding it to the queue', async () => {
    const delivered: string[] = [];
    const reports: Array<{ type: string; writeId: string }> = [];
    const queue = new InputQueue(
      3,
      async value => { delivered.push(value.writeId); },
      (type, value) => reports.push({ type, writeId: value.writeId }),
    );

    queue.enqueue(entry('first', 'abc'));
    expect(() => queue.enqueue(entry('rejected', 'd'))).toThrow(CoreError);
    expectCoreError(() => queue.enqueue(entry('rejected', 'd')), 'INPUT_QUEUE_FULL');
    expect(queue.pendingBytes).toBe(3);

    await nextTurn();
    expect(delivered).toEqual(['first']);
    expect(reports).toEqual([{ type: 'sent', writeId: 'first' }]);
    expect(queue.pendingBytes).toBe(0);
  });

  it('delivers queued entries strictly serially', async () => {
    const starts: string[] = [];
    const reports: Array<{ type: string; writeId: string }> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const queue = new InputQueue(
      32,
      value => {
        starts.push(value.writeId);
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
      (type, value) => reports.push({ type, writeId: value.writeId }),
    );

    queue.enqueue(entry('one', 'one'));
    queue.enqueue(entry('two', 'two'));
    await nextTurn();
    expect(starts).toEqual(['one']);
    expect(queue.pendingBytes).toBe(6);

    gates[0]!.resolve();
    await nextTurn();
    expect(starts).toEqual(['one', 'two']);
    expect(reports).toEqual([{ type: 'sent', writeId: 'one' }]);

    gates[1]!.resolve();
    await nextTurn();
    expect(reports).toEqual([
      { type: 'sent', writeId: 'one' },
      { type: 'sent', writeId: 'two' },
    ]);
    expect(queue.pendingBytes).toBe(0);
  });

  it('counts an in-flight write against capacity until delivery settles', async () => {
    const gate = deferred();
    const queue = new InputQueue(4, () => gate.promise, () => undefined);

    queue.enqueue(entry('in-flight', 'four'));
    await nextTurn();
    expect(queue.pendingBytes).toBe(4);
    expectCoreError(() => queue.enqueue(entry('later', 'x')), 'INPUT_QUEUE_FULL');

    gate.resolve();
    await nextTurn();
    expect(queue.pendingBytes).toBe(0);
  });

  it('aborts the in-flight delivery and drops pending entries on stop', async () => {
    const reports: Array<{ type: string; writeId: string }> = [];
    let deliveryStarted = false;
    const queue = new InputQueue(
      32,
      (_entry, signal) => new Promise<void>((resolve, reject) => {
        deliveryStarted = true;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
      (type, value) => reports.push({ type, writeId: value.writeId }),
    );

    queue.enqueue(entry('in-flight', 'a'));
    queue.enqueue(entry('pending', 'b'));
    await nextTurn();
    expect(deliveryStarted).toBe(true);

    queue.stop();
    await nextTurn();
    expect(reports).toEqual(expect.arrayContaining([
      { type: 'dropped', writeId: 'pending' },
      { type: 'failed', writeId: 'in-flight' },
    ]));
    expect(queue.pendingBytes).toBe(0);
    expectCoreError(() => queue.enqueue(entry('after-stop', 'c')), 'SESSION_NOT_RUNNING');
  });
});
