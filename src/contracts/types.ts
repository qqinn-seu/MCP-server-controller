// 依据现行 V1 规格；阶段一仅内核，不注册 MCP 工具。
export type Success<T> = {
  ok: true;
  data: T;
};

export type Failure = {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
};

export type SessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "spawn_failed";

export type Mode = "pty";
export type Stream = "pty";
export type Cursor = string;

export type TerminationReason =
  | "user_request"
  | "runtime_timeout"
  | "idle_timeout"
  | "server_shutdown"
  | null;

export interface ExitInfo {
  exit_code: number | null;
  signal: string | null;
  termination_reason: TerminationReason;
}

export interface OutputState {
  output_closed: boolean;
  output_complete: boolean;
  log_available: boolean;
  log_has_gaps: boolean;
}

export interface OutputEvent {
  seq: number;
  stream: Stream;
  text: string;
  start_cursor: Cursor;
  end_cursor: Cursor;
}

export interface Gap {
  reason: "retention_eviction" | "prefix_unavailable" | "collector_incomplete";
  requested_cursor: Cursor;
  earliest_cursor: Cursor | null;
}

export interface OutputPage extends ExitInfo, OutputState {
  session_id: string;
  mode: Mode;
  status: SessionStatus;
  events: OutputEvent[];
  read_cursor: Cursor;
  next_cursor: Cursor;
  earliest_cursor: Cursor;
  has_more: boolean;
  eof: boolean;
  gap: Gap | null;
}

export interface CreateData extends ExitInfo, OutputState {
  session_id: string;
  server_epoch: string;
  label: string | null;
  mode: Mode;
  status: SessionStatus;
  initial_cwd: string;
  created_at: string;
  started_at: string | null;
  initial_cursor: Cursor;
  effective_runtime_timeout_ms: number;
}

export type CleanupResult =
  | "not_requested"
  | "pending"
  | "group_cleared"
  | "partial"
  | "unverified"
  | "failed";

export interface StatusData extends ExitInfo, OutputState {
  session_id: string;
  server_epoch: string;
  label: string | null;
  mode: Mode;
  status: SessionStatus;
  initial_cwd: string;
  command_summary: string;
  created_at: string;
  started_at: string | null;
  exited_at: string | null;
  last_output_at: string | null;
  last_client_activity_at: string;
  effective_runtime_timeout_ms: number;
  retained_output_bytes: number;
  earliest_cursor: Cursor | null;
  latest_cursor: Cursor | null;
  cleanup_scope: "process_group";
  cleanup_result: CleanupResult;
}

export interface LaunchInput {
  argv?: string[];
  shell_command?: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  mode?: Mode;
  cols?: number;
  rows?: number;
  runtime_timeout_ms?: number | null;
  label?: string;
  approval_id?: string;
}

export interface ReadInput {
  session_id: string;
  cursor: Cursor;
  max_bytes?: number;
  wait_ms?: number;
}

export interface ReadData extends OutputPage {
  timed_out: boolean;
}

export interface WriteInput {
  session_id: string;
  text?: string;
  key?: "CTRL_C";
  approval_id?: string;
}

export interface WriteData {
  session_id: string;
  status: SessionStatus;
  input_bytes: number;
  delivery: "queued";
  write_id: string;
}

export interface ListInput {
  statuses?: SessionStatus[];
  label?: string;
}

export interface SessionSummary extends ExitInfo, OutputState {
  session_id: string;
  server_epoch: string;
  label: string | null;
  mode: Mode;
  status: SessionStatus;
  initial_cwd: string;
  command_summary: string;
  created_at: string;
}

export interface ListData {
  server_epoch: string;
  sessions: SessionSummary[];
}

export interface TerminateInput {
  session_id: string;
  grace_ms?: number;
  reason?: string;
}

export interface TerminateData extends ExitInfo, OutputState {
  session_id: string;
  status: SessionStatus;
  termination_requested: boolean;
  cleanup_scope: "process_group";
  cleanup_result: CleanupResult;
}

export interface WaitInput {
  session_id: string;
  cursor?: Cursor;
  start?: "beginning" | "now";
  pattern: {
    type: "literal" | "regex";
    value: string;
    flags?: string;
  };
  stream?: Stream | "all";
  timeout_ms?: number;
}

export interface WaitData extends ExitInfo, OutputState {
  session_id: string;
  status: SessionStatus;
  outcome: "matched" | "timeout" | "exited" | "output_gap";
  read_cursor: Cursor;
  scanned_cursor: Cursor;
  matched_text: string | null;
  matched_stream: Stream | null;
  match_start_cursor: Cursor | null;
  match_end_cursor: Cursor | null;
  earliest_cursor: Cursor | null;
  gap: Gap | null;
}

export interface RunInput extends LaunchInput {
  wait_timeout_ms?: number;
  max_output_bytes?: number;
}

export interface RunData extends OutputPage {
  outcome: "completed" | "background";
  server_epoch: string;
  label: string | null;
  initial_cursor: Cursor;
  effective_runtime_timeout_ms: number;
}

export type Result<T> = Success<T> | Failure;
