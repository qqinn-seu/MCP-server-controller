import type { SessionManager } from './session-manager.js';

// 由宿主显式安装；构造 manager 不污染全局信号监听。stdio EOF 对接在阶段②。
export function installShutdownHooks(manager: SessionManager,
  afterClose: () => void | Promise<void> = () => { process.exitCode = 0; }): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void manager.close().then(afterClose).catch(error => {
      console.error('终端内核关闭失败：', String(error)); process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); };
}
