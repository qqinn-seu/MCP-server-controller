import { CoreError } from '../contracts/errors.js';

export interface CoreConfig {
  workspace_root: string;
  max_live_sessions: number;
  max_session_records: number;
  per_session_output_bytes: number;
  default_output_page_bytes: number;
  max_output_page_bytes: number;
  max_serialized_tool_result_bytes: number;
  input_queue_bytes_per_session: number;
  max_input_bytes_per_call: number;
  max_waiters_total: number;
  max_tool_wait_ms: number;
  default_runtime_timeout_ms: number;
  max_runtime_timeout_ms: number;
  idle_timeout_ms: number;
  drain_timeout_ms: number;
  default_terminate_grace_ms: number;
  completed_record_ttl_ms: number;
  match_window_bytes_per_stream: number;
  max_pattern_bytes: number;
  regex_eval_timeout_ms: number;
  max_match_compute_ms_per_call: number;
  allowed_shells: string[];
  base_env: Record<string, string>;
}
export function defaultConfig(workspaceRoot = process.cwd()): CoreConfig {
  return {
    workspace_root: workspaceRoot, max_live_sessions: 16, max_session_records: 256,
    per_session_output_bytes: 8388608, default_output_page_bytes: 32768,
    max_output_page_bytes: 65536, max_serialized_tool_result_bytes: 1048576,
    input_queue_bytes_per_session: 65536, max_input_bytes_per_call: 16384,
    max_waiters_total: 64, max_tool_wait_ms: 10000,
    default_runtime_timeout_ms: 3600000, max_runtime_timeout_ms: 86400000,
    idle_timeout_ms: 1800000, drain_timeout_ms: 2000,
    default_terminate_grace_ms: 2000, completed_record_ttl_ms: 3600000,
    match_window_bytes_per_stream: 65536, max_pattern_bytes: 1024,
    regex_eval_timeout_ms: 50, max_match_compute_ms_per_call: 250,
    allowed_shells: ['/bin/sh', '/bin/bash', '/bin/zsh'],
    // 核心只接受显式基础环境；不复制 Server 的完整环境。阶段③增加可配置环境策略。
    base_env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? workspaceRoot,
      LANG: 'C.UTF-8', TERM: 'xterm-256color' },
  };
}
export function assertRuntimeUser(uid = process.getuid?.()): void {
  if (uid === 0) throw new CoreError('COMMAND_DENIED', '生产和当前测试入口默认拒绝 root；请以普通用户运行。');
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new CoreError('UNSUPPORTED_OPERATION', 'V1 只支持 Linux 与 macOS。');
}
export function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  const c = { ...defaultConfig(), ...overrides };
  for (const [key, value] of Object.entries(c)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
      throw new CoreError('INVALID_ARGUMENT', `${key} 必须为正整数。`);
  }
  if (c.default_runtime_timeout_ms > c.max_runtime_timeout_ms || c.default_output_page_bytes > c.max_output_page_bytes)
    throw new CoreError('INVALID_ARGUMENT', '默认值不得大于配置上限。');
  if (c.per_session_output_bytes < 4 || c.match_window_bytes_per_stream < 4)
    throw new CoreError('INVALID_ARGUMENT', '字节缓冲至少需要容纳一个 UTF-8 码点。');
  return c;
}
