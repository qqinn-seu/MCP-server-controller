# MCP-server-controller

有状态 PTY 终端控制器。当前交付 **阶段 ①：会话内核，不接 MCP**。Linux 当前沙箱直接开发并全量测试，不使用 Docker；macOS 由用户在本机执行 `npm test` 和下列手动场景，作为每阶段人工验收。**Linux 通过不代表 macOS 已通过，阶段 ②须等待用户确认阶段 ①人工验收。**

规格见 [docs/V1-SPEC.md](docs/V1-SPEC.md)，验收映射及完整用例清单见 [docs/PHASE-1-REPORT.md](docs/PHASE-1-REPORT.md)，被移出的旧要求仅在 [docs/ARCHIVE.md](docs/ARCHIVE.md) 保存，不得据此扩大当前范围。

## 技术栈与环境

固定依赖：TypeScript **7.0.2**、官方 `@modelcontextprotocol/sdk` **1.32.2**、`node-pty` **1.1.0**、vitest **5.0.5**。SDK 目前仅锁定依赖，核心代码不导入 SDK，也没有 MCP 工具注册、stdio/HTTP 服务器或审批 CLI。`package-lock.json` 为实际安装生成的锁文件。

已验证环境：Linux ARM64、Node.js **22.13.0**、npm **10.9.2**、普通用户 `ubuntu`（UID 1000）。`.nvmrc` 固定复现 Node 版本。Vitest 5 需要 Node `^22.12.0 || ^24.0.0 || >=26.0.0`；不要仅凭 Node 版本数大于 22 就使用不受支持的奇数版本。

测试必须以非 root 用户运行。当前沙箱支持普通用户，**没有增加 root 绕过开关**；内核构造和演示默认拒绝 root。`assertRuntimeUser(0)` 用例仅模拟 root 判断，不实际提权。若未来环境确实只能用 root，应另行增加明确、只供测试且默认关闭的入口，不得复用生产配置或默认放开 root。

`node-pty` 需要原生构建工具。Linux 准备 Python 3、make、C/C++ 编译器及可用 `/dev/ptmx`/devpts；macOS 准备 Xcode Command Line Tools 与 Python 3。请不要以 `sudo npm test` 或 `sudo npm ci` 绕过安装问题。

## 安装、构建、测试（Linux 沙箱与 macOS 同样命令）

```bash
# 有 nvm 时：使用本仓库 .nvmrc 指定的 Node 版本
nvm install
nvm use

id -u                      # 应为非 0
node --version
python3 --version
npm ci
npm run build
npm test                   # pretest 自动再次构建，不会省略宿主退出测试
npm run test:report         # 包含构建，生成 docs/evidence/vitest-results.json
```

没有 nvm 时直接使用已安装的 Node 22.13.0 或符合上述 engines 的版本，不要求安装第二套 Node。macOS 若缺少编译工具，在用户本机执行 `xcode-select --install` 并完成系统提示后重试；若缺少 Python 3，可使用用户已有的 Homebrew/Python 安装。默认显式基础 PATH 包含 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`，不完整继承宿主环境。

测试使用 Vitest `forks`、单测试文件并行度，PTY 实例不跨 worker thread 共享；正则的计算 Worker 只接收模式和文本。

## 用户 macOS 人工验收：阶段 ①

从指定开发分支检出后运行：

```bash
git clone --branch phase-1/session-kernel https://github.com/qqinn-seu/MCP-server-controller.git
cd MCP-server-controller
# 若已经克隆：git fetch origin && git switch --track origin/phase-1/session-kernel

# 使用已安装兼容 Node，或执行 nvm install && nvm use
npm ci
npm test
npm run demo
npm run evidence:ps
```

`npm run demo` 是纯内核演示，不是 Server/审批 CLI。它按顺序展示：同一 Python REPL 保留 `values` 并算出 `RESULT: 10`；无换行 `Name?` 提示与同进程向导 `ANSWER:Ada:42`；长任务快速返回同一 `session_id` 并分页读到最后错误及退出码 7；Ctrl-C 中断前台程序；正常关闭后会话列表为空。输出以 JSON 安全转义展示，不把进程 OSC 等控制序列直接打印为终端指令。Linux 真实 Shell 的 Ctrl-C/作业控制由自动化用例 `CTRL-SHELL` 验证，macOS 运行同一 `npm test`。

`npm run evidence:ps` 打印终止前后 `ps -axo pid,ppid,pgid,stat,command` 的真实快照，并写入 `docs/evidence/process-cleanup.txt`。请手动确认：终止前存在本次记录的根进程和组内子进程；终止后 `(no rows)`，`REMAINING_TRACKED_ROWS=0 TRACKED_ZOMBIES=0`。脚本只检验本次 fixture PID/受管 PGID，不承诺清理逃逸后代。

如需逐组定位差异：

```bash
npm test -- tests/integration/pty.test.ts
npm test -- tests/integration/lifecycle.test.ts tests/integration/host.test.ts
npm test -- tests/unit/output-ring.test.ts tests/unit/wait-matcher.test.ts
```

请回传：`uname -a`、`node --version`、`npm --version`、`python3 --version`、`id -u`、`npm test` 结果、演示观察和 `process-cleanup.txt`。未经用户本机执行的结果，报告始终标记为“macOS 人工验收待完成”。

## 核心 API（无 MCP）

```ts
import { SessionManager, resultOf } from './dist/index.js';

const manager = new SessionManager({ config: { workspace_root: process.cwd() } });
try {
  const created = await manager.create({ argv: ['/bin/sh', '-c', 'printf ready; sleep 1'] });
  const matched = await manager.waitFor({
    session_id: created.session_id,
    cursor: created.initial_cursor,
    pattern: { type: 'literal', value: 'ready' },
    timeout_ms: 1000,
  });
  const page = await manager.read({ session_id: created.session_id, cursor: created.initial_cursor });
  const status = manager.status({ session_id: created.session_id });
  const list = manager.list({});
  // 预期错误转换为规格中的 Success/Failure；内部方法返回 data 并抛 CoreError。
  const result = await resultOf(() => manager.terminate({ session_id: created.session_id }));
} finally {
  await manager.close();
}
```

八个内部方法是 `create/read/write/status/list/terminate/waitFor/run`，命名对应规格的八工具；未来由阶段 ②适配为 MCP。`write` 不隐式换行，返回 `queued` 只说明输入整体进入有界队列，不证明应用已读取。AbortSignal 可以取消 `read/waitFor/run` 的等待，不杀已启动进程。宿主可显式安装 `installShutdownHooks(manager)` 处理 SIGTERM/SIGINT；stdio EOF 接线属于阶段 ②。

## 已实现与未实现

已实现：PTY 创建与持续采集、五态会话生命周期、每会话环形原始字节缓冲、不透明签名游标、UTF-8 稳定展示及输出分页、literal/普通 RegExp 跨块等待、串行有界输入队列、Ctrl-C、受管组 TERM→KILL、root exit/输出关闭分离、drain、runtime/idle/记录 TTL、并发/等待者上限、内核正常关闭和空新代际。

本阶段**不做**：MCP 适配/Schema 注册/stdio/HTTP/token、工作目录策略白名单、可配置环境允许/拒绝策略、命令规则、审批/terminalctl、磁盘审计。核心仅对启动目录做真实路径解析；环境只从显式基础值构造，调用者覆盖暂受结构/大小校验而非完整阶段③策略。当前只能在可信本地环境使用，不是可对公网开放的完整 Server。

V1 始终不做：Pipe、Windows、多用户、强 OS 沙箱、逃逸后代强清理、重启恢复或旧进程身份核验、持久审批/独立口令、跨崩溃恰好一次、lost、全局输出配额/淘汰、列表分页、跨 timeout 匹配上下文、TUI 屏幕模拟/resize 等。用户态会话只是终端转录，不是文件系统隔离；工作目录与 HOME 文件仍遵循当前 OS 用户权限。

## 输出、匹配与退出的明确限制

- 每会话环形缓冲有界，旧 cursor 过期返回 `CURSOR_EXPIRED + earliest_cursor`。wait/run 使用既有 `output_gap/gap` 表达同一淘汰事实；不会自动假装日志完整。默认记录数 × 每会话 8 MiB 的理论载荷上限为 2 GiB，需按主机内存调低配置；无全局自动淘汰。
- `output_complete` 总是 boolean。采集中为 false；只有 `output_closed=true` 后才代表最终完整性；历史被覆盖与采集截断是不同事实。
- 正则最多 1024 UTF-8 字节，i/s 标志，普通 JS 语法包括锚点/环视。编译与执行隔离于可终止 Worker；默认一次求值 50 ms、单调用主动计算 250 ms，Worker 启动不计求值预算。超限返回安全扫描前沿，不终止会话。
- 匹配只保证同一次调用内跨块、最多 64 KiB 原始跨度；内部按 64 KiB 片段加后缀检查。续等直接从 `scanned_cursor` 重新开始，可能漏掉跨两次 timeout 的模式；不保存隐藏上下文。锚点针对已观察窗口而非最终 EOF，零宽匹配重复同一游标可能再次命中。
- node-pty 1.1.0 的公开 onExit 与 Unix socket close 有耦合，且其内部约 200 ms 保护可能先截断输出。适配器只在 `src/core/pty-backend.ts` 校验并封装固定版本的 `_socket`/`fd`，捕获正常 EIO 与主动关闭，主动截断记 `output_complete=false`；不会冒充自然 EOF。核心独立 root exit/drain 边界用受控后端验证，真实 PTY 集成验证实际 OS 行为。升级 node-pty 必须重新验收，不保证任意版本的内部接口兼容。
- 本服务以 `fs.write` 回调和自己的输入队列处理 PTY 输入，不叠加 SDK 内部不可观测的无界写队列；在途数据计入容量。异步发送失败用内存事件关联 `write_id`，不把 queued 改成已消费。
- 正常 close/SIGTERM/SIGINT 清理当前受管组并等待可回收根进程；SIGKILL/崩溃可能留下进程。新实例不扫描/认领/核验/自动杀旧 PID。崩溃用例由 harness 对自己记录的 fixture PID 人工收尾，这不是 Server 的恢复功能。

## 独立审查修复回归

立即终止不能把尚未建立的进程组当成已清空：核心先等待当前受管根的 PGID 就绪，超限报 unverified，最终根或组仍存活时报 partial，不返回 group_cleared。`rootExists` 只针对当前实例已登记的 PID 做 signal 0 探测，不读取身份元数据或恢复旧会话。`IMMEDIATE-TERMINATE` 在真实 PTY 上重复 256 次 create→terminate(grace_ms:0)，逐次验证根与组均消失；`GROUP-READY-RACE` 确定性模拟组建立滞后。

普通正则在 suffix+fresh 的完整视图重新检查首个候选，不按返回文本 end 是否在 fresh 中过滤；因此跨 64 KiB 才成立的 a(?=b)、零宽 (?=ab) 以及等待新 b 的环视均可命中。全量测试包含这些回归；按当前版 test:report 共 63 项。
