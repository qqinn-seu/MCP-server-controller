import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LaunchInput, CreateData, ReadInput, ReadData, WriteInput, WriteData, StatusData,
  ListInput, ListData, TerminateInput, TerminateData, RunInput, RunData,
  WaitInput, WaitData, ExitInfo, OutputState, SessionStatus, CleanupResult, TerminationReason } from '../contracts/types.js';
import { CoreError, invalid } from '../contracts/errors.js';
import { makeConfig, assertRuntimeUser, type CoreConfig } from './config.js';
import { OutputRing } from './output-ring.js';
import { InputQueue } from './input-queue.js';
import { spawnPty, type BackendFactory, type ProcessHandle, type SpawnSpec } from './pty-backend.js';
import { waitFor } from '../matching/wait-matcher.js';

export interface CoreEvent { type: string; session_id: string; at: string; details: Record<string, unknown> }
export interface ManagerOptions {
  config?: Partial<CoreConfig>;
  backend?: BackendFactory;
  onEvent?: (event: CoreEvent) => void;
}
interface Session extends ExitInfo, OutputState {
  id: string; label: string | null; status: SessionStatus; cwd: string; summary: string;
  createdAt: string; startedAt: string | null; exitedAt: string | null; lastOutputAt: string | null;
  lastActivityAt: string; lastActivity: number; endedAt: number | null; runtime: number;
  ring: OutputRing; handle?: ProcessHandle; queue: InputQueue;
  cleanup: CleanupResult; cleanupPromise?: Promise<void>;
  runtimeTimer?: NodeJS.Timeout; drainTimer?: NodeJS.Timeout;
  listeners: Set<() => void>; version: number; collectorIncomplete: boolean;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function shape(value: unknown, keys: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('参数必须为对象。');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`未知参数：${key}`);
}
function integer(value: unknown, fallback: number, low: number, high: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high)
    invalid(`${name} 必须为 ${low}～${high} 的整数。`);
  return value;
}
function text(value: unknown, name: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.includes('\0') || Buffer.byteLength(value) > max)
    invalid(`${name} 必须为合法文本且不超过 ${max} UTF-8 字节。`);
}
const launchKeys = ['argv','shell_command','shell','cwd','env','mode','cols','rows','runtime_timeout_ms','label','approval_id'];
const statuses: SessionStatus[] = ['starting','running','stopping','exited','spawn_failed'];

export class SessionManager {
  readonly serverEpoch = randomUUID();
  readonly config: CoreConfig;
  private sessions = new Map<string, Session>();
  private factory: BackendFactory;
  private timer: NodeJS.Timeout;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private waiterCount = 0;
  private shutdownAbort = new AbortController();
  constructor(private readonly options: ManagerOptions = {}) {
    assertRuntimeUser();
    this.config = makeConfig(options.config); this.factory = options.backend ?? spawnPty;
    this.timer = setInterval(() => this.maintain(), Math.max(10, Math.min(1000,
      this.config.idle_timeout_ms / 4, this.config.completed_record_ttl_ms / 4)));
    this.timer.unref();
  }
  get activeWaiters() { return this.waiterCount; }
  private event(s: Session, type: string, details: Record<string, unknown> = {}) {
    // 内存事实回调不是阶段②的磁盘审计日志，默认不保存输入/输出原文。
    try { this.options.onEvent?.({ type, session_id: s.id, at: new Date().toISOString(), details }); }
    catch { /* 观察者异常不能改变已接受输入的事实或触发重复执行。 */ }
  }
  private notify(s: Session) { s.version++; for (const listener of [...s.listeners]) listener(); }
  private get(id: string, touch = true): Session {
    text(id, 'session_id', 256);
    const s = this.sessions.get(id);
    if (!s) throw new CoreError('SESSION_NOT_FOUND', '当前 Server 不存在此会话。', false, { session_id: id });
    if (touch) { s.lastActivity = performance.now(); s.lastActivityAt = new Date().toISOString(); }
    return s;
  }
  private state(s: Session): ExitInfo & OutputState & { status: SessionStatus } {
    return { status: s.status, exit_code: s.exit_code, signal: s.signal,
      termination_reason: s.termination_reason, output_closed: s.output_closed,
      output_complete: s.output_complete, log_available: true,
      log_has_gaps: s.log_has_gaps || s.ring.hasGaps };
  }
  private normalize(input: LaunchInput): { spec: SpawnSpec; runtime: number } {
    if ((input.argv === undefined) === (input.shell_command === undefined)) invalid('argv 与 shell_command 必须且只能有一个。');
    if (input.mode !== undefined && input.mode !== 'pty') invalid('V1 只支持 mode=pty。');
    if (input.shell !== undefined && input.shell_command === undefined) invalid('shell 只能与 shell_command 一起提供。');
    if (input.approval_id !== undefined) throw new CoreError('UNSUPPORTED_OPERATION', '审批属于阶段③，阶段①不能接受 approval_id。');
    if (input.label !== undefined) text(input.label, 'label', 128, true);
    if (input.cwd !== undefined) text(input.cwd, 'cwd', 16384);
    let cwd: string;
    try { cwd = realpathSync(resolve(this.config.workspace_root, input.cwd ?? '.')); if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { invalid('cwd 必须为已存在的目录。'); }
    // 本阶段只解析真实启动目录；工作目录白名单属于阶段②，不伪称文件系统隔离。
    const env = { ...this.config.base_env };
    if (input.env !== undefined) {
      if (input.env === null || typeof input.env !== 'object' || Array.isArray(input.env)) invalid('env 必须为键值映射。');
      const entries = Object.entries(input.env); if (entries.length > 64) invalid('env 最多64项。');
      let total = 0;
      for (const [key, value] of entries) {
        text(key, 'env key', 128); text(value, 'env value', 4096, true);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid('环境变量名不合法。');
        total += Buffer.byteLength(key) + Buffer.byteLength(value); env[key] = value;
      }
      if (total > 16384) invalid('env 覆盖总量超限。');
    }
    let file: string, args: string[];
    if (input.argv !== undefined) {
      if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 256) invalid('argv 必须为1～256个元素。');
      input.argv.forEach((v, i) => text(v, 'argv', 16384, i !== 0));
      if (input.argv.reduce((n, v) => n + Buffer.byteLength(v), 0) > 16384) invalid('命令规格超过16KiB。');
      file = input.argv[0]!; args = input.argv.slice(1);
    } else {
      text(input.shell_command, 'shell_command', 16384);
      file = input.shell ?? '/bin/sh'; text(file, 'shell', 16384);
      if (!isAbsolute(file) || !this.config.allowed_shells.includes(file)) invalid('shell 不在受配置的绝对路径允许列表。');
      args = ['-c', input.shell_command];
    }
    // execvp 的找不到程序经 PTY 可能表现为 exit 127，先确认可执行路径以准确分类 SPAWN_FAILED。
    const candidates = file.includes('/') ? [resolve(cwd, file)] : (env.PATH ?? '').split(':').filter(Boolean).map(p => join(p, file));
    const executable = candidates.find(p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
    if (!executable) throw new CoreError('SPAWN_FAILED', '找不到可执行程序或无执行权限。', false);
    const runtime = input.runtime_timeout_ms === undefined || input.runtime_timeout_ms === null
      ? this.config.default_runtime_timeout_ms
      : integer(input.runtime_timeout_ms, this.config.default_runtime_timeout_ms, 1, this.config.max_runtime_timeout_ms, 'runtime_timeout_ms');
    return { runtime, spec: { file: executable, args, cwd, env,
      cols: integer(input.cols, 100, 1, 500, 'cols'), rows: integer(input.rows, 30, 1, 500, 'rows') } };
  }
  async create(input: LaunchInput): Promise<CreateData> {
    shape(input, launchKeys);
    if (this.shuttingDown) throw new CoreError('SESSION_NOT_RUNNING', 'Server 正在关闭，不接受新执行。');
    const { spec, runtime } = this.normalize(input);
    this.maintain();
    const live = [...this.sessions.values()].filter(s => s.status === 'starting' || s.status === 'running' || s.status === 'stopping' || !s.output_closed || s.cleanup === 'pending');
    if (live.length >= this.config.max_live_sessions || this.sessions.size >= this.config.max_session_records)
      throw new CoreError('QUOTA_EXCEEDED', '会话或保留记录配额已满。', true);
    const id = randomUUID(), at = new Date().toISOString();
    const ring = new OutputRing(id, this.serverEpoch, this.config.per_session_output_bytes);
    const s: Session = { id, label: input.label ?? null, status: 'starting', cwd: spec.cwd,
      summary: input.argv ? JSON.stringify(input.argv) : input.shell_command!,
      createdAt: at, startedAt: null, exitedAt: null, lastOutputAt: null,
      lastActivityAt: at, lastActivity: performance.now(), endedAt: null, runtime,
      ring, queue: undefined as unknown as InputQueue, cleanup: 'not_requested', listeners: new Set(), version: 0, collectorIncomplete: false,
      exit_code: null, signal: null, termination_reason: null, output_closed: false,
      output_complete: false, log_available: true, log_has_gaps: false };
    s.queue = new InputQueue(this.config.input_queue_bytes_per_session,
      async (entry, signal) => { if (!s.handle) throw new Error('PTY尚未建立。'); await s.handle.send(entry.data, signal); },
      (type, entry, error) => this.event(s, `input_${type}`, { write_id: entry.writeId, input_bytes: entry.data.byteLength,
        ...(error ? { message: String(error), delivery: 'unconfirmed' } : {}) }));
    this.sessions.set(id, s); this.event(s, 'registered');
    try {
      s.handle = this.factory(spec, {
        data: data => { if (s.output_closed) return; ring.append(data); s.lastOutputAt = new Date().toISOString(); this.notify(s); },
        exit: (code, signal) => this.exited(s, code, signal),
        closed: complete => this.outputClosed(s, complete),
        error: error => { s.collectorIncomplete = true; s.output_complete = false; s.log_has_gaps = true; ring.markGap(); this.event(s, 'collector_error', { message: error.message }); this.notify(s); },
      });
      // 后端可以在注册阶段同步报告退出，不能把已确认终态覆盖回 running。
      if (s.status === 'starting') s.status = 'running';
      s.startedAt = new Date().toISOString();
      if (s.status === 'running') s.runtimeTimer = setTimeout(() => this.requestStop(s, 'runtime_timeout', this.config.default_terminate_grace_ms), runtime);
      this.event(s, 'started'); this.notify(s);
      return this.created(s);
    } catch (error) {
      s.status = 'spawn_failed'; s.exitedAt = new Date().toISOString(); s.endedAt = performance.now();
      s.queue.stop(); this.outputClosed(s, false); this.event(s, 'spawn_failed');
      throw new CoreError('SPAWN_FAILED', `PTY启动失败：${String(error)}`, false, { session_id: id });
    }
  }
  private created(s: Session): CreateData {
    return { ...this.state(s), session_id: s.id, server_epoch: this.serverEpoch, label: s.label,
      mode: 'pty', initial_cwd: s.cwd, created_at: s.createdAt, started_at: s.startedAt,
      initial_cursor: s.ring.initialCursor, effective_runtime_timeout_ms: s.runtime };
  }
  private outputClosed(s: Session, complete: boolean) {
    if (s.output_closed) return;
    complete = complete && !s.collectorIncomplete;
    s.ring.finish(); s.output_closed = true; s.output_complete = complete;
    if (!complete) { s.log_has_gaps = true; s.ring.markGap(); }
    if (s.drainTimer) clearTimeout(s.drainTimer); s.drainTimer = undefined;
    this.event(s, 'output_closed', { output_complete: complete }); this.notify(s); this.maybeDispose(s);
  }
  private exited(s: Session, code: number | null, signal: string | null) {
    if (s.status === 'exited' || s.status === 'spawn_failed') return;
    s.status = 'exited'; s.exit_code = code; s.signal = signal;
    s.exitedAt = new Date().toISOString(); s.endedAt = performance.now(); s.queue.stop();
    if (s.runtimeTimer) clearTimeout(s.runtimeTimer); s.runtimeTimer = undefined;
    if (!s.output_closed) s.drainTimer = setTimeout(() => {
      s.handle?.closeOutput(); this.outputClosed(s, false);
    }, this.config.drain_timeout_ms);
    this.event(s, 'exited', { exit_code: code, signal }); this.notify(s);
    // 若 root exit 在 backend 返回 handle 前同步发生，下一轮再启动残留组收尾。
    queueMicrotask(() => { if (s.handle && !s.cleanupPromise) this.startCleanup(s, this.config.default_terminate_grace_ms); });
  }
  private maybeDispose(s: Session) {
    if ((s.status === 'exited' || s.status === 'spawn_failed') && s.output_closed && s.cleanup !== 'pending') s.handle?.dispose();
  }
  private reserveWaiter(): () => void {
    if (this.waiterCount >= this.config.max_waiters_total) throw new CoreError('QUOTA_EXCEEDED', '等待者配额已满。', true);
    this.waiterCount++; let released = false;
    return () => { if (!released) { released = true; this.waiterCount--; } };
  }
  private combinedSignal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.shutdownAbort.signal]) : this.shutdownAbort.signal; }
  private changed(s: Session, version: number, ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (s.version !== version || ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (error?: unknown) => { clearTimeout(timer); s.listeners.delete(onChange); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(); };
      const onChange = () => finish(); const onAbort = () => finish(signal?.reason ?? new DOMException('Aborted','AbortError'));
      s.listeners.add(onChange); signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(), ms);
      if (s.version !== version) finish();
    });
  }
  private page(s: Session, cursor: string, maxBytes: number) {
    const page = s.ring.read(cursor, maxBytes);
    return { ...this.state(s), session_id: s.id, mode: 'pty' as const,
      ...page, eof: s.output_closed && s.ring.offsetOf(page.next_cursor) === s.ring.latestOffset,
      gap: null };
  }
  async read(input: ReadInput, signal?: AbortSignal): Promise<ReadData> {
    shape(input, ['session_id','cursor','max_bytes','wait_ms']);
    const s = this.get(input.session_id); text(input.cursor, 'cursor', 2048);
    const bytes = integer(input.max_bytes, this.config.default_output_page_bytes, 256, this.config.max_output_page_bytes, 'max_bytes');
    const ms = integer(input.wait_ms, 0, 0, this.config.max_tool_wait_ms, 'wait_ms');
    s.ring.offsetOf(input.cursor);
    const deadline = performance.now() + ms; let release: (() => void) | undefined;
    try {
      let page = this.page(s, input.cursor, bytes);
      // 原始字节可能仅包含半个 UTF-8 码点；它不是可立即返回的现成文本。
      while (!s.output_closed && page.events.length === 0 && ms > 0 && performance.now() < deadline) {
        release ??= this.reserveWaiter();
        await this.changed(s, s.version, deadline - performance.now(), this.combinedSignal(signal));
        page = this.page(s, input.cursor, bytes);
      }
      return { ...page, timed_out: ms > 0 && page.events.length === 0 && !s.output_closed && performance.now() >= deadline };
    } finally { release?.(); }
  }
  async write(input: WriteInput): Promise<WriteData> {
    shape(input, ['session_id','text','key','approval_id']);
    if ((input.text === undefined) === (input.key === undefined)) invalid('text与key必须且只能存在一个。');
    if (input.approval_id !== undefined) throw new CoreError('UNSUPPORTED_OPERATION','审批属于阶段③。');
    if (input.key !== undefined && input.key !== 'CTRL_C') invalid('只支持CTRL_C。');
    if (input.text !== undefined) text(input.text, 'text', this.config.max_input_bytes_per_call);
    const s = this.get(input.session_id);
    if (s.status !== 'running') throw new CoreError('SESSION_NOT_RUNNING', '会话不接受新输入。', false, { session_id: s.id });
    const data = Buffer.from(input.key ? '\x03' : input.text!, 'utf8'), writeId = randomUUID();
    s.queue.enqueue({ writeId, data }); this.event(s, 'input_queued', { write_id: writeId, input_bytes: data.byteLength });
    return { session_id: s.id, status: s.status, input_bytes: data.byteLength, delivery: 'queued', write_id: writeId };
  }
  status(input: {session_id: string}): StatusData {
    shape(input, ['session_id']); const s = this.get(input.session_id);
    return { ...this.state(s), session_id: s.id, server_epoch: this.serverEpoch, label: s.label, mode: 'pty',
      initial_cwd: s.cwd, command_summary: s.summary, created_at: s.createdAt, started_at: s.startedAt,
      exited_at: s.exitedAt, last_output_at: s.lastOutputAt, last_client_activity_at: s.lastActivityAt,
      effective_runtime_timeout_ms: s.runtime, retained_output_bytes: s.ring.retainedBytes,
      earliest_cursor: s.ring.earliestCursor, latest_cursor: s.ring.latestCursor,
      cleanup_scope: 'process_group', cleanup_result: s.cleanup };
  }
  list(input: ListInput = {}): ListData {
    shape(input, ['statuses','label']);
    if (input.statuses !== undefined && (!Array.isArray(input.statuses) || input.statuses.some(x => !statuses.includes(x)))) invalid('statuses包含非法状态。');
    if (input.label !== undefined) text(input.label, 'label',128,true);
    const sessions = [...this.sessions.values()]
      .filter(s => (!input.statuses || input.statuses.includes(s.status)) && (input.label === undefined || s.label === input.label))
      .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(s => ({ ...this.state(s), session_id:s.id, server_epoch:this.serverEpoch,label:s.label,mode:'pty' as const,
        initial_cwd:s.cwd,command_summary:s.summary,created_at:s.createdAt }));
    const result = { server_epoch: this.serverEpoch, sessions };
    if (Buffer.byteLength(JSON.stringify(result)) * 2 > this.config.max_serialized_tool_result_bytes)
      throw new CoreError('QUOTA_EXCEEDED','完整列表超过结果预算；请缩小过滤条件。',false);
    return result;
  }
  async terminate(input: TerminateInput): Promise<TerminateData> {
    shape(input,['session_id','grace_ms','reason']);
    const grace = integer(input.grace_ms,this.config.default_terminate_grace_ms,0,10000,'grace_ms');
    if (input.reason !== undefined) text(input.reason,'reason',512,true);
    const s=this.get(input.session_id);
    const requested=s.status==='starting'||s.status==='running'||s.status==='stopping';
    if (requested) this.requestStop(s,'user_request',grace);
    else if (s.handle && !s.cleanupPromise) this.startCleanup(s,grace);
    return { ...this.state(s),session_id:s.id,termination_requested:requested,
      cleanup_scope:'process_group',cleanup_result:s.cleanup };
  }
  private requestStop(s:Session,reason:TerminationReason,grace:number) {
    if (s.status==='running'||s.status==='starting') { s.status='stopping'; s.termination_reason=reason; s.queue.stop(); this.notify(s); }
    if (s.runtimeTimer) clearTimeout(s.runtimeTimer); s.runtimeTimer=undefined;
    this.startCleanup(s,grace);
  }
  private startCleanup(s:Session,grace:number) {
    if (s.cleanupPromise) return;
    s.cleanup='pending';
    s.cleanupPromise=(async()=>{
      const handle=s.handle;
      if (!handle) { s.cleanup='unverified'; return; }
      let operation='none',phase='group_ready';
      let attemptedSignal:NodeJS.Signals|null=null;
      const groupExists=()=>{operation='probe_group';attemptedSignal=null;return handle.groupExists();};
      const rootExists=()=>{operation='probe_root';attemptedSignal=null;return handle.rootExists();};
      const signalGroup=(signal:NodeJS.Signals)=>{operation='signal_group';attemptedSignal=signal;handle.signalGroup(signal);};
      try {
        // forkpty 父侧返回后，子侧可能尚未完成 setsid/PGID 建立。
        // 暂时找不到 -PID 不等于组已清空；只探测当前受管根PID，不做重启身份核验。
        const readyDeadline=performance.now()+Math.max(100,this.config.drain_timeout_ms);
        while (!groupExists() && rootExists() && performance.now()<readyDeadline) await sleep(1);
        if (!groupExists() && rootExists()) { s.cleanup='unverified'; return; }
        if (groupExists()) {
          phase='term';
          try { signalGroup('SIGTERM'); this.event(s,'signal',{signal:'SIGTERM'}); }
          catch(error) { if ((error as NodeJS.ErrnoException).code!=='ESRCH') throw error; }
          phase='grace_wait';
          const until=performance.now()+grace;
          while (groupExists() && performance.now()<until) await sleep(Math.min(20,Math.max(1,until-performance.now())));
          phase='escalate';
          if (groupExists()) { try { signalGroup('SIGKILL'); this.event(s,'signal',{signal:'SIGKILL'}); }
            catch(error) { if ((error as NodeJS.ErrnoException).code!=='ESRCH') throw error; } }
          phase='final_wait';
          const final=performance.now()+this.config.drain_timeout_ms+500;
          while((groupExists()||rootExists())&&performance.now()<final) await sleep(5);
        }
        phase='verify_clear';
        s.cleanup=groupExists()||rootExists()?'partial':'group_cleared';
      } catch(error) {
        const detail=(error && typeof error==='object'?error:{}) as NodeJS.ErrnoException;
        s.cleanup='failed';
        this.event(s,'cleanup_error',{message:String(error),code:detail.code??null,
          errno:detail.errno??null,syscall:detail.syscall??null,operation,phase,
          attempted_signal:attemptedSignal,pid:handle.pid,pgid:handle.pgid,
          root_exit_observed:s.exitedAt!==null,status:s.status});
      }
      finally { this.event(s,'cleanup',{result:s.cleanup}); this.notify(s); this.maybeDispose(s); }
    })();
  }
  async waitFor(input:WaitInput,signal?:AbortSignal):Promise<WaitData> {
    shape(input,['session_id','cursor','start','pattern','stream','timeout_ms']);
    if (input.cursor !== undefined && input.start !== undefined) invalid('cursor 与 start 互斥。');
    if (input.cursor !== undefined) text(input.cursor,'cursor',2048);
    if (input.start !== undefined && input.start !== 'beginning' && input.start !== 'now') invalid('start不合法。');
    if (input.stream !== undefined && input.stream !== 'pty' && input.stream !== 'all') invalid('V1只允许pty/all流。');
    integer(input.timeout_ms,10000,0,this.config.max_tool_wait_ms,'timeout_ms');
    const s=this.get(input.session_id);
    const release=this.reserveWaiter();
    try { return await waitFor(s.ring,input,{
      getState:()=>this.state(s),signal:this.combinedSignal(signal),
      subscribe:listener=>{s.listeners.add(listener);return()=>s.listeners.delete(listener);},
    },this.config); } finally {release();}
  }
  async run(input:RunInput,signal?:AbortSignal):Promise<RunData> {
    shape(input,[...launchKeys,'wait_timeout_ms','max_output_bytes']);
    const wait=integer(input.wait_timeout_ms,1000,0,this.config.max_tool_wait_ms,'wait_timeout_ms');
    const bytes=integer(input.max_output_bytes,this.config.default_output_page_bytes,256,this.config.max_output_page_bytes,'max_output_bytes');
    const {wait_timeout_ms:_wait,max_output_bytes:_bytes,...launch}=input;
    const created=await this.create(launch); const s=this.get(created.session_id);
    const deadline=performance.now()+wait;let release:(()=>void)|undefined;
    try {
      while (!(s.status==='exited'&&s.output_closed) && performance.now()<deadline) {
        release??=this.reserveWaiter();await this.changed(s,s.version,deadline-performance.now(),this.combinedSignal(signal));
      }
      let cursor=created.initial_cursor, gap:RunData['gap']=null;
      try {s.ring.offsetOf(cursor);} catch(error) {
        if (!(error instanceof CoreError) || error.code!=='CURSOR_EXPIRED') throw error;
        gap={reason:'retention_eviction',requested_cursor:cursor,earliest_cursor:s.ring.earliestCursor};cursor=s.ring.earliestCursor;
      }
      return {...this.page(s,cursor,bytes),gap,outcome:s.status==='exited'&&s.output_closed?'completed':'background',
        server_epoch:this.serverEpoch,label:s.label,initial_cursor:created.initial_cursor,effective_runtime_timeout_ms:s.runtime};
    }finally{release?.();}
  }
  private maintain() {
    const now=performance.now();
    for (const s of this.sessions.values()) {
      if ((s.status==='running'||s.status==='starting') && now-s.lastActivity>=this.config.idle_timeout_ms)
        this.requestStop(s,'idle_timeout',this.config.default_terminate_grace_ms);
      if (s.endedAt!==null && s.output_closed && s.cleanup!=='pending' && now-s.endedAt>=this.config.completed_record_ttl_ms) {
        s.handle?.dispose();this.sessions.delete(s.id);
      }
    }
  }
  close():Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown=true;clearInterval(this.timer);this.shutdownAbort.abort();
    this.shutdownPromise=(async()=>{
      const current=[...this.sessions.values()];
      for(const s of current) {
        if(s.status==='running'||s.status==='starting'||s.status==='stopping')this.requestStop(s,'server_shutdown',this.config.default_terminate_grace_ms);
        else if(s.handle&&!s.cleanupPromise)this.startCleanup(s,this.config.default_terminate_grace_ms);
      }
      await Promise.all(current.map(async s=>{
        await s.cleanupPromise;
        const deadline=performance.now()+this.config.drain_timeout_ms+500;
        while ((!s.output_closed || s.status==='stopping') && performance.now()<deadline) await sleep(10);
        if(!s.output_closed){s.handle?.closeOutput();this.outputClosed(s,false);}
        if(s.runtimeTimer)clearTimeout(s.runtimeTimer);if(s.drainTimer)clearTimeout(s.drainTimer);
        s.queue.stop();s.handle?.dispose();s.listeners.clear();
      }));
      this.sessions.clear();
    })();
    return this.shutdownPromise;
  }
}
