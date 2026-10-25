import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { OutputRing } from '../../src/core/output-ring.js';
import { waitFor, type WaitContext } from '../../src/matching/wait-matcher.js';
import type { ExitInfo, OutputState, SessionStatus, WaitInput } from '../../src/contracts/types.js';

const config = {
  match_window_bytes_per_stream: 64 * 1024,
  max_pattern_bytes: 1024,
  regex_eval_timeout_ms: 50,
  max_match_compute_ms_per_call: 250,
};

type State = ExitInfo & OutputState & { status: SessionStatus };

function fixture(capacity = 512 * 1024): {
  ring: OutputRing;
  context: WaitContext;
  state: State;
  append(text: string): void;
  close(): void;
} {
  const ring = new OutputRing('wait-test', 'epoch-test', capacity);
  const listeners = new Set<() => void>();
  const state: State = {
    exit_code: null,
    signal: null,
    termination_reason: null,
    output_closed: false,
    output_complete: false,
    log_available: true,
    log_has_gaps: false,
    status: 'running',
  };
  return {
    ring,
    state,
    context: {
      getState: () => ({ ...state }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    append(text) {
      ring.append(text);
      for (const listener of listeners) listener();
    },
    close() {
      state.status = 'exited';
      state.output_closed = true;
      state.output_complete = true;
      ring.finish();
      for (const listener of listeners) listener();
    },
  };
}

function input(pattern: WaitInput['pattern'], extra: Partial<WaitInput> = {}): WaitInput {
  return { session_id: 'wait-test', pattern, timeout_ms: 20, ...extra };
}

describe('waitFor', () => {
  it('scans history including a prompt without newline', async () => {
    const f = fixture();
    f.append('server listening>');
    const result = await waitFor(f.ring, input({ type: 'literal', value: 'listening' }), f.context, config);
    expect(result.outcome).toBe('matched');
    expect(result.matched_text).toBe('listening');
    expect(result.scanned_cursor).toBe(result.match_end_cursor);
  });

  it('strips an SGR sequence split over append blocks', async () => {
    const f = fixture();
    f.append('ready \u001b[3');
    f.append('2mgreen\u001b[0');
    f.append('m prompt');
    const result = await waitFor(f.ring, input({ type: 'literal', value: 'ready green prompt' }), f.context, config);
    expect(result.outcome).toBe('matched');
    expect(result.matched_text).toBe('ready green prompt');
  });

  it('finds a literal crossing an internal 64 KiB scan boundary', async () => {
    const f = fixture(256 * 1024);
    const edge = config.match_window_bytes_per_stream;
    f.append('x'.repeat(edge - 3));
    f.append('needle');
    const result = await waitFor(f.ring, input({ type: 'literal', value: 'xxneedle' }), f.context, config);
    expect(result.outcome).toBe('matched');
    expect(result.matched_text).toBe('xxneedle');
  });

  it('start now excludes pre-existing text and observes appended text', async () => {
    const f = fixture();
    f.append('before');
    const waiting = waitFor(f.ring, input({ type: 'literal', value: 'before' }, { start: 'now', timeout_ms: 100 }), f.context, config);
    await delay(5);
    f.append(' after before');
    const result = await waiting;
    expect(result.outcome).toBe('matched');
    expect(result.matched_text).toBe('before');
    expect(result.match_start_cursor).not.toBe(f.ring.initialCursor);
  });

  it('reports output_gap when beginning has been evicted', async () => {
    const f = fixture(16);
    f.append('this output deliberately exceeds the tiny ring');
    const result = await waitFor(f.ring, input({ type: 'literal', value: 'output' }), f.context, config);
    expect(result.outcome).toBe('output_gap');
    expect(result.gap?.requested_cursor).toBe(f.ring.initialCursor);
    expect(result.earliest_cursor).toBe(f.ring.earliestCursor);
  });

  it('does not restore cross-call context after timeout', async () => {
    const f = fixture();
    f.append('alpha');
    const first = await waitFor(f.ring, input({ type: 'literal', value: 'alphabeta' }, { timeout_ms: 0 }), f.context, config);
    expect(first.outcome).toBe('timeout');
    f.append('beta');
    const resumed = await waitFor(
      f.ring,
      input({ type: 'literal', value: 'alphabeta' }, { cursor: first.scanned_cursor, timeout_ms: 0 }),
      f.context,
      config,
    );
    expect(resumed.outcome).toBe('timeout');
  });

  it('allows anchors, lookaround and zero-width ordinary JS regexes', async () => {
    const f = fixture();
    f.append('ready');
    const anchor = await waitFor(f.ring, input({ type: 'regex', value: '^ready$', flags: '' }), f.context, config);
    expect(anchor.outcome).toBe('matched');
    const lookaround = await waitFor(f.ring, input({ type: 'regex', value: '(?<=rea)dy' }), f.context, config);
    expect(lookaround.outcome).toBe('matched');
    const zero = await waitFor(f.ring, input({ type: 'regex', value: '(?=ready)' }), f.context, config);
    expect(zero.outcome).toBe('matched');
    expect(zero.match_start_cursor).toBe(zero.match_end_cursor);
  });

  it('rejects invalid regex syntax and flags as INVALID_PATTERN', async () => {
    const f = fixture();
    await expect(waitFor(f.ring, input({ type: 'regex', value: '(' }), f.context, config)).rejects.toMatchObject({ code: 'INVALID_PATTERN' });
    await expect(waitFor(f.ring, input({ type: 'regex', value: 'ok', flags: 'g' }), f.context, config)).rejects.toMatchObject({ code: 'INVALID_PATTERN' });
    await expect(waitFor(f.ring, input({ type: 'literal', value: 'ok', flags: '' }), f.context, config)).rejects.toMatchObject({ code: 'INVALID_PATTERN' });
  });

  it('returns a safe frontier on regular-expression budget exhaustion without blocking another ring', async () => {
    const slow = fixture(512 * 1024);
    slow.append('a'.repeat(config.match_window_bytes_per_stream - 1) + '!');
    const fast = fixture();
    fast.append('available');
    const stalled = waitFor(
      slow.ring,
      input({ type: 'regex', value: '^(a+)+$' }, { timeout_ms: 500 }),
      slow.context,
      { ...config, regex_eval_timeout_ms: 15 },
    );
    await delay(5);
    const independentlyReadable = fast.ring.scan(fast.ring.initialCursor, 1024);
    expect(independentlyReadable.units.map((unit) => unit.text).join('')).toBe('available');
    const responsive = await waitFor(fast.ring, input({ type: 'literal', value: 'available' }), fast.context, config);
    expect(responsive.outcome).toBe('matched');
    await expect(stalled).rejects.toMatchObject({
      code: 'MATCH_BUDGET_EXCEEDED',
      details: expect.objectContaining({
        session_id: 'wait-test',
        read_cursor: slow.ring.initialCursor,
        scanned_cursor: slow.ring.initialCursor,
      }),
    });
  });

  it('cancels an active worker and rejects with AbortError', async () => {
    const f = fixture(512 * 1024);
    f.append('a'.repeat(config.match_window_bytes_per_stream - 1) + '!');
    const controller = new AbortController();
    const context: WaitContext = { ...f.context, signal: controller.signal };
    const pending = waitFor(
      f.ring,
      input({ type: 'regex', value: '^(a+)+$' }, { timeout_ms: 500 }),
      context,
      { ...config, regex_eval_timeout_ms: 200 },
    );
    await delay(10);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});


describe('waitFor refined boundaries', () => {
  it('EMPTY-ZERO：空历史也以普通正则匹配零宽 ^$', async () => {
    const f=fixture();
    const result=await waitFor(f.ring,input({type:'regex',value:'^$'},{timeout_ms:0}),f.context,config);
    expect(result.outcome).toBe('matched');expect(result.matched_text).toBe('');
    expect(result.match_start_cursor).toBe(result.match_end_cursor);
  });
  it('PATTERN-BOUNDARY：拒绝超长、非字符串标志与未知模式字段', async () => {
    const f=fixture();
    for(const pattern of [{type:'regex',value:'x',flags:7},{type:'literal',value:'x'.repeat(1025)}])
      await expect(waitFor(f.ring,input(pattern as any),f.context,config)).rejects.toMatchObject({code:'INVALID_PATTERN'});
    await expect(waitFor(f.ring,input({type:'literal',value:'x',unknown:true} as any),f.context,config)).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
  });
  it('HISTORY-APPEND：在历史扫描让出时追加的输出仍能被检查', async () => {
    const f=fixture();f.append('prefix');
    const pending=waitFor(f.ring,input({type:'literal',value:'prefixsuffix'},{timeout_ms:200}),f.context,config);
    f.append('suffix');expect((await pending).outcome).toBe('matched');
  });
  it('WAIT-EXIT：输出关闭前不返回 exited，最后输出仍可匹配', async () => {
    const f=fixture();f.state.status='exited';
    const pending=waitFor(f.ring,input({type:'literal',value:'tail'},{timeout_ms:200}),f.context,config);
    f.append('tail');f.close();expect((await pending).outcome).toBe('matched');
    expect((await waitFor(f.ring,input({type:'literal',value:'missing'},{timeout_ms:0}),f.context,config)).outcome).toBe('exited');
  });
});


describe('跨片段普通环视回归', () => {
  it('REGEX-LOOKAHEAD-64K：返回文本在旧片段但依赖下一片段才能成立', async () => {
    const f=fixture();f.append('x'.repeat(65535)+'ab');
    const result=await waitFor(f.ring,input({type:'regex',value:'a(?=b)'},{timeout_ms:0}),f.context,config);
    expect(result.outcome).toBe('matched');expect(result.matched_text).toBe('a');
    expect(f.ring.offsetOf(result.match_start_cursor!)).toBe(65535);
    expect(f.ring.offsetOf(result.match_end_cursor!)).toBe(65536);
  });
  it('REGEX-LOOKAHEAD-NEW：历史 a 在新 b 到来后成立，零宽环视也不被过滤', async () => {
    const f=fixture();f.append('a');
    const pending=waitFor(f.ring,input({type:'regex',value:'a(?=b)'},{timeout_ms:500}),f.context,config);
    await delay(80);f.append('b');expect((await pending).matched_text).toBe('a');
    const zero=fixture();zero.append('x'.repeat(65535)+'ab');
    const result=await waitFor(zero.ring,input({type:'regex',value:'(?=ab)'},{timeout_ms:0}),zero.context,config);
    expect(result.outcome).toBe('matched');expect(zero.ring.offsetOf(result.match_start_cursor!)).toBe(65535);
  });
});
