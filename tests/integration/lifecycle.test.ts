import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resultOf } from '../../src/contracts/errors.js';
import type { CoreConfig } from '../../src/core/config.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { FakeBackend, type FakeProcessHandle } from '../fixtures/fake-backend.js';

interface Harness {
  manager: SessionManager;
  backend: FakeBackend;
}

const liveHarnesses: Harness[] = [];

function harness(overrides: Partial<CoreConfig> = {}): Harness {
  const backend = new FakeBackend();
  const manager = new SessionManager({
    config: {
      workspace_root: process.cwd(),
      default_runtime_timeout_ms: 5_000,
      max_runtime_timeout_ms: 10_000,
      idle_timeout_ms: 5_000,
      drain_timeout_ms: 20,
      default_terminate_grace_ms: 10,
      completed_record_ttl_ms: 5_000,
      max_tool_wait_ms: 1_000,
      ...overrides,
    },
    backend: backend.factory,
  });
  const value = { manager, backend };
  liveHarnesses.push(value);
  return value;
}

function launch(overrides: Record<string, unknown> = {}) {
  return { argv: ['/bin/sh'], ...overrides };
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  if (await check()) return;
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function closed(handle: FakeProcessHandle, code: number | null = 0, signal: string | null = null, complete = true): void {
  handle.finish(code, signal, complete);
}

afterEach(async () => {
  const current = liveHarnesses.splice(0);
  for (const value of current) value.backend.finishAll();
  await Promise.all(current.map(value => value.manager.close()));
});

describe('SessionManager lifecycle with a controllable backend', () => {
  it('keeps root exit and output closure as separate observable facts', async () => {
    const { manager, backend } = harness();
    const created = await manager.create(launch());
    const handle = backend.latest;
    handle.emitData('tail without newline');
    handle.setGroupExists(false);
    handle.emitExit(7, null);

    const afterExit = manager.status({ session_id: created.session_id });
    expect(afterExit).toMatchObject({
      status: 'exited',
      exit_code: 7,
      signal: null,
      output_closed: false,
      output_complete: false,
      log_available: true,
      log_has_gaps: false,
    });
    for (const key of ['output_closed', 'output_complete', 'log_available', 'log_has_gaps'] as const) {
      expect(typeof afterExit[key]).toBe('boolean');
    }

    const beforeEof = await manager.read({
      session_id: created.session_id,
      cursor: created.initial_cursor,
      max_bytes: 256,
    });
    expect(beforeEof.events.map(event => event.text).join('')).toBe('tail without newline');
    expect(beforeEof.eof).toBe(false);

    handle.emitClosed(true);
    const afterEof = await manager.read({
      session_id: created.session_id,
      cursor: beforeEof.next_cursor,
      max_bytes: 256,
    });
    expect(afterEof).toMatchObject({
      status: 'exited',
      output_closed: true,
      output_complete: true,
      log_available: true,
      log_has_gaps: false,
      eof: true,
    });
  });

  it('marks drain cutoff as incomplete and reports collector errors as log gaps', async () => {
    const drain = harness({ drain_timeout_ms: 25 });
    const created = await drain.manager.create(launch());
    const handle = drain.backend.latest;
    handle.setGroupExists(false);
    handle.emitExit(0, null);

    await eventually(() => drain.manager.status({ session_id: created.session_id }).output_closed, 300);
    const cutoff = drain.manager.status({ session_id: created.session_id });
    expect(handle.closeOutputCalls).toBe(1);
    expect(cutoff).toMatchObject({ output_closed: true, output_complete: false, log_has_gaps: true });

    const collector = harness();
    const collectorCreated = await collector.manager.create(launch());
    const collectorHandle = collector.backend.latest;
    collectorHandle.emitError(new Error('simulated read error'));
    const errored = collector.manager.status({ session_id: collectorCreated.session_id });
    expect(errored).toMatchObject({
      status: 'running',
      output_closed: false,
      output_complete: false,
      log_available: true,
      log_has_gaps: true,
    });
    closed(collectorHandle);
    expect(collector.manager.status({session_id:collectorCreated.session_id}).output_complete).toBe(false);
  });

  it('enforces live and retained-record quotas independently', async () => {
    const { manager, backend } = harness({ max_live_sessions: 1, max_session_records: 2 });
    const first = await manager.create(launch());

    const liveQuota = await resultOf(() => manager.create(launch()));
    expect(liveQuota).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryable: true } });

    closed(backend.latest);
    await eventually(() => manager.status({ session_id: first.session_id }).cleanup_result === 'group_cleared');
    const second = await manager.create(launch());
    closed(backend.latest);
    await eventually(() => manager.status({ session_id: second.session_id }).cleanup_result === 'group_cleared');

    const recordQuota = await resultOf(() => manager.create(launch()));
    expect(recordQuota).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryable: true } });
  });

  it('deletes completed records after TTL based on real elapsed time', async () => {
    const { manager, backend } = harness({ completed_record_ttl_ms: 30, idle_timeout_ms: 1_000 });
    const created = await manager.create(launch());
    closed(backend.latest);
    await eventually(() => manager.status({ session_id: created.session_id }).cleanup_result === 'group_cleared');

    await eventually(async () => {
      const lookup = await resultOf(() => manager.status({ session_id: created.session_id }));
      return !lookup.ok && lookup.error.code === 'SESSION_NOT_FOUND';
    }, 400);
  });

  it('applies runtime timeout and distinguishes idle activity from output and list calls', async () => {
    const runtime = harness({ drain_timeout_ms: 15, default_terminate_grace_ms: 5 });
    const runtimeCreated = await runtime.manager.create(launch({ runtime_timeout_ms: 30 }));
    const runtimeHandle = runtime.backend.latest;
    await eventually(() => runtimeHandle.signals.includes('SIGKILL'), 300);
    expect(runtime.manager.status({ session_id: runtimeCreated.session_id })).toMatchObject({
      status: 'stopping',
      termination_reason: 'runtime_timeout',
    });
    closed(runtimeHandle, null, 'SIGKILL', false);

    const idle = harness({ idle_timeout_ms: 60, drain_timeout_ms: 15, default_terminate_grace_ms: 5 });
    const outputOnly = await idle.manager.create(launch());
    const outputHandle = idle.backend.latest;
    await delay(20);
    outputHandle.emitData('activity from process only');
    idle.manager.list({});
    await eventually(() => outputHandle.signals.includes('SIGTERM'), 300);
    expect(idle.manager.status({ session_id: outputOnly.session_id }).termination_reason).toBe('idle_timeout');
    closed(outputHandle, null, 'SIGKILL', false);

    const statusKeepsAlive = await idle.manager.create(launch());
    const statusHandle = idle.backend.latest;
    for (let index = 0; index < 4; index += 1) {
      await delay(20);
      idle.manager.status({ session_id: statusKeepsAlive.session_id });
    }
    expect(statusHandle.signals).toEqual([]);
    await eventually(() => statusHandle.signals.includes('SIGTERM'), 300);
    expect(idle.manager.status({ session_id: statusKeepsAlive.session_id }).termination_reason).toBe('idle_timeout');
  });

  it('releases waiter capacity when an AbortSignal cancels a pending read', async () => {
    const { manager } = harness({ max_waiters_total: 1, max_tool_wait_ms: 1_000 });
    const created = await manager.create(launch());
    const abort = new AbortController();
    const pending = manager.read({
      session_id: created.session_id,
      cursor: created.initial_cursor,
      max_bytes: 256,
      wait_ms: 1_000,
    }, abort.signal);

    expect(manager.activeWaiters).toBe(1);
    const limited = await resultOf(() => manager.read({
      session_id: created.session_id,
      cursor: created.initial_cursor,
      max_bytes: 256,
      wait_ms: 1_000,
    }));
    expect(limited).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', retryable: true } });

    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.activeWaiters).toBe(0);
    await expect(manager.read({
      session_id: created.session_id,
      cursor: created.initial_cursor,
      max_bytes: 256,
      wait_ms: 0,
    })).resolves.toMatchObject({ timed_out: false });
  });

  it('drops a queued write during concurrent termination and starts only one cleanup task', async () => {
    const { manager, backend } = harness({ default_terminate_grace_ms: 10 });
    const created = await manager.create(launch());
    const handle = backend.latest;

    await manager.write({ session_id: created.session_id, text: 'must not reach a closed handle' });
    const terminations = await Promise.all([
      manager.terminate({ session_id: created.session_id, grace_ms: 10 }),
      manager.terminate({ session_id: created.session_id, grace_ms: 10 }),
    ]);
    expect(terminations.every(result => result.termination_requested)).toBe(true);
    const postTerminateWrite = await resultOf(() => manager.write({ session_id: created.session_id, text: 'late write' }));
    expect(postTerminateWrite).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_RUNNING' } });

    await delay(0);
    expect(handle.sent).toEqual([]);
    await eventually(() => handle.signals.includes('SIGKILL'), 300);
    expect(handle.signals.filter(signal => signal === 'SIGTERM')).toHaveLength(1);
    expect(handle.signals.filter(signal => signal === 'SIGKILL')).toHaveLength(1);
    closed(handle, null, 'SIGKILL', false);
  });

  it('lets run reuse its newly registered session and complete with a non-zero exit', async () => {
    const { manager, backend } = harness();
    const pending = manager.run({ ...launch(), wait_timeout_ms: 300, max_output_bytes: 256 });
    await eventually(() => backend.handles.length === 1);
    const handle = backend.latest;
    handle.emitData('command output');
    handle.setGroupExists(false);
    handle.emitExit(3, null);
    handle.emitClosed(true);

    await expect(pending).resolves.toMatchObject({
      outcome: 'completed',
      exit_code: 3,
      output_closed: true,
      output_complete: true,
      log_available: true,
      events: [expect.objectContaining({ text: 'command output' })],
    });
  });

  it('wraps backend spawn failures as SPAWN_FAILED with a diagnosable session record', async () => {
    const { manager, backend } = harness();
    backend.failNextSpawn(new Error('backend unavailable'));

    const failed = await resultOf(() => manager.create(launch()));
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: 'SPAWN_FAILED',
        retryable: false,
        details: { session_id: expect.any(String) },
      },
    });
    if (failed.ok) throw new Error('spawn unexpectedly succeeded');

    const snapshot = manager.status({ session_id: failed.error.details.session_id as string });
    expect(snapshot).toMatchObject({
      status: 'spawn_failed',
      output_closed: true,
      output_complete: false,
      log_available: true,
      log_has_gaps: true,
    });
  });

  it('closes all known process groups, clears records, and starts a new empty epoch', async () => {
    const { manager, backend } = harness({ default_terminate_grace_ms: 10, drain_timeout_ms: 20 });
    await manager.create(launch({ label: 'first' }));
    await manager.create(launch({ label: 'second' }));
    const oldEpoch = manager.serverEpoch;

    const closing = manager.close();
    await eventually(() => backend.handles.every(handle => handle.signals.includes('SIGTERM')));
    for (const handle of backend.handles) {
      handle.emitExit(null, 'SIGKILL');
      handle.emitClosed(false);
    }
    await closing;

    expect(backend.handles).toHaveLength(2);
    for (const handle of backend.handles) {
      expect(handle.signals).toContain('SIGTERM');
      expect(handle.signals).toContain('SIGKILL');
      expect(handle.groupExists()).toBe(false);
      expect(handle.disposed).toBe(true);
    }
    expect(manager.list({}).sessions).toEqual([]);

    const replacement = new SessionManager({ config: { workspace_root: process.cwd() }, backend: new FakeBackend().factory });
    try {
      expect(replacement.serverEpoch).not.toBe(oldEpoch);
      expect(replacement.list({}).sessions).toEqual([]);
    } finally {
      await replacement.close();
    }
  });
});


describe('SessionManager decoded-output and Worker boundaries', () => {
  it('READ-PARTIAL-UTF8：只有半个码点时等待新增，补全后返回稳定字符', async () => {
    const {manager,backend}=harness();const s=await manager.create(launch());
    const bytes=Buffer.from('汉');backend.latest.emitData(bytes.subarray(0,1));
    const pending=manager.read({session_id:s.session_id,cursor:s.initial_cursor,wait_ms:200,max_bytes:256});
    expect(manager.activeWaiters).toBe(1);backend.latest.emitData(bytes.subarray(1));
    const out=await pending;expect(out.events.map(e=>e.text).join('')).toBe('汉');expect(out.timed_out).toBe(false);
  });
  it('WORKER-OTHER-SESSION：灾难性回溯不阻塞其他会话 read/status', async () => {
    const {manager,backend}=harness({regex_eval_timeout_ms:20,max_match_compute_ms_per_call:250});
    const slow=await manager.create(launch());backend.latest.emitData('a'.repeat(65535)+'!');
    const fast=await manager.create(launch());backend.latest.emitData('available');
    const blocked=expect(manager.waitFor({session_id:slow.session_id,cursor:slow.initial_cursor,pattern:{type:'regex',value:'^(a+)+$'},timeout_ms:500})).rejects.toMatchObject({code:'MATCH_BUDGET_EXCEEDED'});
    await delay(5);
    expect(manager.status({session_id:fast.session_id}).status).toBe('running');
    expect((await manager.read({session_id:fast.session_id,cursor:fast.initial_cursor})).events.map(e=>e.text).join('')).toBe('available');
    await blocked;expect(manager.activeWaiters).toBe(0);
  });
});


describe('forkpty 组就绪回归', () => {
  it('GROUP-READY-RACE：组暂不可见但根存活时保持 pending，建立后执行信号', async () => {
    const {manager,backend}=harness({drain_timeout_ms:100});
    const s=await manager.create(launch());const h=backend.latest;h.setGroupExists(false);
    const first=await manager.terminate({session_id:s.session_id,grace_ms:0});expect(first.cleanup_result).toBe('pending');
    await delay(2);expect(manager.status({session_id:s.session_id}).cleanup_result).not.toBe('group_cleared');
    h.setGroupExists(true);await eventually(()=>h.signals.includes('SIGKILL'));h.emitExit(null,'SIGKILL');h.emitClosed(true);
    await eventually(()=>manager.status({session_id:s.session_id}).cleanup_result==='group_cleared');
  });
});


it('GROUP-READY-UNVERIFIED：根存在且组持续不可见时明确不假报已清空', async () => {
  const {manager,backend}=harness({drain_timeout_ms:20});const s=await manager.create(launch());
  const h=backend.latest;h.setGroupExists(false);
  await manager.terminate({session_id:s.session_id,grace_ms:0});
  await eventually(()=>manager.status({session_id:s.session_id}).cleanup_result==='unverified',350);
  expect(h.rootExists()).toBe(true);expect(h.signals).toEqual([]);
  expect(manager.status({session_id:s.session_id}).cleanup_result).not.toBe('group_cleared');
});
