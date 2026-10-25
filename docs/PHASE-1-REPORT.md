# 阶段 ①：会话内核交付与验收报告

日期：2026-10-25。范围：[V1 规格 15.1](V1-SPEC.md)，纯会话内核，不接 MCP。状态：**Linux 当前沙箱实现与全量自动化验证已通过；macOS 首轮验收未通过；helper 安装补丁已提供，等待用户重验。没有进入阶段 ②。**

## 1. 本轮规格小修订

测试平台改为 Linux 当前沙箱主开发与全量测试，直接运行、不使用 Docker；macOS 用户在本机按 README 执行 npm test 与手动场景，作为每阶段人工验收。当前 UID=1000，非 root，可直接运行，未增加 root 绕过开关；生产/内核默认拒绝 root。

原第 17.2 节已原文移到 [ARCHIVE.md](ARCHIVE.md)，主规格末尾仅保留 17.1 候选/限制表格。所有旧恢复、Pipe、持久审批或限速等归档能力均未实现。

## 2. 实际交付

- TypeScript 核心、固定 node-pty 后端，八个工具对应的内部方法与共享会话状态。
- 每会话原始字节环、签名游标、UTF-8 稳定文本/分页、输出过期与既有 gap 表达。
- 全量原子接受、串行有界输入队列（含在途计费），不隐式换行、Ctrl-C。
- 历史优先、无丢失订阅衔接、literal/普通 RegExp 跨块等待、可终止正则 Worker、计算预算与游标前沿。
- TERM→KILL、可等待根进程回收、root exit/output close 分离、drain、runtime/idle/记录 TTL、配额与正常宿主关闭。
- 自动化 fixture、演示与 ps 证据脚本、锁文件、README/macOS 验收命令。

未交付且不伪装已交付：MCP 适配/Schema 注册/stdio/HTTP/token、cwd 策略白名单、阶段③环境/命令策略、审批 CLI、磁盘审计。SDK 仅作为固定依赖，不被内核导入。内存 onEvent 是事实观察钩子，不是后续磁盘审计。

## 3. 实测环境与运行结果

| 项目 | 实际结果 |
| --- | --- |
| OS/架构 | Linux-6.18.38+-aarch64-with-glibc2.39 / aarch64 |
| 运行用户 | ubuntu / UID 1000 |
| Node.js / npm | v22.13.0 / 10.9.2 |
| Python | 3.12.3 |
| TypeScript / vitest | 7.0.2 / 5.0.5 |
| node-pty / 官方 MCP SDK | 1.1.0 / 1.32.2 |
| Docker | 未使用 |
| npm run build | 通过 |
| 全量 test:report | **8 个测试文件，68/68 通过；0 失败、0 跳过** |
| npm run demo | 通过：REPL、向导、同会话后台续读、非零退出、Ctrl-C、正常关闭 |
| npm run evidence:ps | 通过：本次受管 PID/PGID 终止后 0 残留、0 僵尸 |
| macOS | 用户本机人工验收待完成，不以 Linux 替代 |

运行命令：`npm run test:report`（包含 build）；原始机器可读结果：[vitest-results.json](evidence/vitest-results.json)。另有早先版本连续三轮 56/56 回归通过；最终追加 read 半个 UTF-8 及跨会话 Worker 用例后，上表以安装准备补丁后的 68 用例报告为准，不把不同版本结果混为最终证据。

## 4. 15.1 每条验收标准的用例映射

| 15.1 条目 | 对应自动化用例 | 验证结论与边界 |
| --- | --- | --- |
| ① 直接调用内核完整闭环；REPL/向导状态保持、无换行输出可见 | pty.test.ts：TTY-CONTROL、REPL-STATE、WIZARD-NO-LF、WAIT-SGR-SPLIT；lifecycle.test.ts 基础状态读取 | 真实 PTY stdin/stdout 为终端；同一变量与向导会话；输入不隐式换行。不是 MCP 场景演示 |
| ② run 共用会话；等待到期不重启/不杀；非零退出为正常结果 | pty.test.ts：RUN-SAME-NONZERO、RUN-PAGE；lifecycle.test.ts：lets run reuse its newly registered session and complete with a non-zero exit | 仅创建一个 session；background 后可继续读取到退出码 7/最后错误；resultOf 成功读取非零程序结果 |
| ③ 双读者、拆页、UTF-8、每会话环形覆盖、过期/缺口 | output-ring.test.ts 全部7项；pty.test.ts：TWO-READERS、RUN-PAGE、RING-GAPS；lifecycle.test.ts：READ-PARTIAL-UTF8 | 同游标非消费；大事件继续推进；非法 UTF-8 固定替换，半码点等补全；覆盖不影响其他 ring；read 报 CURSOR_EXPIRED，wait/run 保留既有 gap 契约 |
| ④ 先历史后新增、调用内跨块、游标续等、普通正则与预算隔离 | wait-matcher.test.ts 全部16项；pty.test.ts：WAIT-SGR-SPLIT；lifecycle.test.ts：WORKER-OTHER-SESSION | 含64KiB片段边界、SGR跨块、REGEX-LOOKAHEAD-64K/NEW（跨内部片段与新增输出的正向/零宽环视）、now排除历史、扫描期间追加/最终关闭竞态、直接游标续等、锚点/环视/零宽、超限安全前沿、Abort释放 Worker；不重建跨 timeout 上下文 |
| ⑤ write/terminate、Ctrl-C、TERM→KILL、exit/EOF、drain、时限和配额，boolean完整性 | input-queue.test.ts 全部4项；lifecycle.test.ts：root exit/output closure、drain cutoff/collector errors、quota/TTL/runtime/idle/waiter/Abort/concurrent termination；pty.test.ts：TERM-KILL-REAP、IMMEDIATE-TERMINATE（256次真实立即终止）、GROUP-READY-RACE、CTRL-C、CTRL-SHELL、GROUP-CLEAN | 真实OS信号与回收 + 可控后端独立安排root exit/EOF。collector故障与日志覆盖不混为完整采集；所有 output_complete 为 boolean |
| ⑥ 正常关闭全部组、回收可等待子进程、新实例空/不恢复，崩溃由harness处理 | pty.test.ts：CLOSE-ALL、GROUP-CLEAN；lifecycle.test.ts：closes all known process groups...；host.test.ts：HOST-SIGTERM、HOST-CRASH；process-evidence.mjs | 真正清理受管fixture，不只是清空Map；崩溃残留由 harness 针对其自己的 PID 收尾，新内核不扫描或误杀旧实体 |

注意：stock node-pty 的公开 onExit 与 socket close 耦合；固定后端封装捕获内部主动截断并标不完整。核心“先 root exit，后 EOF/drain”的确定时序使用 FakeBackend 验证，真实 PTY 集成另行验证实际 OS 状态。没有声称两平台的 SDK 回调顺序完全一致。

## 5. ps 终止与僵尸证据

真实原始证据：[process-cleanup.txt](evidence/process-cleanup.txt)。脚本执行 `ps -axo pid,ppid,pgid,stat,command`，按本次fixture报告的 PID 和受管 PGID 过滤。终止前包含两根进程以及同组子进程；终止后：

```text
AFTER_TERMINATE
(no rows)
REMAINING_TRACKED_ROWS=0 TRACKED_ZOMBIES=0
```

这只证明本轮受管fixture无残留/僵尸，不承诺所有OS进程都不存在、强清理逃逸后代或跨崩溃自动恢复。最终全量测试后的附加 ps 检查也未发现 fixture 或僵尸行。

## 6. macOS 用户人工验收命令

```bash
git clone --branch phase-1/session-kernel https://github.com/qqinn-seu/MCP-server-controller.git
cd MCP-server-controller
# nvm用户可执行 nvm install && nvm use；否则使用兼容的现有Node
id -u                 # 必须非0
python3 --version
npm ci
npm test
npm run demo
npm run evidence:ps
```

手动确认演示显示 RESULT: 10、ANSWER:Ada:42、长任务同一session后台续读与最终非零码、Ctrl-C/关闭正确，以及 ps 终止后0行/0僵尸。回传 OS/Node/npm/Python/UID、测试输出、演示观察与 process-cleanup.txt；macOS 通过前不宣称该人工门禁完成。缺编译器时在用户本机执行 xcode-select --install，不能用 sudo npm test 绕过。

## 7. 全部自动化用例清单（最终报告）

### tests/integration/host.test.ts（2 项）

- [passed] 真实内核宿主的退出边界 HOST-SIGTERM：显式正常退出钩子清理受管根进程
- [passed] 真实内核宿主的退出边界 HOST-CRASH：崩溃可有残留，新实例为空且不碰旧进程，harness 人工收尾

### tests/integration/lifecycle.test.ts（14 项）

- [passed] SessionManager lifecycle with a controllable backend keeps root exit and output closure as separate observable facts
- [passed] SessionManager lifecycle with a controllable backend marks drain cutoff as incomplete and reports collector errors as log gaps
- [passed] SessionManager lifecycle with a controllable backend enforces live and retained-record quotas independently
- [passed] SessionManager lifecycle with a controllable backend deletes completed records after TTL based on real elapsed time
- [passed] SessionManager lifecycle with a controllable backend applies runtime timeout and distinguishes idle activity from output and list calls
- [passed] SessionManager lifecycle with a controllable backend releases waiter capacity when an AbortSignal cancels a pending read
- [passed] SessionManager lifecycle with a controllable backend drops a queued write during concurrent termination and starts only one cleanup task
- [passed] SessionManager lifecycle with a controllable backend lets run reuse its newly registered session and complete with a non-zero exit
- [passed] SessionManager lifecycle with a controllable backend wraps backend spawn failures as SPAWN_FAILED with a diagnosable session record
- [passed] SessionManager lifecycle with a controllable backend closes all known process groups, clears records, and starts a new empty epoch
- [passed] SessionManager decoded-output and Worker boundaries READ-PARTIAL-UTF8：只有半个码点时等待新增，补全后返回稳定字符
- [passed] SessionManager decoded-output and Worker boundaries WORKER-OTHER-SESSION：灾难性回溯不阻塞其他会话 read/status
- [passed] forkpty 组就绪回归 GROUP-READY-RACE：组暂不可见但根存活时保持 pending，建立后执行信号
- [passed] GROUP-READY-UNVERIFIED：根存在且组持续不可见时明确不假报已清空

### tests/integration/pty.test.ts（16 项）

- [passed] 真实 PTY：15.1 Linux 全量验收 TTY-CONTROL：stdin/stdout 是终端且受管 PGID 与 SID 相同
- [passed] 真实 PTY：15.1 Linux 全量验收 REPL-STATE：同一个 Python REPL 保留变量与后续输入
- [passed] 真实 PTY：15.1 Linux 全量验收 WIZARD-NO-LF：无换行提示可读，write 不隐式换行
- [passed] 真实 PTY：15.1 Linux 全量验收 WAIT-SGR-SPLIT：调用内跨块去颜色并匹配，原日志保留 SGR
- [passed] 真实 PTY：15.1 Linux 全量验收 RUN-SAME-NONZERO：超时 background 的同一会话继续运行且非零退出不报工具失败
- [passed] 真实 PTY：15.1 Linux 全量验收 RUN-PAGE：run 只返回预算内一页，next_cursor 可续读完整超长输出
- [passed] 真实 PTY：15.1 Linux 全量验收 TWO-READERS：同游标重读不消费且会话输出不串流
- [passed] 真实 PTY：15.1 Linux 全量验收 RING-GAPS：旧 read 报过期、wait 报缺口、run 首页保留缺口事实
- [passed] 真实 PTY：15.1 Linux 全量验收 READ-TIMEOUT：无新增的 read 返回正常空页并保留 cursor
- [passed] 真实 PTY：15.1 Linux 全量验收 TERM-KILL-REAP：忽略 TERM 的根进程被 KILL，重复终止不新建任务且 PID 已回收
- [passed] 真实 PTY：15.1 Linux 全量验收 CTRL-C：控制字符作用于前台程序，不等于 terminate
- [passed] 真实 PTY：15.1 Linux 全量验收 CTRL-SHELL：Ctrl-C 结束前台 sleep 后，根 Shell 仍能继续交互
- [passed] 真实 PTY：15.1 Linux 全量验收 GROUP-CLEAN：组内子进程终止，fixture 父进程 wait 回收子进程
- [passed] 真实 PTY：15.1 Linux 全量验收 CLOSE-ALL：正常 close 清理全部受管会话，不恢复新实例旧会话
- [passed] 真实 PTY：15.1 Linux 全量验收 SCHEMA-CORE：基础互斥与边界、Pipe、列表分页均拒绝
- [passed] 真实 forkpty 初始竞态压力回归 IMMEDIATE-TERMINATE：256次 create 后零宽限终止，不能误报存活根已清空

### tests/unit/config.test.ts（4 项）

- [passed] core configuration provides explicit safe defaults rather than copying the full process environment
- [passed] core configuration merges a valid partial configuration without mutating defaults
- [passed] core configuration throws CoreError for non-positive numeric limits and inconsistent limit pairs
- [passed] core configuration keeps expected core failures throwable and resultOf-encapsulable

### tests/unit/input-queue.test.ts（4 项）

- [passed] InputQueue rejects a full write in its entirety without adding it to the queue
- [passed] InputQueue delivers queued entries strictly serially
- [passed] InputQueue counts an in-flight write against capacity until delivery settles
- [passed] InputQueue aborts the in-flight delivery and drops pending entries on stop

### tests/unit/output-ring.test.ts（7 项）

- [passed] OutputRing keeps a split UTF-8 code point pending, then paginates without breaking it
- [passed] OutputRing uses replacement text for invalid input and flushes an EOF UTF-8 remainder
- [passed] OutputRing allows an empty read cursor to be reused and advance after data arrives
- [passed] OutputRing does not consume output: two readers can reread the same page
- [passed] OutputRing rejects forged, cross-session, cross-epoch, and future cursors
- [passed] OutputRing evicts only its own oldest raw bytes and reports an explicit recovery cursor
- [passed] OutputRing splits a large event across pages and preserves SGR bytes verbatim

### tests/unit/wait-matcher.test.ts（16 项）

- [passed] waitFor scans history including a prompt without newline
- [passed] waitFor strips an SGR sequence split over append blocks
- [passed] waitFor finds a literal crossing an internal 64 KiB scan boundary
- [passed] waitFor start now excludes pre-existing text and observes appended text
- [passed] waitFor reports output_gap when beginning has been evicted
- [passed] waitFor does not restore cross-call context after timeout
- [passed] waitFor allows anchors, lookaround and zero-width ordinary JS regexes
- [passed] waitFor rejects invalid regex syntax and flags as INVALID_PATTERN
- [passed] waitFor returns a safe frontier on regular-expression budget exhaustion without blocking another ring
- [passed] waitFor cancels an active worker and rejects with AbortError
- [passed] waitFor refined boundaries EMPTY-ZERO：空历史也以普通正则匹配零宽 ^$
- [passed] waitFor refined boundaries PATTERN-BOUNDARY：拒绝超长、非字符串标志与未知模式字段
- [passed] waitFor refined boundaries HISTORY-APPEND：在历史扫描让出时追加的输出仍能被检查
- [passed] waitFor refined boundaries WAIT-EXIT：输出关闭前不返回 exited，最后输出仍可匹配
- [passed] 跨片段普通环视回归 REGEX-LOOKAHEAD-64K：返回文本在旧片段但依赖下一片段才能成立
- [passed] 跨片段普通环视回归 REGEX-LOOKAHEAD-NEW：历史 a 在新 b 到来后成立，零宽环视也不被过滤

### tests/unit/prepare-pty.test.ts（5 项）

- [passed] PTY 安装准备：只修复 macOS helper 执行位 PREPARE-LINUX：Linux 完全不更改文件权限
- [passed] PTY 安装准备：只修复 macOS helper 执行位 PREPARE-DARWIN：644 只增加 owner execute 为744，不拓宽其他权限
- [passed] PTY 安装准备：只修复 macOS helper 执行位 PREPARE-IDEMPOTENT：重复运行不改变已正确设置的模式
- [passed] PTY 安装准备：只修复 macOS helper 执行位 PREPARE-ARCH：只处理实际 Node 架构候选，不修改其他架构
- [passed] PTY 安装准备：只修复 macOS helper 执行位 PREPARE-FAIL-CLEAR：版本变化、缺失和非普通文件明确失败

安装准备补丁针对 node-pty@1.1.0 发布包的 Darwin helper 执行位，不改变工具契约；macOS 首轮 46/63 通过、17 次相同启动错误，需依照 [重验说明](MACOS-PTY-TROUBLESHOOTING.md) 重新测试，不能签为通过。

## 8. GitHub 交付范围

目标仓库：qqinn-seu/MCP-server-controller；使用独立 `phase-1/session-kernel` 分支，不覆盖 main。最终提交哈希与远端链接在任务交付消息中列出。仓库公开，仅提交源码、fixture、规格与本轮测试证据，不提交凭证、node_modules、dist 或本地临时数据。
