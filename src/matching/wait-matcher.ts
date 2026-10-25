import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { CoreError } from '../contracts/errors.js';
import type {
  Cursor,
  ExitInfo,
  Gap,
  OutputState,
  SessionStatus,
  WaitData,
  WaitInput,
} from '../contracts/types.js';
import { regexWorkerSource } from './regex-worker.js';
import type { OutputRing } from '../core/output-ring.js';

/** State access and change notification supplied by the session manager. */
export interface WaitContext {
  getState(): ExitInfo & OutputState & { status: SessionStatus };
  subscribe(listener: () => void): () => void;
  signal?: AbortSignal;
}

/** Matching limits copied from the effective server configuration. */
export interface MatchConfig {
  match_window_bytes_per_stream: number;
  max_pattern_bytes: number;
  regex_eval_timeout_ms: number;
  max_match_compute_ms_per_call: number;
}

type RingUnit = { text: string; start: number; end: number };
type RingScan = { units: RingUnit[]; nextCursor: Cursor };

/* Keep the matcher coupled only to the deliberately small OutputRing API. */
type RingAccess = Pick<
  OutputRing,
  | 'sessionId'
  | 'initialCursor'
  | 'earliestCursor'
  | 'latestCursor'
  | 'earliestOffset'
  | 'latestOffset'
  | 'cursorAt'
  | 'offsetOf'
  | 'scan'
>;

type ViewUnit = RingUnit;
type Match = { start: number; end: number; text: string };

type SgrState = 'normal' | 'escape' | 'csi';

class RegexEvaluationTimeout extends Error {
  constructor() {
    super('regular expression evaluation exceeded its time limit');
    this.name = 'RegexEvaluationTimeout';
  }
}

class RegexWorkerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexWorkerFailure';
  }
}

/**
 * One worker is retained for a wait call so startup is never charged as a
 * regular-expression evaluation.  A timed-out evaluation makes its worker
 * untrusted, so the caller closes it immediately rather than reusing it.
 */
class RegexWorkerClient {
  #worker: Worker | undefined;
  #ready: Promise<void> | undefined;
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  /** Start and await the handshake without charging regex evaluation time. */
  async ready(signal?: AbortSignal): Promise<void> {
    await this.#ensureReady(signal);
  }

  async evaluate(
    pattern: string,
    flags: string,
    text: string,
    freshStart: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Match | null> {
    if (signal?.aborted) throw abortError();
    await this.#ensureReady(signal);
    if (signal?.aborted) throw abortError();
    const worker = this.#worker;
    if (!worker || this.#closed) throw new RegexWorkerFailure('regular expression worker is unavailable');

    const id = this.#nextId++;
    return new Promise<Match | null>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        action();
      };
      const closeForFailure = (error: Error) => {
        void this.close();
        settle(() => reject(error));
      };
      const onAbort = () => closeForFailure(abortError());
      const onError = (error: Error) => closeForFailure(new RegexWorkerFailure(error.message));
      const onExit = (code: number) => {
        if (code !== 0) closeForFailure(new RegexWorkerFailure(`regular expression worker exited (${code})`));
      };
      const onMessage = (message: unknown) => {
        if (!isWorkerMessage(message) || message.id !== id) return;
        if (message.type === 'error') {
          settle(() => reject(message.code === 'INVALID_PATTERN'
            ? new CoreError('INVALID_PATTERN', message.message) : new RegexWorkerFailure(message.message)));
        } else {
          settle(() => resolve(message.match));
        }
      };
      const timer = setTimeout(() => closeForFailure(new RegexEvaluationTimeout()), timeoutMs);
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      // The timer starts immediately before posting, rather than while the
      // thread boots and performs its ready handshake.
      worker.postMessage({ type: 'evaluate', id, pattern, flags, text, freshStart });
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#closePromise = (async () => {
      if (worker) { try { await worker.terminate(); } catch { /* already stopped */ } }
    })();
    return this.#closePromise;
  }

  async #ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new RegexWorkerFailure('regular expression worker is closed');
    if (signal?.aborted) throw abortError();
    if (!this.#ready) {
      const worker = new Worker(regexWorkerSource, { eval: true });
      this.#worker = worker;
      this.#ready = new Promise<void>((resolve, reject) => {
        const onMessage = (message: unknown) => {
          if (isReadyMessage(message)) {
            cleanup();
            resolve();
          }
        };
        const onError = (error: Error) => {
          cleanup();
          reject(new RegexWorkerFailure(error.message));
        };
        const onExit = (code: number) => {
          cleanup();
          reject(new RegexWorkerFailure(`regular expression worker exited during startup (${code})`));
        };
        const cleanup = () => {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
      });
    }
    await raceAbort(this.#ready, signal);
  }
}

function isReadyMessage(value: unknown): value is { type: 'ready' } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'ready';
}

function isWorkerMessage(value: unknown): value is
  | { type: 'result'; id: number; match: Match | null }
  | { type: 'error'; id: number; message: string; code?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; id?: unknown };
  return (message.type === 'result' || message.type === 'error') && typeof message.id === 'number';
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Incremental removal of a common CSI ... m (SGR) sequence. */
class IncrementalSgrStripper {
  #state: SgrState = 'normal';
  #candidate: RingUnit[] = [];

  push(units: RingUnit[], maxPendingBytes: number): ViewUnit[] {
    const output: ViewUnit[] = [];
    for (const unit of units) this.#consume(unit, output, maxPendingBytes);
    return output;
  }

  flush(): ViewUnit[] {
    const output = this.#candidate;
    this.#candidate = [];
    this.#state = 'normal';
    return output;
  }

  #consume(unit: RingUnit, output: ViewUnit[], maxPendingBytes: number): void {
    const character = unit.text;
    if (this.#state === 'normal') {
      if (character === '\u001b') {
        this.#candidate.push(unit);
        this.#state = 'escape';
      } else {
        output.push(unit);
      }
      return;
    }

    if (this.#state === 'escape') {
      if (character === '[') {
        this.#candidate.push(unit);
        this.#state = 'csi';
        return;
      }
      this.#flushCandidate(output);
      this.#consume(unit, output, maxPendingBytes);
      return;
    }

    // ANSI CSI parameter bytes and intermediate bytes, followed by m, form
    // the SGR sequences V1 intentionally strips.  Other CSI sequences remain
    // ordinary output rather than attempting screen emulation.
    if (character === 'm') {
      this.#candidate = [];
      this.#state = 'normal';
      return;
    }
    const code = character.length === 1 ? character.charCodeAt(0) : -1;
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      this.#candidate.push(unit);
      if (this.#pendingBytes() >= maxPendingBytes) this.#flushCandidate(output);
      return;
    }
    this.#flushCandidate(output);
    this.#consume(unit, output, maxPendingBytes);
  }

  #flushCandidate(output: ViewUnit[]): void {
    output.push(...this.#candidate);
    this.#candidate = [];
    this.#state = 'normal';
  }

  #pendingBytes(): number {
    const first = this.#candidate[0];
    const last = this.#candidate[this.#candidate.length - 1];
    return first && last ? last.end - first.start : 0;
  }
}

function validatePattern(input: WaitInput, config: MatchConfig): { type: 'literal' | 'regex'; value: string; flags: string } {
  const pattern = input.pattern;
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern))
    throw new CoreError('INVALID_ARGUMENT', 'pattern must be an object');
  if (Object.keys(pattern).some(key => !['type','value','flags'].includes(key)))
    throw new CoreError('INVALID_ARGUMENT', 'unknown pattern property');
  if (!pattern || typeof pattern.value !== 'string' || pattern.value.length === 0) {
    throw new CoreError('INVALID_PATTERN', 'pattern.value must be a non-empty string');
  }
  if (Buffer.byteLength(pattern.value, 'utf8') > config.max_pattern_bytes) {
    throw new CoreError('INVALID_PATTERN', `pattern exceeds ${config.max_pattern_bytes} UTF-8 bytes`);
  }
  if (pattern.type === 'literal') {
    if (pattern.flags !== undefined) {
      throw new CoreError('INVALID_PATTERN', 'literal patterns do not accept flags');
    }
    return { type: 'literal', value: pattern.value, flags: '' };
  }
  if (pattern.type !== 'regex') {
    throw new CoreError('INVALID_PATTERN', 'pattern.type must be literal or regex');
  }
  const flags = pattern.flags ?? '';
  if (typeof flags !== 'string') throw new CoreError('INVALID_PATTERN', 'flags must be a string');
  if (!/^[is]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new CoreError('INVALID_PATTERN', 'regex flags may contain i and s at most once each');
  }
  // Compilation and execution both take place in the isolated Worker.
  return { type: 'regex', value: pattern.value, flags };
}

function cursorExpired(error: unknown): boolean {
  return error instanceof CoreError && error.code === 'CURSOR_EXPIRED';
}

function makeGap(
  ring: RingAccess,
  context: WaitContext,
  readCursor: Cursor,
  scannedCursor: Cursor,
): WaitData {
  const state = context.getState();
  const earliestCursor = ring.earliestCursor;
  const gap: Gap = {
    reason: 'retention_eviction',
    requested_cursor: readCursor,
    earliest_cursor: earliestCursor,
  };
  return {
    ...state,
    session_id: ring.sessionId,
    outcome: 'output_gap',
    read_cursor: readCursor,
    scanned_cursor: scannedCursor,
    matched_text: null,
    matched_stream: null,
    match_start_cursor: null,
    match_end_cursor: null,
    earliest_cursor: earliestCursor,
    gap,
  };
}

function noMatch(
  ring: RingAccess,
  context: WaitContext,
  readCursor: Cursor,
  scannedCursor: Cursor,
  outcome: 'timeout' | 'exited',
): WaitData {
  const state = context.getState();
  return {
    ...state,
    session_id: ring.sessionId,
    outcome,
    read_cursor: readCursor,
    scanned_cursor: scannedCursor,
    matched_text: null,
    matched_stream: null,
    match_start_cursor: null,
    match_end_cursor: null,
    earliest_cursor: ring.earliestCursor,
    gap: null,
  };
}

function matched(
  ring: RingAccess,
  context: WaitContext,
  readCursor: Cursor,
  matchStartCursor: Cursor,
  matchEndCursor: Cursor,
  text: string,
): WaitData {
  const state = context.getState();
  return {
    ...state,
    session_id: ring.sessionId,
    outcome: 'matched',
    read_cursor: readCursor,
    scanned_cursor: matchEndCursor,
    matched_text: text,
    matched_stream: 'pty',
    match_start_cursor: matchStartCursor,
    match_end_cursor: matchEndCursor,
    earliest_cursor: ring.earliestCursor,
    gap: null,
  };
}

function viewText(units: readonly ViewUnit[]): { text: string; positions: Array<{ start: number; end: number }> } {
  let text = '';
  const positions: Array<{ start: number; end: number }> = [];
  for (const unit of units) {
    text += unit.text;
    // JS regex indices count UTF-16 code units.  Ring units count code points,
    // so repeat the raw coordinate for both halves of an astral code point.
    for (let index = 0; index < unit.text.length; index += 1) positions.push({ start: unit.start, end: unit.end });
  }
  return { text, positions };
}

function cursorForStart(positions: readonly { start: number; end: number }[], index: number, fallback: number): number {
  return positions[index]?.start ?? positions[index - 1]?.end ?? fallback;
}

function cursorForEnd(positions: readonly { start: number; end: number }[], index: number, fallback: number): number {
  return positions[index - 1]?.end ?? positions[index]?.start ?? fallback;
}

function trimSuffix(units: readonly ViewUnit[], latestRawOffset: number, windowBytes: number): ViewUnit[] {
  const floor = Math.max(0, latestRawOffset - windowBytes);
  const first = units.findIndex((unit) => unit.start >= floor);
  return first < 0 ? [] : units.slice(first);
}

function firstFreshLiteral(text: string, pattern: string, freshStart: number): Match | null {
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(pattern, from);
    if (start < 0) return null;
    const end = start + pattern.length;
    if (end > freshStart) return { start, end, text: pattern };
    from = start + 1;
  }
  return null;
}

function waitForWake(timeoutMs: number, subscribeSignal: (listener: () => void) => () => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortError()));
    unsubscribe = subscribeSignal(() => finish(resolve));
    timer = setTimeout(() => finish(resolve), Math.max(0, timeoutMs));
    if (done) {
      clearTimeout(timer);
      unsubscribe();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for a literal or ordinary JavaScript regular expression in the single
 * PTY stream.  The matcher retains no state after this Promise settles.
 */
export async function waitFor(
  outputRing: OutputRing,
  input: WaitInput,
  context: WaitContext,
  config: MatchConfig,
): Promise<WaitData> {
  const ring = outputRing as RingAccess;
  const pattern = validatePattern(input, config);
  const signal = context.signal;
  if (signal?.aborted) throw abortError();

  let unsubscribe: (() => void) | undefined;
  let worker: RegexWorkerClient | undefined;
  let wakeVersion = 0;
  let readCursor: Cursor = ring.initialCursor;
  let scanCursor: Cursor = ring.initialCursor;
  let suffix: ViewUnit[] = [];
  const sgr = new IncrementalSgrStripper();
  let activeComputeMs = 0;
  let blockedOnIncompleteUtf8 = false;
  let evaluatedEmptyStart = false;
  const waitStarted = performance.now();
  const timeoutMs = input.timeout_ms ?? 10_000;
  const deadline = waitStarted + timeoutMs;

  const budgetError = (): CoreError => new CoreError(
    'MATCH_BUDGET_EXCEEDED',
    'wait match computation exceeded its budget',
    false,
    {
      session_id: ring.sessionId,
      read_cursor: readCursor,
      scanned_cursor: scanCursor,
      earliest_cursor: ring.earliestCursor,
    },
  );
  const charge = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (activeComputeMs >= config.max_match_compute_ms_per_call) throw budgetError();
    const started = performance.now();
    try {
      return await operation();
    } finally {
      activeComputeMs += performance.now() - started;
    }
  };
  const assertBudget = () => {
    if (activeComputeMs > config.max_match_compute_ms_per_call) throw budgetError();
  };

  const evaluate = async (fresh: ViewUnit[], fallbackOffset: number): Promise<Match | null> => {
    const fullView = await charge(() => suffix.concat(fresh));
    const view = await charge(() => viewText(fullView));
    assertBudget();
    const freshStart = await charge(() => suffix.reduce((length, unit) => length + unit.text.length, 0));
    let found: Match | null;
    if (pattern.type === 'literal') {
      found = await charge(() => firstFreshLiteral(view.text, pattern.value, freshStart));
  } else {
      worker ??= new RegexWorkerClient();
      // Boot/ready time is not a regex evaluation and therefore is not charged
      // to activeComputeMs.  An evaluation itself is charged below.
      await worker.ready(signal);
      found = await charge(async () => {
        const remaining = config.max_match_compute_ms_per_call - activeComputeMs;
        const perEval = Math.max(1, Math.min(config.regex_eval_timeout_ms, remaining));
        return worker!.evaluate(pattern.value, pattern.flags, view.text, freshStart, perEval, signal);
      });
    }
    assertBudget();
    if (!found) return null;
    // Store mapping on the object without retaining the view after this call.
    const start = cursorForStart(view.positions, found.start, fallbackOffset);
    const end = cursorForEnd(view.positions, found.end, fallbackOffset);
    return { start, end, text: found.text };
  };

  try {
    // Registration is first: a write occurring while we snapshot and scan
    // history turns into a later scan rather than a lost notification.
    unsubscribe = context.subscribe(() => { wakeVersion += 1; });

    if (input.cursor !== undefined) {
      readCursor = input.cursor;
    } else if (input.start === 'now') {
      readCursor = ring.latestCursor;
    }
    scanCursor = readCursor;

    try {
      void ring.offsetOf(scanCursor);
    } catch (error) {
      if (cursorExpired(error)) return makeGap(ring, context, readCursor, scanCursor);
      throw error;
    }

    const scanAvailable = async (): Promise<WaitData | null> => {
      blockedOnIncompleteUtf8 = false;
      while (true) {
        if (signal?.aborted) throw abortError();
        let currentOffset: number;
        let availableOffset: number;
        try {
          currentOffset = ring.offsetOf(scanCursor);
          availableOffset = ring.latestOffset;
        } catch (error) {
          if (cursorExpired(error)) return makeGap(ring, context, readCursor, scanCursor);
          throw error;
        }
        if (currentOffset >= availableOffset) return null;

        let page: RingScan;
        try {
          page = await charge(() => ring.scan(scanCursor, config.match_window_bytes_per_stream)) as RingScan;
          assertBudget();
        } catch (error) {
          if (cursorExpired(error)) return makeGap(ring, context, readCursor, scanCursor);
          throw error;
        }
        let nextOffset: number;
        try {
          nextOffset = ring.offsetOf(page.nextCursor);
        } catch (error) {
          if (cursorExpired(error)) return makeGap(ring, context, readCursor, scanCursor);
          throw error;
        }
        if (nextOffset <= currentOffset) {
          // OutputRing deliberately leaves a trailing, non-final UTF-8 prefix
          // at its original cursor.  It is not a matcher failure: wait for a
          // later append (or finish(), which flushes U+FFFD) to make progress.
          if (page.units.length === 0) {
            blockedOnIncompleteUtf8 = true;
            return null;
          }
          throw new CoreError('MATCH_BUDGET_EXCEEDED', 'output ring scan did not advance', false, {
            session_id: ring.sessionId,
            read_cursor: readCursor,
            scanned_cursor: scanCursor,
            earliest_cursor: ring.earliestCursor,
          });
        }

        let fresh: ViewUnit[];
        try {
          fresh = await charge(() => sgr.push(page.units, config.match_window_bytes_per_stream));
          assertBudget();
          evaluatedEmptyStart = true;
          const found = await evaluate(fresh, currentOffset);
          if (found) {
            return matched(
              ring,
              context,
              readCursor,
              ring.cursorAt(found.start),
              ring.cursorAt(found.end),
              found.text,
            );
          }
          assertBudget();
        } catch (error) {
          if (error instanceof RegexEvaluationTimeout) throw budgetError();
          throw error;
        }

        suffix = trimSuffix(suffix.concat(fresh), nextOffset, config.match_window_bytes_per_stream);
        scanCursor = page.nextCursor;
      }
    };

    while (true) {
      const result = await scanAvailable();
      if (result) return result;

      const state = context.getState();
      // scanAvailable 的 Promise 让出期间，最后数据与 close 可同时到达。
      // 必须补扫新的高水位，再根据最终 EOF 决定 exited。
      try {
        if (ring.offsetOf(scanCursor) < ring.latestOffset && (!blockedOnIncompleteUtf8 || state.output_closed)) continue;
      } catch (error) {
        if (cursorExpired(error)) return makeGap(ring, context, readCursor, scanCursor);
        throw error;
      }
      if (!evaluatedEmptyStart && pattern.type === 'regex' && ring.offsetOf(scanCursor) === ring.offsetOf(readCursor)) {
        evaluatedEmptyStart = true;
        try {
          const found = await evaluate([], ring.offsetOf(scanCursor));
          if (found) return matched(ring, context, readCursor, ring.cursorAt(found.start), ring.cursorAt(found.end), found.text);
        } catch (error) { if (error instanceof RegexEvaluationTimeout) throw budgetError(); throw error; }
      }
      // At final output, an unterminated escape candidate is ordinary output
      // and must receive one final evaluation before reporting exited.
      if (state.output_closed) {
        const fresh = await charge(() => sgr.flush());
        assertBudget();
        if (fresh.length > 0) {
          try {
            const found = await evaluate(fresh, ring.offsetOf(scanCursor));
            if (found) {
              return matched(ring, context, readCursor, ring.cursorAt(found.start), ring.cursorAt(found.end), found.text);
            }
          } catch (error) {
            if (error instanceof RegexEvaluationTimeout) throw budgetError();
            throw error;
          }
        }
        return noMatch(ring, context, readCursor, scanCursor, 'exited');
      }

      // Re-check once before sleeping: this avoids a lost wakeup if output was
      // appended after scanAvailable observed the tail.
      const versionBeforeWait = wakeVersion;
      if (!blockedOnIncompleteUtf8 && ring.offsetOf(scanCursor) < ring.latestOffset) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const fresh = await charge(() => sgr.flush());
        assertBudget();
        if (fresh.length > 0) {
          const found = await evaluate(fresh, ring.offsetOf(scanCursor));
          if (found) {
            return matched(ring, context, readCursor, ring.cursorAt(found.start), ring.cursorAt(found.end), found.text);
          }
        }
        return noMatch(ring, context, readCursor, scanCursor, 'timeout');
      }
      if (wakeVersion !== versionBeforeWait) continue;
      await waitForWake(remaining, (listener) => context.subscribe(listener), signal);
    }
  } finally {
    unsubscribe?.();
    await worker?.close();
  }
}
