import * as pty from 'node-pty';
import { write as fsWrite } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { ReadStream } from 'node:tty';

export interface SpawnSpec {
  file: string; args: string[]; cwd: string; env: Record<string, string>;
  cols: number; rows: number;
}
export interface BackendCallbacks {
  data(data: Buffer): void;
  exit(code: number | null, signal: string | null): void;
  closed(complete: boolean): void;
  error(error: Error): void;
}
export interface ProcessHandle {
  readonly pid: number;
  readonly pgid: number;
  send(data: Buffer, signal?: AbortSignal): Promise<void>;
  signalGroup(signal: NodeJS.Signals): void;
  groupExists(): boolean;
  rootExists(): boolean;
  closeOutput(): void;
  dispose(): void;
}
export type BackendFactory = (spec: SpawnSpec, callbacks: BackendCallbacks) => ProcessHandle;

// node-pty 1.1.0 的公开 onExit 延后到 socket close，并可能在 200ms 后主动 destroy。
// 仅在此适配器封装、校验固定版本的 Unix socket/fd：检测主动排空截断；
// 使用 fs.write callback 保持本服务输入队列有界，不叠加 SDK 不可观测的无限写队列。
// 不修改依赖、不访问进程身份数据库，也不跨 Worker 共享 PTY。
interface UnixPty extends pty.IPty {
  _socket: ReadStream;
  fd: number;
}
export const spawnPty: BackendFactory = (spec, callbacks) => {
  const terminal = pty.spawn(spec.file, spec.args, {
    cwd: spec.cwd, env: spec.env, cols: spec.cols, rows: spec.rows,
    name: spec.env.TERM ?? 'xterm-256color', encoding: null,
  }) as UnixPty;
  const socket = terminal._socket;
  if (!socket || typeof terminal.fd !== 'number' || typeof socket.destroy !== 'function') {
    terminal.kill('SIGKILL');
    throw new Error('node-pty Unix socket/fd 适配不兼容；必须重新验证固定依赖版本。');
  }
  let ended = false, incomplete = false, disposed = false;
  let closedReported = false;
  const close = () => {
    if (!closedReported) { closedReported = true; callbacks.closed(!incomplete); }
  };
  const originalDestroy = socket.destroy;
  socket.destroy = function (error?: Error) {
    if (!ended && !error && !socket.destroyed) incomplete = true;
    return originalDestroy.call(this, error);
  };
  const onEnd = () => { ended = true; };
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code === 'EAGAIN') return;
    if (error.code === 'EIO') { ended = true; return; } // Unix PTY 的正常关闭
    incomplete = true; callbacks.error(error);
  };
  socket.on('end', onEnd);
  socket.on('error', onError);
  socket.on('close', close);
  const dataSubscription = terminal.onData(data => {
    const raw = data as unknown;
    if (!closedReported && !disposed) callbacks.data(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
  });
  const exitSubscription = terminal.onExit(event => {
    const sig = event.signal && event.signal > 0
      ? Object.entries(osConstants.signals).find(([, n]) => n === event.signal)?.[0] ?? `SIGNAL_${event.signal}` : null;
    callbacks.exit(sig ? null : event.exitCode, sig);
    // 固定 SDK 的 onExit 只在 socket 关闭后发出；先前的 close 已给出采集完整性。
    close();
  });
  const handle: ProcessHandle = {
    pid: terminal.pid, pgid: terminal.pid,
    async send(data, signal) {
      let offset = 0;
      while (offset < data.byteLength) {
        signal?.throwIfAborted();
        if (disposed || closedReported) throw new Error('PTY 输出/输入句柄已经关闭。');
        const written = await new Promise<number>((resolve, reject) => {
          fsWrite(terminal.fd, data, offset, data.byteLength - offset, null,
            (error, n) => error ? reject(error) : resolve(n));
        }).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EAGAIN' && error.code !== 'EINTR') throw error;
          await new Promise(resolve => setTimeout(resolve, 5)); return 0;
        });
        offset += written;
      }
    },
    signalGroup(signal) { process.kill(-terminal.pid, signal); },
    groupExists() {
      try { process.kill(-terminal.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    },
    rootExists() {
      try { process.kill(terminal.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    },
    closeOutput() { incomplete = true; socket.destroy(); close(); },
    dispose() {
      if (disposed) return; disposed = true;
      dataSubscription.dispose(); exitSubscription.dispose();
      socket.off('end', onEnd); socket.off('error', onError); socket.off('close', close);
      socket.destroy = originalDestroy;
    },
  };
  return handle;
};
