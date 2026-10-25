import { describe, expect, it } from 'vitest';
import { CoreError, resultOf } from '../../src/contracts/errors.js';
import { assertRuntimeUser, defaultConfig, makeConfig } from '../../src/core/config.js';

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

describe('core configuration', () => {
  it('provides explicit safe defaults rather than copying the full process environment', () => {
    const config = defaultConfig('/workspace');

    expect(config.workspace_root).toBe('/workspace');
    expect(config.allowed_shells).toEqual(['/bin/sh', '/bin/bash', '/bin/zsh']);
    expect(config.base_env).toMatchObject({
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
    });
    expect(Object.keys(config.base_env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM']);
    expect(config.max_live_sessions).toBeGreaterThan(0);
    expect(config.per_session_output_bytes).toBeGreaterThanOrEqual(4);
  });

  it('merges a valid partial configuration without mutating defaults', () => {
    const defaults = defaultConfig('/first');
    const effective = makeConfig({
      workspace_root: '/second',
      max_live_sessions: 2,
      base_env: { PATH: '/bin', TERM: 'vt100' },
      allowed_shells: ['/bin/sh'],
    });

    expect(effective.workspace_root).toBe('/second');
    expect(effective.max_live_sessions).toBe(2);
    expect(effective.base_env).toEqual({ PATH: '/bin', TERM: 'vt100' });
    expect(effective.allowed_shells).toEqual(['/bin/sh']);
    expect(defaults.workspace_root).toBe('/first');
    expect(defaults.allowed_shells).toEqual(['/bin/sh', '/bin/bash', '/bin/zsh']);
  });

  it('throws CoreError for non-positive numeric limits and inconsistent limit pairs', () => {
    expect(() => makeConfig({ max_live_sessions: 0 })).toThrow(CoreError);
    expectCoreError(() => makeConfig({ max_live_sessions: 0 }), 'INVALID_ARGUMENT');
    expectCoreError(() => makeConfig({ default_runtime_timeout_ms: 11, max_runtime_timeout_ms: 10 }), 'INVALID_ARGUMENT');
    expectCoreError(() => makeConfig({ default_output_page_bytes: 1025, max_output_page_bytes: 1024 }), 'INVALID_ARGUMENT');
    expectCoreError(() => makeConfig({ per_session_output_bytes: 3 }), 'INVALID_ARGUMENT');
    expectCoreError(() => makeConfig({ match_window_bytes_per_stream: 3 }), 'INVALID_ARGUMENT');
  });

  it('keeps expected core failures throwable and resultOf-encapsulable', async () => {
    expectCoreError(() => assertRuntimeUser(0), 'COMMAND_DENIED');

    const result = await resultOf(() => makeConfig({ idle_timeout_ms: -1 }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', retryable: false },
    });
  });
});
