import type { OutputEvent } from '../contracts/types.js';
import { CoreError } from '../contracts/errors.js';
import { OutputCursorCodec } from './cursor.js';

const MAX_SCAN_RAW_BYTES = 64 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * 1024;
const MAX_EVENT_SPANS = 4096;

interface RawChunk {
  /** Absolute raw-byte position of bytes[0]. */
  start: number;
  /** Fixed-size allocation, only [0, used) belongs to the log. */
  bytes: Buffer;
  used: number;
}

interface EventSpan {
  start: number;
  end: number;
  seq: number;
}

interface DecodedUnit {
  text: string;
  start: number;
  end: number;
}

interface DecodeResult {
  processed: number;
  stopped: boolean;
}

/**
 * Per-session raw output storage.
 *
 * Raw bytes are the retained fact. Text and code-point-to-byte mappings are
 * expanded only for a read/scan operation, so a long ASCII stream does not
 * leave one object per character in memory. Chunks are fixed-size (up to
 * 16 KiB) to bound metadata even if a PTY emits one byte per callback.
 */
export class OutputRing {
  public readonly sessionId: string;

  private readonly epoch: string;
  private readonly capacity: number;
  private readonly chunkBytes: number;
  private readonly cursors: OutputCursorCodec;
  private readonly chunks: RawChunk[] = [];
  private readonly eventSpans: EventSpan[] = [];

  private initialOffset = 0;
  private retainedStart = 0;
  private retainedEnd = 0;
  private nextSequence = 1;
  private finished = false;
  private gaps = false;

  constructor(sessionId: string, epoch: string, capacity: number) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new CoreError('INVALID_ARGUMENT', 'sessionId must be a non-empty string');
    }
    if (typeof epoch !== 'string' || epoch.length === 0) {
      throw new CoreError('INVALID_ARGUMENT', 'epoch must be a non-empty string');
    }
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new CoreError('INVALID_ARGUMENT', 'capacity must be a non-negative safe integer');
    }

    this.sessionId = sessionId;
    this.epoch = epoch;
    this.capacity = capacity;
    // Do not reserve the configured capacity. A chunk is allocated only once
    // data arrives, and is itself no larger than the configured ring.
    this.chunkBytes = Math.min(DEFAULT_CHUNK_BYTES, Math.max(1, capacity));
    this.cursors = new OutputCursorCodec(sessionId, epoch);
  }

  get initialCursor(): string {
    return this.cursors.cursorAt(this.initialOffset);
  }

  get earliestCursor(): string {
    return this.cursors.cursorAt(this.retainedStart);
  }

  get latestCursor(): string {
    return this.cursors.cursorAt(this.retainedEnd);
  }

  get earliestOffset(): number {
    return this.retainedStart;
  }

  get latestOffset(): number {
    return this.retainedEnd;
  }

  get retainedBytes(): number {
    return this.retainedEnd - this.retainedStart;
  }

  get hasGaps(): boolean {
    return this.gaps;
  }

  /**
   * Creates a signed cursor for an internal raw position. The position may be
   * older than the current ring or ahead of it so that callers can construct
   * diagnostics; offsetOf is the trust boundary and rejects expired/future
   * cursors with the specified stable error codes.
   */
  cursorAt(offset: number): string {
    return this.cursors.cursorAt(offset);
  }

  /**
   * Validates cursor syntax/binding, then validates its current ring range.
   * A cryptographically valid older position is distinguishable from a forged
   * or future position, which is necessary for explicit client recovery.
   */
  offsetOf(cursor: string): number {
    const offset = this.cursors.offsetOf(cursor);
    if (offset > this.retainedEnd) {
      throw new CoreError('INVALID_CURSOR', 'cursor points beyond the current output', false);
    }
    if (offset < this.retainedStart) {
      throw new CoreError('CURSOR_EXPIRED', 'cursor has expired from output retention', false, {
        earliest_cursor: this.earliestCursor,
      });
    }
    return offset;
  }

  append(data: Buffer | string): void {
    if (this.finished) {
      throw new CoreError('INVALID_ARGUMENT', 'cannot append after output has finished');
    }

    if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
      throw new CoreError('INVALID_ARGUMENT', 'output data must be a Buffer or string');
    }

    // Buffer.from(string) necessarily materializes the provided UTF-8 string.
    // For Buffer input we do not clone a potentially huge source before first
    // selecting its retained tail; appendRetained copies only ring-sized data.
    const source = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (source.length === 0) return;

    const retainedBeforeAppend = this.retainedBytes;
    const start = this.retainedEnd;
    const end = start + source.length;
    if (!Number.isSafeInteger(end)) {
      throw new CoreError('INVALID_ARGUMENT', 'output offset exceeds safe integer range');
    }
    const seq = this.nextSequence++;
    this.retainedEnd = end;

    if (this.capacity === 0) {
      if (this.retainedStart !== end) this.gaps = true;
      this.chunks.length = 0;
      this.eventSpans.length = 0;
      this.retainedStart = end;
      return;
    }

    if (source.length >= this.capacity) {
      const retainedSourceOffset = source.length - this.capacity;
      const newStart = start + retainedSourceOffset;
      if (newStart > this.retainedStart) this.gaps = true;
      this.chunks.length = 0;
      this.eventSpans.length = 0;
      this.retainedStart = newStart;
      this.appendRetained(source, retainedSourceOffset, this.capacity, newStart);
      this.recordEvent(newStart, end, seq);
      return;
    }

    const overflow = Math.max(0, retainedBeforeAppend + source.length - this.capacity);
    if (overflow > 0) {
      this.evict(overflow);
      this.gaps = true;
    }
    this.appendRetained(source, 0, source.length, start);
    this.recordEvent(start, end, seq);
  }

  /** Marks collector loss/incompleteness without fabricating any bytes. */
  markGap(): void {
    this.gaps = true;
  }

  /**
   * Marks the source EOF. A trailing partial UTF-8 sequence becomes one
   * replacement unit the next time it is read/scanned, matching an incremental
   * UTF-8 decoder's flush behaviour.
   */
  finish(): void {
    this.finished = true;
  }

  read(cursor: string, maxBytes: number): {
    events: OutputEvent[];
    read_cursor: string;
    next_cursor: string;
    earliest_cursor: string;
    has_more: boolean;
  } {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new CoreError('INVALID_ARGUMENT', 'maxBytes must be a positive safe integer');
    }

    const offset = this.offsetOf(cursor);
    const events: OutputEvent[] = [];
    let currentEvent: OutputEvent | undefined;
    let displayBytes = 0;

    // A valid code point is at most four UTF-8 source bytes. The page's text
    // budget is enough to reach a full page because valid UTF-8 has identical
    // raw/display byte sizes; invalid source bytes expand to U+FFFD and fill
    // the display budget earlier. The small look-ahead detects the first unit
    // which would exceed the page without needing to copy the retained ring.
    const rawLimit = Math.min(this.retainedEnd, offset + Math.min(maxBytes, this.capacity) + 4);
    const raw = this.rawSlice(offset, rawLimit);
    const finalAtEnd = this.finished && rawLimit === this.retainedEnd;

    const decoded = decodeUtf8(raw, offset, finalAtEnd, (unit) => {
      const unitBytes = Buffer.byteLength(unit.text, 'utf8');
      if (displayBytes > 0 && displayBytes + unitBytes > maxBytes) {
        return false;
      }

      const seq = this.sequenceAt(unit.start);
      if (currentEvent !== undefined && currentEvent.seq === seq) {
        currentEvent.text += unit.text;
        currentEvent.end_cursor = this.cursorAt(unit.end);
      } else {
        currentEvent = {
          seq,
          stream: 'pty',
          text: unit.text,
          start_cursor: this.cursorAt(unit.start),
          end_cursor: this.cursorAt(unit.end),
        };
        events.push(currentEvent);
      }
      displayBytes += unitBytes;
      return true;
    });

    const nextOffset = decoded.processed;
    return {
      events,
      read_cursor: cursor,
      next_cursor: this.cursorAt(nextOffset),
      earliest_cursor: this.earliestCursor,
      has_more: decoded.stopped || this.hasDisplayUnitAfter(nextOffset),
    };
  }

  /**
   * Expands at most about 64 KiB of raw bytes into code points with original
   * byte coordinates. If a scan window ends within a code point, nextCursor is
   * left before that code point so a caller cannot skip/break it.
   */
  scan(cursor: string, maxRawBytes: number): {
    units: Array<{ text: string; start: number; end: number }>;
    nextCursor: string;
  } {
    if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0) {
      throw new CoreError('INVALID_ARGUMENT', 'maxRawBytes must be a positive safe integer');
    }

    const offset = this.offsetOf(cursor);
    const scanBytes = Math.min(maxRawBytes, MAX_SCAN_RAW_BYTES);
    const end = Math.min(this.retainedEnd, offset + scanBytes);
    const raw = this.rawSlice(offset, end);
    const units: DecodedUnit[] = [];
    const decoded = decodeUtf8(raw, offset, this.finished && end === this.retainedEnd, (unit) => {
      units.push(unit);
      return true;
    });

    return { units, nextCursor: this.cursorAt(decoded.processed) };
  }

  private evict(bytes: number): void {
    if (bytes <= 0 || bytes > this.retainedBytes) {
      throw new Error('invalid output-ring eviction');
    }

    let remaining = bytes;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (first === undefined) throw new Error('output-ring storage is inconsistent');
      if (remaining >= first.used) {
        remaining -= first.used;
        this.chunks.shift();
        continue;
      }

      const left = first.used - remaining;
      const compact = Buffer.allocUnsafe(this.chunkBytes);
      first.bytes.copy(compact, 0, remaining, first.used);
      first.start += remaining;
      first.bytes = compact;
      first.used = left;
      remaining = 0;
    }
    this.retainedStart += bytes;
    this.discardEventsBefore(this.retainedStart);
  }

  private appendRetained(
    source: Buffer,
    sourceOffset: number,
    length: number,
    start: number,
  ): void {
    let sourcePosition = sourceOffset;
    let remaining = length;
    let outputPosition = start;

    while (remaining > 0) {
      const last = this.chunks[this.chunks.length - 1];
      if (last !== undefined && last.start + last.used === outputPosition && last.used < this.chunkBytes) {
        const take = Math.min(remaining, this.chunkBytes - last.used);
        source.copy(last.bytes, last.used, sourcePosition, sourcePosition + take);
        last.used += take;
        sourcePosition += take;
        outputPosition += take;
        remaining -= take;
        continue;
      }

      const take = Math.min(remaining, this.chunkBytes);
      const bytes = Buffer.allocUnsafe(this.chunkBytes);
      source.copy(bytes, 0, sourcePosition, sourcePosition + take);
      this.chunks.push({ start: outputPosition, bytes, used: take });
      sourcePosition += take;
      outputPosition += take;
      remaining -= take;
    }
  }

  private rawSlice(start: number, end: number): Buffer {
    if (start < this.retainedStart || end > this.retainedEnd || start > end) {
      throw new Error('invalid output-ring slice');
    }
    if (start === end) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(end - start);
    let destination = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.used;
      if (chunkEnd <= start) continue;
      if (chunk.start >= end) break;
      const from = Math.max(start, chunk.start);
      const to = Math.min(end, chunkEnd);
      const sourceStart = from - chunk.start;
      const count = to - from;
      chunk.bytes.copy(output, destination, sourceStart, sourceStart + count);
      destination += count;
    }
    if (destination !== output.length) {
      throw new Error('output-ring storage is inconsistent');
    }
    return output;
  }

  private recordEvent(start: number, end: number, seq: number): void {
    if (start >= end) return;
    this.eventSpans.push({ start, end, seq });

    // Normal PTY callbacks preserve their own sequence. Under an adversarial
    // one-byte-per-callback stream, coalesce only the oldest history once the
    // bounded index is full. Raw bytes and cursor positions remain exact.
    while (this.eventSpans.length > MAX_EVENT_SPANS) {
      const first = this.eventSpans.shift();
      const second = this.eventSpans.shift();
      if (first === undefined || second === undefined) {
        throw new Error('output-ring event storage is inconsistent');
      }
      this.eventSpans.unshift({ start: first.start, end: second.end, seq: first.seq });
    }
  }

  private discardEventsBefore(offset: number): void {
    while (this.eventSpans[0] !== undefined && this.eventSpans[0]!.end <= offset) {
      this.eventSpans.shift();
    }
    const first = this.eventSpans[0];
    if (first !== undefined && first.start < offset) {
      first.start = offset;
    }
  }

  private sequenceAt(offset: number): number {
    let low = 0;
    let high = this.eventSpans.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const event = this.eventSpans[middle]!;
      if (offset < event.start) {
        high = middle - 1;
      } else if (offset >= event.end) {
        low = middle + 1;
      } else {
        return event.seq;
      }
    }
    throw new Error('output-ring sequence lookup is outside retained data');
  }

  private hasDisplayUnitAfter(offset: number): boolean {
    if (offset >= this.retainedEnd) return false;

    // Looking at four bytes determines whether the next unit is currently
    // displayable. A non-final partial prefix deliberately returns false: it
    // must remain at the current cursor until a later append completes it.
    const end = Math.min(this.retainedEnd, offset + 4);
    const raw = this.rawSlice(offset, end);
    let found = false;
    decodeUtf8(raw, offset, this.finished && end === this.retainedEnd, () => {
      found = true;
      return false;
    });
    return found;
  }
}

/**
 * Incremental-style UTF-8 decoder for a bounded raw window. It emits complete
 * code points only. A non-final trailing prefix is retained by returning its
 * starting offset; finish() changes only that EOF behaviour to U+FFFD.
 */
function decodeUtf8(
  raw: Buffer,
  absoluteStart: number,
  finalAtEnd: boolean,
  emit: (unit: DecodedUnit) => boolean,
): DecodeResult {
  let index = 0;
  const emitUnit = (text: string, endIndex: number): boolean => {
    const accepted = emit({ text, start: absoluteStart + index, end: absoluteStart + endIndex });
    if (accepted) index = endIndex;
    return accepted;
  };

  while (index < raw.length) {
    const startIndex = index;
    const first = raw[index]!;

    if (first <= 0x7f) {
      if (!emitUnit(String.fromCodePoint(first), index + 1)) {
        return { processed: absoluteStart + startIndex, stopped: true };
      }
      continue;
    }

    let length: number;
    let secondMin = 0x80;
    let secondMax = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      if (first === 0xe0) secondMin = 0xa0;
      if (first === 0xed) secondMax = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      if (first === 0xf0) secondMin = 0x90;
      if (first === 0xf4) secondMax = 0x8f;
    } else {
      if (!emitUnit('\ufffd', index + 1)) {
        return { processed: absoluteStart + startIndex, stopped: true };
      }
      continue;
    }

    if (index + length > raw.length) {
      // All valid available continuation bytes are an incomplete subpart. If
      // an invalid byte is already present, replacement is stable immediately
      // even though the physical output source has not reached EOF.
      let available = index + 1;
      while (available < raw.length) {
        const value = raw[available]!;
        const allowed = available === index + 1
          ? value >= secondMin && value <= secondMax
          : value >= 0x80 && value <= 0xbf;
        if (!allowed) break;
        available += 1;
      }
      if (available < raw.length) {
        if (!emitUnit('\ufffd', available)) {
          return { processed: absoluteStart + startIndex, stopped: true };
        }
        continue;
      }
      if (!finalAtEnd) return { processed: absoluteStart + startIndex, stopped: false };
      // EOF flush turns all remaining valid prefix bytes into one U+FFFD.
      if (!emitUnit('\ufffd', raw.length)) {
        return { processed: absoluteStart + startIndex, stopped: true };
      }
      continue;
    }

    const second = raw[index + 1];
    if (second === undefined || second < secondMin || second > secondMax) {
      if (!emitUnit('\ufffd', index + 1)) {
        return { processed: absoluteStart + startIndex, stopped: true };
      }
      continue;
    }

    let valid = true;
    let invalidAt = index + 1;
    for (let position = index + 2; position < index + length; position += 1) {
      const value = raw[position];
      if (value === undefined || value < 0x80 || value > 0xbf) {
        valid = false;
        invalidAt = position;
        break;
      }
    }
    if (!valid) {
      if (!emitUnit('\ufffd', invalidAt)) {
        return { processed: absoluteStart + startIndex, stopped: true };
      }
      continue;
    }

    let codePoint: number;
    if (length === 2) {
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
    } else if (length === 3) {
      const third = raw[index + 2]!;
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
    } else {
      const third = raw[index + 2]!;
      const fourth = raw[index + 3]!;
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
    }

    if (!emitUnit(String.fromCodePoint(codePoint), index + length)) {
      return { processed: absoluteStart + startIndex, stopped: true };
    }
  }

  return { processed: absoluteStart + index, stopped: false };
}
