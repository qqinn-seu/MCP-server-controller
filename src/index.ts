export { SessionManager } from './core/session-manager.js';
export type { ManagerOptions, CoreEvent } from './core/session-manager.js';
export { CoreError, resultOf } from './contracts/errors.js';
export { defaultConfig, assertRuntimeUser } from './core/config.js';
export type { CoreConfig } from './core/config.js';
export type * from './contracts/types.js';
export { installShutdownHooks } from './core/lifecycle.js';
