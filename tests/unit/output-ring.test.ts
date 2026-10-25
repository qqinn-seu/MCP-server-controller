import { describe, expect, it } from 'vitest';

import { CoreError } from '../../src/contracts/errors.js';
import { OutputRing } from '../../src/core/output-ring.js';

function textOf(page: ReturnType<OutputRing['read']>): string {
  return page.events.map((event) => event.text).join('');
}

function expectCoreCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
  }
}

describe('OutputRing', () => {
  it('keeps a split UTF-8 code point pending, then paginates without breaking it', () => {
    const ring = new OutputRing('utf8', 'epoch-a', 128);
    const start = ring.initialCursor;

    ring.append(Buffer.from([0xf0, 0x9f]));
    const beforeCompletion = ring.read(start, 4);
    expect(beforeCompletion.events).toEqual([]);
    expect(beforeCompletion.next_cursor).toBe(start);
    expect(beforeCompletion.has_more).toBe(false);

    ring.append(Buffer.from([0x98, 0x80])); // 😀
    ring.append('Z');
    const firstPage = ring.read(beforeCompletion.next_cursor, 4);
    expect(textOf(firstPage)).toBe('😀');
    expect(firstPage.has_more).toBe(true);
    expect(ring.offsetOf(firstPage.next_cursor)).toBe(4);

    const secondPage = ring.read(firstPage.next_cursor, 4);
    expect(textOf(secondPage)).toBe('Z');
    expect(secondPage.has_more).toBe(false);
    expect(ring.offsetOf(secondPage.next_cursor)).toBe(5);

    const scan = ring.scan(start, 64 * 1024);
    expect(scan.units).toEqual([
      { text: '😀', start: 0, end: 4 },
      { text: 'Z', start: 4, end: 5 },
    ]);
    expect(scan.nextCursor).toBe(ring.latestCursor);
  });

  it('uses replacement text for invalid input and flushes an EOF UTF-8 remainder', () => {
    const invalid = new OutputRing('invalid', 'epoch-a', 64);
    invalid.append(Buffer.from([0xff, 0x61]));
    expect(textOf(invalid.read(invalid.initialCursor, 64))).toBe('\ufffda');

    const partial = new OutputRing('partial', 'epoch-a', 64);
    partial.append(Buffer.from([0xe2, 0x82]));
    expect(textOf(partial.read(partial.initialCursor, 64))).toBe('');
    partial.finish();
    const flushed = partial.read(partial.initialCursor, 64);
    expect(textOf(flushed)).toBe('\ufffd');
    expect(ringOffset(partial, flushed.next_cursor)).toBe(2);
  });

  it('allows an empty read cursor to be reused and advance after data arrives', () => {
    const ring = new OutputRing('empty', 'epoch-a', 32);
    const empty = ring.read(ring.initialCursor, 8);
    expect(empty.events).toEqual([]);
    expect(empty.next_cursor).toBe(ring.initialCursor);

    ring.append('later');
    const advanced = ring.read(empty.next_cursor, 8);
    expect(textOf(advanced)).toBe('later');
    expect(ring.offsetOf(advanced.next_cursor)).toBe(5);
  });

  it('does not consume output: two readers can reread the same page', () => {
    const ring = new OutputRing('readers', 'epoch-a', 64);
    ring.append('repeatable output');

    const readerOne = ring.read(ring.initialCursor, 64);
    const readerTwo = ring.read(ring.initialCursor, 64);
    expect(readerOne).toEqual(readerTwo);
    expect(textOf(readerOne)).toBe('repeatable output');
  });

  it('rejects forged, cross-session, cross-epoch, and future cursors', () => {
    const ring = new OutputRing('one', 'epoch-a', 64);
    ring.append('abc');
    const valid = ring.initialCursor;
    const forged = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;

    expectCoreCode(() => ring.offsetOf(forged), 'INVALID_CURSOR');
    expectCoreCode(() => new OutputRing('two', 'epoch-a', 64).offsetOf(valid), 'INVALID_CURSOR');
    expectCoreCode(() => new OutputRing('one', 'epoch-b', 64).offsetOf(valid), 'INVALID_CURSOR');
    expectCoreCode(() => ring.offsetOf(ring.cursorAt(ring.latestOffset + 1)), 'INVALID_CURSOR');
  });

  it('evicts only its own oldest raw bytes and reports an explicit recovery cursor', () => {
    const ring = new OutputRing('evicted', 'epoch-a', 5);
    const initial = ring.initialCursor;
    ring.append('abc');
    ring.append('def');

    expect(ring.retainedBytes).toBe(5);
    expect(ring.earliestOffset).toBe(1);
    expect(ring.latestOffset).toBe(6);
    expect(ring.hasGaps).toBe(true);
    expectCoreCode(() => ring.offsetOf(initial), 'CURSOR_EXPIRED');
    try {
      ring.offsetOf(initial);
    } catch (error) {
      expect((error as CoreError).details.earliest_cursor).toBe(ring.earliestCursor);
    }
    expect(textOf(ring.read(ring.earliestCursor, 64))).toBe('bcdef');

    const other = new OutputRing('other', 'epoch-a', 5);
    other.append('whole');
    expect(textOf(other.read(other.initialCursor, 64))).toBe('whole');
    expect(other.hasGaps).toBe(false);
  });

  it('splits a large event across pages and preserves SGR bytes verbatim', () => {
    const paged = new OutputRing('large', 'epoch-a', 128);
    paged.append('abcdef');
    const one = paged.read(paged.initialCursor, 2);
    const two = paged.read(one.next_cursor, 2);
    const three = paged.read(two.next_cursor, 2);
    expect([textOf(one), textOf(two), textOf(three)]).toEqual(['ab', 'cd', 'ef']);
    expect(three.has_more).toBe(false);
    expect(one.events[0]?.seq).toBe(two.events[0]?.seq);

    const distinctEvents = new OutputRing('event-seq', 'epoch-a', 128);
    distinctEvents.append('one');
    distinctEvents.append('two');
    const eventPage = distinctEvents.read(distinctEvents.initialCursor, 128);
    expect(eventPage.events.map((event) => event.text)).toEqual(['one', 'two']);
    expect(eventPage.events[0]?.seq).not.toBe(eventPage.events[1]?.seq);

    const sgr = new OutputRing('sgr', 'epoch-a', 128);
    const source = '\u001b[31mred\u001b[0m';
    sgr.append(source);
    const page = sgr.read(sgr.initialCursor, 128);
    expect(textOf(page)).toBe(source);
    const scan = sgr.scan(sgr.initialCursor, 64 * 1024);
    expect(scan.units.map((unit) => unit.text).join('')).toBe(source);
    expect(scan.nextCursor).toBe(sgr.latestCursor);
  });
});

function ringOffset(ring: OutputRing, cursor: string): number {
  return ring.offsetOf(cursor);
}
