/*
 * Plain JS passed to Worker({ eval: true }); no TypeScript loader in dist.
 */
export const regexWorkerSource = String.raw`
'use strict';
import { parentPort } from 'node:worker_threads';

function findMatch(pattern, flags, text) {
  // 本调用此前若已有真命中，调用就已返回；没有需要跳过的“消费过的命中”。
  // 必须重新检查 suffix+fresh 整个连续视图：a(?=b) 等结果的 end 可能
  // 仍在 suffix 中，但只有新 b 到达后才成立。不能以 end>freshStart 过滤。
  const expression = new RegExp(pattern, flags);
  const match = expression.exec(text);
  if (match === null) return null;
  return { start: match.index, end: match.index + match[0].length, text: match[0] };
}

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (message) => {
  if (!message || message.type !== 'evaluate') return;
  try {
    const match = findMatch(message.pattern, message.flags, message.text);
    parentPort.postMessage({ type: 'result', id: message.id, match });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      code: error instanceof SyntaxError ? 'INVALID_PATTERN' : 'WORKER_ERROR',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
`;
