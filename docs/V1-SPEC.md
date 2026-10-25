# MCP Server 终端控制器 V1 开发规格书

本项目交付一个有状态的终端控制 MCP Server。客户端或 Agent 可以启动进程、连续读取输出、向原进程写入输入、等待特定输出、查询状态，并终止受管会话。创建或读取工具返回之后，进程仍可独立运行。

**本文件是 V1 的独立开发依据，替代《任务详细解读》和《V1 范围与接口补充》。开发与验收只需阅读本文件，不再需要回查两份旧文档。** 本规格统一了此前示例中的字段差异；实现以本文件的契约为准。

版本：1.2（Linux 主开发平台与外置归档）

日期：2026-10-25

作者：Manus AI

交付形式：可运行 Server、配套本地审批 CLI、配置与启动说明、自动化测试、真实 MCP 客户端演示。

本次修订保留八个工具、应用层成功/失败封装、游标读取、会话与进程组清理的总体契约；仅按本文件明确列出的收敛项调整字段、默认值和语义。文末第 17 章列出后续版本与已知限制，原条款归档至 [docs/ARCHIVE.md](ARCHIVE.md)，**不属于 V1 验收范围，不得据此扩大实现范围**。

文中的“必须”和“不得”是 V1 验收要求。“建议”允许采用等价实现。参数默认值与数值限制是本项目的基线，不是 MCP 官方规定。协议依据采用 MCP 2025-11-25 版；客户端连接时仍应按 SDK 支持的版本完成协商。[1] [2]

## 1. 项目范围与不做的内容

### 1.1 必须交付

V1 固定提供八个 MCP Tools：

1. `terminal_create`：创建并启动持续会话。
2. `terminal_read`：按游标读取增量输出。
3. `terminal_write`：给现有会话写入文本或 Ctrl-C。
4. `terminal_status`：查询事实状态与日志范围。
5. `terminal_list`：列出会话摘要。
6. `terminal_terminate`：终止受管进程组。
7. `terminal_wait_for`：等待输出满足字面量或普通正则条件。
8. `terminal_run`：启动一次命令，限时同步等待，未完成则返回同一会话。

支持 macOS 和 Linux，V1 **只实现 PTY 模式**。支持多会话同时运行、每会话有界环形输出缓冲区、退出结果、尾部输出排空和正常退出清理。Linux（当前沙箱）是主开发与全量测试平台，直接运行、不使用 Docker；macOS 由用户在本机按 README 执行 npm test 并手动验证阶段场景，作为每阶段人工验收项。Pipe 延后。

实现 stdio 与 Streamable HTTP 两种 MCP 传输。本地审批采用 `terminalctl` CLI，不依赖 MCP 客户端弹窗。

HTTP 使用一个 MCP token。所有已认证请求属于同一个所有者，不存在多用户角色或会话委托。stdio 由可信本地客户端启动，启动权限作为信任基础，不把 token 加入工具参数。

### 1.2 明确不做

不实现 Windows、多用户权限体系、写租约、通用创建幂等键、输入去重、跨崩溃恰好一次执行、活跃终端跨重启恢复、MCP Tasks、资源订阅或推送依赖。

不实现 cgroup、容器或其他强执行沙箱。不承诺清除脱离受管进程组的后代，不承诺隔离同一 OS 用户能够读取的所有文件。

不实现完整终端屏幕模拟、TUI 自动操作、动态 resize、独立 close 工具、向持久 Shell 执行单条命令后可靠划分其输出与退出码。

不实现审批网页。CLI 是 V1 唯一必交付的人类批准入口。V1 不实现独立审批口令、口令验证与失败认证限速，不持久化审批或会话元数据，不执行重启后的旧进程身份核验与自动清理，不实现列表分页、全局输出配额和全局输出淘汰。

### 1.3 产品与信任边界

“本地终端”指 Server 所在机器上的终端，不是客户端或用户浏览器所在机器。云端 Agent 接入 Server 后，执行位置仍是 Server 主机。

本项目定位为可信单用户的开发终端服务与防误操作护栏，不是面向恶意代码的强沙箱。PTY 库启动的进程通常拥有父进程的执行权限；审批和命令规则不能改变这一事实。[3]

“支持 MCP 客户端接入”以传输、版本、能力与网络可达性相匹配为前提，不声称所有客户端无需配置就能连接。[2] [4]

## 2. 总体结构与职责

建议采用如下结构，各层可位于同一个 Server 进程中：

```text
MCP Client / Agent
       │ stdio / Streamable HTTP
       ▼
MCP Adapter：工具发现、Schema、结果与协议错误
       ▼
Policy / Approval：硬限制、allow/ask/deny、本地人类审批
       ▼
Session Manager：逻辑 ID、状态、输入串行化、时间限制
       ├─ Output Store：每会话环形缓冲、输出页、游标、过期
       ├─ Wait Matcher：历史扫描、调用内跨块匹配、游标续等
       └─ Process Backend：node-pty、信号、退出回收、drain
                          ▼
                       根进程
```

八个工具必须共用 Session Manager 和 Output Store。`terminal_run` 是会话能力的组合，不维护另一个同步执行系统。输出采集器独立于工具调用持续运行。

Agent 负责理解日志、决定下一步、总结测试结果。Server 负责记录事实、匹配明确模式、提供输入输出通道、执行策略与管理资源。Server 不负责判断任意程序“是否卡死”，也不自动理解业务接口是否健康。

### 2.1 锁定技术栈

实现语言固定为 **TypeScript**，运行于受支持的 Node.js LTS；MCP 使用官方 **`@modelcontextprotocol/sdk`**，PTY 后端使用 **`node-pty`**，自动化测试使用 **`vitest`**。提交依赖锁文件，并在 README 记录实际锁定的 Node.js、SDK、node-pty、vitest 版本；本次文档修订不猜测依赖最新版本。普通正则采用 JavaScript `RegExp`，耗时隔离见 5.8。

不得跨多个 worker thread 不安全地共享 node-pty 实例；匹配 Worker 只接收文本与模式，不接收 PTY 句柄。[3] Linux 沙箱全量测试与用户 macOS 每阶段人工验收均覆盖进程组、控制终端、信号和退出语义。测试以非 root 用户运行；若测试环境只能使用 root，必须显式启用仅测试可用的开关，生产默认仍拒绝 root。

### 2.2 项目目录结构

```text
terminal-controller/
├─ package.json                 # terminal-server / terminalctl 可执行入口
├─ package-lock.json            # 提交并锁定依赖
├─ tsconfig.json
├─ vitest.config.ts
├─ src/
│  ├─ bin/
│  │  ├─ terminal-server.ts
│  │  └─ terminalctl.ts
│  ├─ contracts/                # 八个工具类型、输入/输出 Schema、错误码
│  ├─ core/
│  │  ├─ session-manager.ts
│  │  ├─ pty-backend.ts
│  │  ├─ output-ring.ts
│  │  ├─ cursor.ts
│  │  ├─ input-queue.ts
│  │  └─ lifecycle.ts           # 时限、终止、drain、正常退出清理
│  ├─ matching/
│  │  ├─ wait-matcher.ts
│  │  └─ regex-worker.ts
│  ├─ policy/                  # cwd、env、命令规则、规范化规格
│  ├─ approval/                # 内存状态与本地 socket 管理入口
│  ├─ mcp/                     # 工具适配、stdio、Streamable HTTP
│  ├─ audit/                   # 脱敏 JSONL 审计与轮转
│  └─ config/                  # 配置加载与校验
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  └─ fixtures/                # REPL、向导、长输出、信号、超时等
├─ config/example.json
├─ scripts/                    # 演示、进程清理证据与本机测试脚本
├─ docs/                       # 规格、使用说明、测试与演示记录
├─ README.md
└─ dist/                       # 构建产物，不手工维护
```

目录按职责拆分，不要求增加微服务、数据库或通用后端插件框架。核心层不依赖 MCP；stdio 与 HTTP 共用同一工具处理与会话内核。

## 3. MCP 通用契约

### 3.1 工具发现与结构化结果

Server 声明工具能力，使用标准 `tools/list`、`tools/call` 暴露八个工具。每个工具必须有准确描述、`inputSchema` 和 `outputSchema`。不要求客户端调用自定义 JSON-RPC 方法。[1]

输入 Schema 使用 JSON Schema，明确必填项、类型、边界与互斥条件。对象默认 `additionalProperties: false`；`env` 等显式键值映射除外。未知字段必须报错，不静默忽略。

工具结果统一采用以下应用层封装。它位于 MCP `structuredContent` 中，不替代 MCP 外层 `CallToolResult`：

```ts
type Success<T> = {
  ok: true;
  data: T;
};

type Failure = {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
};
```

成功的 MCP 结果使用 `isError: false`；可预期执行错误使用 `isError: true`。为兼容客户端，`content` 同时包含同一对象序列化后的 JSON 文本。声明的 `outputSchema` 必须覆盖成功与失败两种结构。[1]

本规格中的 TypeScript 类型同时是实现契约定义。开发时必须据此生成或编写等价 JSON Schema；本文给出的所有默认值、范围和条件约束也须落实到校验中。

### 3.2 协议错误与工具错误

未知工具、畸形 MCP 请求属于协议错误。目录不允许、会话已退出、审批未完成等属于工具执行错误。

程序退出码非零不是 MCP 调用失败。成功读取失败程序的日志，或者 `terminal_run` 成功等待一个退出码为 1 的程序，仍返回 `ok: true`，退出信息由数据字段表达。

读取等待超时、模式等待超时，以及 run 同步预算用尽均为正常结果。真正的 RPC 超时或响应丢失属于未知执行结果，不能伪造为成功后台返回。

### 3.3 ID、时间与认证

会话 ID、审批 ID和游标均为非空不透明字符串。ID 由 Server 使用安全随机机制生成，不得直接使用 PID。输入字符串长度上限：会话 ID、审批 ID为 256 字节，游标为 2048 字节。

每次启动生成新的 `server_epoch`。同一进程运行期内的 HTTP 重连不改变该代际；Server 重启改变代际。

外部时间使用 RFC 3339 UTC 字符串。运行、等待和空闲截止使用单调时钟，避免系统时间调整改变超时行为。

认证在 MCP 传输层完成，不在每个工具参数中重复传入 token。所有成功认证的连接共享同一所有者和会话集合。

## 4. 统一数据模型

### 4.1 会话与退出状态

```ts
type SessionStatus =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "spawn_failed";

type Mode = "pty";
type Stream = "pty";
type Cursor = string;

type TerminationReason =
  | "user_request"
  | "runtime_timeout"
  | "idle_timeout"
  | "server_shutdown"
  | null;

interface ExitInfo {
  exit_code: number | null;
  signal: string | null;
  termination_reason: TerminationReason;
}

interface OutputState {
  output_closed: boolean;
  output_complete: boolean;
  log_available: boolean;
  log_has_gaps: boolean;
}
```

`exited` 表示根进程退出已被确认，不保证输出已排空。非零退出码仍属于 `exited`。`spawn_failed` 表示启动阶段已确认失败。V1 没有 lost 状态；重启后旧会话不存在于新 Server 的会话集合。

正常退出时，`exit_code` 为非负退出码，`signal` 为 null；被信号结束时，`exit_code` 为 null，`signal` 使用如 `SIGINT`、`SIGTERM`、`SIGKILL` 的名称。不得把不同语言的负返回码或原始 wait 状态直接冒充统一退出码。

`output_complete` 始终是布尔值：采集尚未结束时为 false；自然读取至 EOF 并排空后为 true；读取错误、drain 超时或主动提前关闭时最终保持 false。只有 `output_closed: true` 时它才表达最终采集完整性；`output_closed: false` 且 `output_complete: false` 仅表示尚未完成。它不表示历史日志仍全部保留。

`log_has_gaps` 表示本会话曾出现历史淘汰或采集缺失，单调由 false 变 true，不因客户端读完而恢复。正常排空但淘汰过旧日志时，可以同时有 `output_complete: true` 和 `log_has_gaps: true`。

保留 `log_available` 字段：V1 当前内存中已注册且尚未删除的会话均为 true，空输出、spawn_failed、局部历史覆盖或采集错误不使它变为 false。覆盖由 CURSOR_EXPIRED/gap 表达，采集完整性由 output_closed/output_complete 表达。记录删除或重启后直接 SESSION_NOT_FOUND，不返回一个 log_available=false 的旧会话快照。

### 4.2 输出事件与输出页

```ts
interface OutputEvent {
  seq: number;
  stream: Stream;
  text: string;
  start_cursor: Cursor;
  end_cursor: Cursor;
}

interface Gap {
  reason: "retention_eviction" | "prefix_unavailable" | "collector_incomplete";
  requested_cursor: Cursor;
  earliest_cursor: Cursor | null;
}

interface OutputPage extends ExitInfo, OutputState {
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
```

`seq` 表示 PTY 采集事件顺序。同一事件拆分页时可复用 seq，但片段游标必须准确。跨页重组由游标位置决定，不靠 seq 唯一性。

`read_cursor` 是本页实际起点，`next_cursor` 是下一页起点。`has_more` 表示该快照下还有已采集日志未返回；false 不表示程序结束。

`eof` 只有在输出源关闭且该页已经读到最终末尾时为 true。它不保证采集或历史完整；必须同时检查 `output_complete`、`log_has_gaps` 和 `gap`。

日志原始字节是内部事实来源。对外事件 text 是稳定的 UTF-8 展示视图；V1 不提供原始二进制导出接口。非法字节按固定替换规则显示，完整字节回放不在承诺范围。

### 4.3 创建结果与状态快照

```ts
interface CreateData extends ExitInfo, OutputState {
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

type CleanupResult =
  | "not_requested"
  | "pending"
  | "group_cleared"
  | "partial"
  | "unverified"
  | "failed";

interface StatusData extends ExitInfo, OutputState {
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
```

`group_cleared` 只表示受管组范围已清理，不等于没有逃逸后代。PID/PGID 仅由当前 Server 在内存中跟踪，不要求 Agent 使用，也不列为对外必返字段。V1 不实现基于持久化记录的进程启动身份、UID 或 boot 身份核验；`unverified` 等既有 cleanup_result 值仍可用于表示当前运行期无法确认清理结果，不代表存在旧会话恢复。

`initial_cwd` 只表示启动目录。持久 Shell 后续的 `cd` 不更新为可靠的当前目录；`exit_code` 属于根 Shell，而不是某次输入的命令。

## 5. 八个工具的完整接口

### 5.1 公共启动参数 `LaunchInput`

`terminal_create` 与 `terminal_run` 复用以下定义：

```ts
interface LaunchInput {
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
```

`argv` 与 `shell_command` 必须且只能存在一个。argv 至少包含程序名，不做 Shell 解析。shell_command 为空时拒绝；存在时通过受配置的绝对路径 Shell 执行 `-c`，默认 `/bin/sh`。shell 只能与 shell_command 一起提供，且必须符合配置允许列表。

argv 和 shell 文本按原内容执行，不做空白重写或变量替换。argv 最多 256 个元素，程序名不得为空，后续参数可以为空字符串。每个字符串不得包含 NUL，单次启动规格的命令文本总量上限为 16 KiB。

cwd 省略时使用配置的 `workspace_root`。相对路径相对于该根目录解析，随后绝对化、解析真实路径并检查目录存在和允许范围。不得使用 Server 全局 `chdir()` 修改其他会话。

env 默认空覆盖；最多 64 项，键最多 128 个 UTF-8 字节，值最多 4096 个 UTF-8 字节，覆盖项总量最多 16 KiB。键值不得包含 NUL，键须为合法环境变量名，且均须满足 Server 允许策略。子进程基础环境从允许列表构造，不复制 Server 完整环境。工作目录与环境详细规则见第 9 节。

create 与 run 均默认 `mode: pty`。保留 mode 参数，但 V1 Schema 只接受 `pty`；显式传入 `pipe` 返回 INVALID_ARGUMENT，不回退、不静默忽略。PTY 默认 100 列、30 行，cols/rows 为 1～500 的整数。

runtime_timeout_ms 为正整数或 null。省略/null 使用 Server 运行时限；显式值必须不超过 Server 上限，超出则拒绝，不静默改写。结果返回生效值。

label 为可选定位标签，最多 128 个 UTF-8 字节，不唯一、不产生幂等效果。approval_id 仅用于获批后的相同请求重试。

### 5.2 `terminal_create`

输入为 LaunchInput，输出为 `Success<CreateData>` 或 Failure。

调用依次执行 Schema 校验、路径和环境规范化、硬限制、审批、配额检查、会话注册与进程启动。确认启动后尽快返回，不等待根进程结束。

```json
{
  "argv": ["python3", "-u", "/workspace/demo.py"],
  "cwd": "/workspace",
  "mode": "pty",
  "label": "interactive-demo"
}
```

进程启动即退出时允许返回 status 为 exited。文件不存在或启动阶段失败时返回 `SPAWN_FAILED`，如已登记记录则在错误 details 中返回 session_id，供查询诊断。

会话必须在启动与响应发送之间登记，便于响应丢失后用 list 找到。不得因此宣称具备通用去重；没有 approval_id 的启动请求再次调用仍可能创建新进程。

### 5.3 `terminal_read`

```ts
interface ReadInput {
  session_id: string;
  cursor: Cursor;
  max_bytes?: number;
  wait_ms?: number;
}

interface ReadData extends OutputPage {
  timed_out: boolean;
}
```

session_id 与 cursor 必填。max_bytes 默认 32768，允许 256～65536 的整数，表示本页展示文本的 UTF-8 载荷预算。wait_ms 默认 0，允许 0～10000；0 立即返回，正值有界等待新输出或源关闭。

```json
{
  "session_id": "term_demo",
  "cursor": "opaque_cursor_0",
  "max_bytes": 32768,
  "wait_ms": 1000
}
```

读取不消费日志，也不移动 Server 全局读指针。同一游标在保留区间内可重读相同内容，多个读取者互不影响。

有现成输出时立即返回。无输出且仍运行时，等到新数据、输出关闭或等待截止。等待预算用尽返回正常空页、timed_out 为 true；next_cursor 保持不变。

游标已被淘汰时返回 `CURSOR_EXPIRED`，details 给 earliest_cursor。Agent 明确选择新游标后才继续，不自动跳过。正常 read 成功页的 gap 为 null。

原始事件较大时必须拆页，不能因一条事件超过 max_bytes 而永远返回空页。不得在 UTF-8 字符中间生成无效 text。

### 5.4 `terminal_write`

```ts
interface WriteInput {
  session_id: string;
  text?: string;
  key?: "CTRL_C";
  approval_id?: string;
}

interface WriteData {
  session_id: string;
  status: SessionStatus;
  input_bytes: number;
  delivery: "queued";
  write_id: string;
}
```

text 与 key 必须且只能存在一个。text 是非空 UTF-8 文本，最多 16 KiB，不隐式追加换行。write_id 仅用于本运行期审计关联，不是客户端去重键。

```json
{
  "session_id": "term_demo",
  "text": "yes\n"
}
```

V1 统一返回 `delivery: queued`，表示全部输入已接受到有界队列，不证明程序已读取或业务成功。写队列不允许部分入队后仍报完全失败；超出容量时在入队前拒绝。

同一会话按 Server 接受顺序串行投递。终止与入队之间必须互斥：进入 stopping 后拒绝新输入，丢弃尚未投递的队列并记审计。发送中发生错误通过状态与审计记录说明，不能假装已被程序消费。

PTY 的 CTRL_C 向终端发送控制字符，按终端当前行规程作用于前台进程；程序可改变行为。不把控制字节等同于向整个受管组发送信号。[5]

V1 不实现专门 Ctrl-D、方向键或 stdin 半关闭接口。调用方可发送合法文本中的控制字符，但其效果属于当前进程与终端模式，不额外作保证。

写入先执行策略。命中 ask 时不入队；批准只绑定此次准确输入及会话代际。输入可能回显到输出，不承诺密码完全不可见。

对非 running 会话返回 `SESSION_NOT_RUNNING`。不自动重试不明确的输入投递，避免重复执行命令或重复回答。

### 5.5 `terminal_status`

输入仅有必填 session_id，输出为 `Success<StatusData>`。

查询返回采集器与进程监督器已经确认的状态，不推断 waiting_for_input 或 hung。last_output_at 长时间不变化不能证明卡死。

仅查询当前 Server 运行期内仍保留的会话记录。记录超过保留期已删除，或请求的是重启前的 session_id，返回 `SESSION_NOT_FOUND`。不返回旧会话诊断记录，也不根据 OS 进程表重建状态。

### 5.6 `terminal_list`

```ts
interface ListInput {
  statuses?: SessionStatus[];
  label?: string;
}

interface SessionSummary extends ExitInfo, OutputState {
  session_id: string;
  server_epoch: string;
  label: string | null;
  mode: Mode;
  status: SessionStatus;
  initial_cwd: string;
  command_summary: string;
  created_at: string;
}

interface ListData {
  server_epoch: string;
  sessions: SessionSummary[];
}
```

输入可为 `{}`。statuses 和 label 为可选过滤条件，label 精确匹配；一次返回当前快照下符合条件的全部保留记录，数量受 max_session_records 限制。V1 不接受 page_cursor、limit，也不返回 next_page_cursor。

列表只包含本单所有者 Server 管理的记录，不枚举整个 OS 进程表。摘要不包含完整环境或日志。

按 created_at 加 session_id 稳定排序，每次调用获取一致快照。并发新增和记录淘汰可以使不同调用的结果变化，不提供跨调用快照或分页扫描保证。

### 5.7 `terminal_terminate`

```ts
interface TerminateInput {
  session_id: string;
  grace_ms?: number;
  reason?: string;
}

interface TerminateData extends ExitInfo, OutputState {
  session_id: string;
  status: SessionStatus;
  termination_requested: boolean;
  cleanup_scope: "process_group";
  cleanup_result: CleanupResult;
}
```

grace_ms 默认 2000，范围 0～10000。reason 为可选审计说明，最多 512 个 UTF-8 字节，不替代固定 termination_reason。

对于活跃会话，标记 stopping、拒绝新输入，向当前 Server 跟踪的受管进程组发送 SIGTERM，宽限后仍存活才发送 SIGKILL。grace_ms 为 0 表示不等待宽限；必要时立即升级。不接受调用方提供 PID/PGID，不查找重启前的旧进程组。

调用不等待无限清理，通常返回 stopping 和 pending。Agent 用 status/read 确认最终退出与输出状态。发出信号不能直接报告 group_cleared。

重复终止不重复创建清理任务。已经退出且受管清理结束时返回现有结果。不存在于当前会话集合的 ID 返回 SESSION_NOT_FOUND，不向任何推测的旧 PID/PGID 发信号。

终止是减少执行权限的控制操作，已认证请求无需另外审批。它不立即删除日志。

### 5.8 `terminal_wait_for`

```ts
interface WaitInput {
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

interface WaitData extends ExitInfo, OutputState {
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
```

cursor 与 start 互斥；都省略等价于 start 为 beginning。beginning 指本会话原始起点，不是已淘汰后当前保留起点。now 原子取得调用时末尾，只检查之后的新输出。

stream 默认 all，V1 只允许 pty/all；all 与 pty 检查相同的 PTY 合并流。stdout/stderr 不在 V1 Schema 中，不能从 PTY 输出推断两者来源。

timeout_ms 默认 10000，范围 0～10000。0 只检查历史快照，不等待。模式最长 1024 UTF-8 字节，非空。

```json
{
  "session_id": "term_dev",
  "cursor": "opaque_cursor_from_create",
  "pattern": {
    "type": "literal",
    "value": "Server listening on 3000"
  },
  "stream": "all",
  "timeout_ms": 10000
}
```

先扫描历史，再等待追加输出；调用前已经打印的 listening 必须可以命中。匹配要跨采集块和无换行提示，不等待完整行。历史快照与新输出订阅必须无丢失地衔接（例如先注册通知，再取快照并按游标补扫），不能遗漏扫描期间追加的输出。timeout_ms=0 仍完成历史快照扫描，但不等待新增，扫描受计算预算限制。

字面量默认区分大小写，不接受 flags。正则采用普通 JavaScript `RegExp`，沿用 i、s 标志白名单，禁止重复或其他标志；语法错误返回 INVALID_PATTERN。V1 不维护锚点、环视、回溯引用或零宽断言禁用清单；采用 JavaScript 标准语义，不额外支持其他引擎专有语法。pattern.value 必须非空，但合法正则可以产生零宽匹配。

匹配在连续 UTF-8 文本视图上进行，先增量去除常见 SGR 颜色序列。一次调用内的历史和后续输出连续处理，匹配要跨采集块；保证的匹配跨度最多为 64 KiB 原始数据，包含控制序列开销，超出跨度不在保证范围。

历史按顺序扫描全部仍保留的待查数据，不得只检查最终尾窗。以不超过 64 KiB 的原始片段推进，保留至多前一个 64 KiB 后缀与新片段拼接求值（临时视图至多 128 KiB，UTF-8/SGR 边界正确衔接），使跨度不超过 64 KiB 的候选不因内部片段边界被漏掉。跨历史到新输出使用同一调用内后缀；不得把不同工具调用的后缀保留下来。match_window_bytes_per_stream 表示保证跨度/后缀预算，不是整个历史大小。

模式最多 1024 UTF-8 字节。正则编译/求值在可终止的 Worker 中执行；单次求值最多 50 ms，一次 wait 调用累计主动扫描/匹配计算最多 250 ms（等待新输出的时间不计入计算预算）。超限返回 MATCH_BUDGET_EXCEEDED，不终止会话；Failure.details 给出 session_id、read_cursor、scanned_cursor、earliest_cursor，其中 scanned_cursor 只推进至已经完整检查的连续前沿，不能跳过超预算而未检查的数据。按该游标重新等待仍是独立调用，不恢复后缀；必要时调用方显式选较早游标或修改模式。

仅在主线程用计时器包住同步 RegExp 不满足验收，因为灾难性回溯会阻塞事件循环；不得把 node-pty 实例传给 Worker。超限、RPC 取消或 Server 关闭时终止该调用未结束的匹配任务并释放等待者，不能留下失控 Worker。

锚点、环视和贪婪匹配针对当前有限窗口的已观察文本求值，窗口末尾不是程序最终 EOF。命中后不因未来输出撤销结果。零宽命中时起止游标相同；用同一游标和模式再次调用可能再次命中，V1 不自动推进或保存去重上下文。

命中只表示当前已观察文本中存在合法匹配，不等待未来输出形成所谓全局最长贪婪结果。同一次扫描有多个候选时以窗口内采集位置最早的合法命中为准。

read_cursor 是本次搜索原始起点。scanned_cursor 是已连续检查的前沿；命中时取 match_end_cursor，避免把同块中命中之后的其他内容也跳过。它只用于续等，不代表日志已完整展示。完整日志仍由 read 使用原读游标取得。

继续等待时直接将 scanned_cursor 作为下一次调用的 cursor。每次调用是独立搜索，不保存或重建跨 timeout 的匹配上下文，也不隐式回看游标之前的文本。跨采集块匹配只保证在同一次调用内成立；模式若横跨两次调用的超时边界，按前沿游标续等可能无法命中。需要重新检查前缀时，调用方可显式使用自己保存且仍有效的较早游标；不新增上下文 token 或恢复接口。

start 为 now 不使用调用前文本组成匹配。所给搜索起点已淘汰时返回 output_gap，并给 earliest_cursor，不能静默跳过；新调用不因上次模式不同而继承任何匹配状态。

返回优先规则：先检查已连续扫描区间内的命中；如命中之前存在未检查的缺口则返回 output_gap；无命中且源已经关闭时，在检查最终输出后返回 exited；否则在预算截止返回 timeout。

运行静默不是 output_gap。timeout 不终止进程。根进程退出但 drain 未完成时，不提前返回 exited；可以继续等待，或到期返回 timeout，并如实给 status 为 exited、output_closed 为 false。

SGR 去除不是完整屏幕还原。matched 不是服务健康证明，场景 1 仍要请求健康接口。

### 5.9 `terminal_run`

```ts
interface RunInput extends LaunchInput {
  wait_timeout_ms?: number;
  max_output_bytes?: number;
}

interface RunData extends OutputPage {
  outcome: "completed" | "background";
  server_epoch: string;
  label: string | null;
  initial_cursor: Cursor;
  effective_runtime_timeout_ms: number;
}
```

wait_timeout_ms 默认 1000，范围 0～10000。max_output_bytes 默认 32768，范围 256～65536，与 read 的文本载荷预算一致。

```json
{
  "argv": ["npm", "install"],
  "cwd": "/workspace/project",
  "mode": "pty",
  "wait_timeout_ms": 5000,
  "max_output_bytes": 32768,
  "label": "install-project"
}
```

流程为：复用 create 的校验与审批 → 创建一次会话 → 有界等待根进程退出及输出关闭 → 从日志起点返回一页输出。

等待内完成退出与输出关闭，返回 completed，退出码可以非零。未满足这两个条件则返回 background 和同一 session_id，进程不重启、不因等待超时被杀掉。wait_timeout_ms 为 0 时，在启动与即时快照后返回，不强求 background，若已经完成也可返回 completed。

background 的 status 可能为 exited，例如根进程已退出但仍在 drain。completed 不保证 output_complete 为 true：采集因 drain 截止结束时仍须明确 false。

无论哪种 outcome，都保留会话并返回 OutputPage。超过页预算的日志通过 read 和 next_cursor 获取；next_cursor 指向已返回页之后，不直接跳到日志最新位置。

若等待期间起始日志已经被淘汰，run 返回从 earliest_cursor 开始的可用页，并用 gap 明确 retention_eviction，initial_cursor 仍表示原始起点。它不冒充完整日志。

wait_timeout_ms 只控制同步等待。runtime_timeout_ms 控制进程生命周期，二者完全不同。真实 RPC 断线或超时不等于成功 background，Agent 应查询 list/label/时间核实，不能盲目重试。

## 6. 输出存储、游标与内存控制

### 6.1 独立采集与稳定文本

每个会话有持续 PTY 采集器。即使没有 read/wait 调用，仍消费 PTY master，避免内核缓冲区满后阻塞子进程。

内部使用每会话环形缓冲区保存按顺序追加的字节事件与稳定游标映射。PTY 流使用增量 UTF-8 解码器，保留半个字符；EOF 时处理残留非法字节并显示替换字符。不要求一个 OS read 正好对应一行或一个完整字符。

游标绑定会话 ID、日志代际和位置。客户端不能根据显示字符数推算它。伪造、跨会话、类型混用等返回 INVALID_CURSOR；语法合法但已淘汰返回 CURSOR_EXPIRED。

输出不会未经安全处理打印到 Server 自己的终端。MCP text 中的控制字符使用正确 JSON 编码。CLI 日志展示要处理危险转义，不能执行 OSC 等控制序列。

### 6.2 淘汰与页面限制

V1 只使用每会话有界环形缓冲区，不实现输出磁盘转录、全局输出配额或跨会话全局淘汰。单会话容量达到 per_session_output_bytes 时覆盖该会话最旧输出，更新 earliest_cursor 与 log_has_gaps。缓冲区按实际输出分配，不启动即预分配全部容量。

正在等待的匹配器只保留本次调用内的有限窗口，不锁住全部历史，不阻止环形缓冲区覆盖旧输出。尚未扫描的数据被覆盖时返回 output_gap；调用结束即丢弃匹配状态，不做续等重建。

单次页限制按 UTF-8 展示文本计算，JSON 元数据与双份兼容文本另计。完整序列化 MCP 结果上限为 1 MiB；若编码膨胀导致超限，继续缩小页而非输出不符合协议的半截 JSON。

该结果上限也适用于没有输出页的工具。terminal_list 不分页、不裁剪 sessions；若完整过滤结果超过序列化上限，返回 QUOTA_EXCEEDED 与安全诊断，由调用方缩小 statuses/label 过滤或管理员降低保留记录数，不以部分列表冒充完整快照。其他无输出页结果超限也报明确错误，不截断字段或 JSON。

过期恢复机制只使用 CURSOR_EXPIRED 与 earliest_cursor，不建立全局淘汰索引或恢复上下文。为保持工具契约，read 对过期游标报错；wait 仍用既有 output_gap 结果与 gap 字段表达同一种缺口；run 仍从 earliest_cursor 返回可用页并填 gap。这些字段是同一环形缓冲区过期事实的不同工具表示，不是额外存储机制。不能停止读取子进程输出来无限等待客户端。

### 6.3 原始转录与屏幕状态

PTY 只有合并流 pty，不能按颜色或文本内容推断 stderr。[5] Pipe 分流能力移入后续版本。

V1 展示的是日志转录，不是当前屏幕。回车、退格、光标移动和备用屏幕可能使转录不同于人看到的画面。只保证普通 CLI、REPL、向导和基本控制交互，不保证 TUI 理解。

## 7. 进程、并发与会话生命周期

### 7.1 状态机与根进程语义

```text
starting → running → stopping → exited
                 └──────────→ exited
starting → spawn_failed
终态记录超过保留期限 → 删除
Server 退出 → 丢弃本运行期全部记录
Server 重启 → 新代际，空会话集合
```

状态更新、输入入队、终止与自然退出必须串行化，避免写已关闭句柄或重复回收。可以使用单会话锁或事件队列，不建立复杂写租约。

每次创建一个根进程。持久 Shell 是一种根进程，其变量、cd 和前台任务可以持续存在；Server 不额外提供单命令退出码边界。

PTY 启动必须正确建立会话、控制终端和进程组关系。单纯分配 master/slave 并重定向标准流，不能被当作已经保证完整作业控制。Unix 新会话与控制终端的关系需要由后端正确处理。[5] [6]

### 7.2 输出排空与僵尸回收

观察到根进程退出后记录 ExitInfo，但继续读取缓冲区。读取至 EOF 或平台约定的 PTY 关闭状态后，才设置 output_closed。

根进程必须执行 wait/waitpid 或等价回收，区分正常退出与信号退出。不回收的退出子进程可能成为僵尸进程。[7]

drain 默认最多 2000 ms，从根进程退出被观察到时开始。到期仍未关闭则停止采集，output_complete 为 false、log_has_gaps 为 true，并记录尾部可能截断。平台后端不能把普通 EAGAIN 当 EOF。

根进程退出后，仍留在当前受管组内的后代不作为无限后台服务保留；在当前运行期按已跟踪的进程组关系进行清理。其他新进程组或守护化后代属于本版限制，不增加启动身份核验或重启扫描。

### 7.3 进程组终止范围

对当前 Server 跟踪的受管进程组执行 TERM、宽限、KILL，并回收 Server 可等待的子进程。必须记录清理结果，发送信号本身不等于清理完成，失败或无法确认组已清空时不能返回 group_cleared。不实现基于旧元数据的进程身份核验。

PGID 不是安全边界。Shell 作业控制可能产生新组，程序也可建立新会话。不得承诺任意后代都被清除；V1 不要求扫描并强杀整个 OS 的疑似进程树。

Ctrl-C 作用于终端前台任务，terminate 作用于受管进程组，二者不可互换。即使 Ctrl-C 结束前台程序，根 Shell 仍可能 running。

### 7.4 四种时间限制

read.wait_ms、wait_for.timeout_ms 和 run.wait_timeout_ms 仅限制一次工具等待，不控制进程寿命。runtime_timeout_ms 限制执行总时长；空闲 TTL 限制无人管理会话；drain_timeout_ms 限制退出后的输出排空。

HTTP 断开不能直接解释为请求取消或终端终止。[4] 取消 read/wait 只移除等待者。run 在成功启动后取消等待，保留已登记会话，不自动重启或终止。[8]

正常 stdio EOF、Server SIGTERM 或主动关闭属于 Server 退出路径，应停止接受新创建，终止已知受管组并进行有界回收和 drain。SIGKILL、断电等不保证执行正常退出路径。

### 7.5 空闲清理与并发限制

针对单个 session_id 的已认证有效操作更新 last_client_activity_at。read/wait/status/write/terminate 都算活动；list 不更新任何会话的活动时间，避免全表轮询意外给全部会话续期。

采集新输出不算客户端活动。空闲 TTL 到期进入终止流程，termination_reason 为 idle_timeout。V1 不提供 detach 或无限期保活功能，用户可通过配置调整时限。

每会话写队列有界；所有工具等待者有全局上限。达到会话、等待者或输入队列配额时返回明确错误，不无限排队。

### 7.6 无持久化的退出与重启语义

会话元数据、PID/PGID、输出缓冲区与等待状态只存在于当前 Server 内存中；不写会话状态文件，不做跨重启恢复或进程身份核验。持久审计日志不用于重建会话。

正常 stdio EOF、SIGTERM、SIGINT 或主动关闭时，停止接受新执行、移除等待者、终止全部当前受管会话，并进行有界 TERM/KILL、根进程回收与 drain；退出前丢弃会话及审批记录、关闭并移除本地 socket。测试必须证明可控 fixture 在声明的受管组范围内被清理，而不是仅清空内存。

意外崩溃、SIGKILL、断电或 OS 异常可能留下受管组或逃逸后代；新 Server 不扫描、不认领、不自动向旧 PID/PGID 发信号。新启动生成新的 server_epoch，session 列表为空，旧 session_id 返回 SESSION_NOT_FOUND，旧审批不可用。残留进程由用户或外部运行管理器人工处置，见第 17 章。

## 8. 本地人类审批

### 8.1 策略决策与申请

Policy 输出 allow、ask、deny。Schema 和硬限制优先，命中硬拒绝立即返回错误，不能批准绕过。不允许的 cwd/env 与超配额属于硬限制。

申请主要适用于 create/run 和被规则识别的 write。read、status、list、wait 和 terminate 不要求另行审批，仍要求认证及参数校验。

ask 时只登记审批记录，不启动进程、不入队输入、不预先修改目标状态。返回如下结构的工具错误：

```json
{
  "ok": false,
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "此操作需要本地用户批准。",
    "retryable": true,
    "details": {
      "approval_id": "apr_example",
      "approval_status": "pending",
      "expires_at": "2026-10-25T15:00:00Z",
      "operation": {
        "tool": "terminal_run",
        "argv": ["rm", "-rf", "./build"],
        "cwd": "/workspace/project"
      },
      "instruction": "在 Server 所在机器使用 terminalctl 查看并批准；随后以原参数和 approval_id 重试。"
    }
  }
}
```

时间和 ID仅是格式示例。展示摘要不包括环境秘密原值；摘要须足以让用户理解目标主机、命令、目录、模式、时限和自由交互会话的权限范围。

### 8.2 本地 CLI 与 socket 信任边界

CLI 必须提供：

```bash
terminalctl approvals list
terminalctl approvals show <approval_id>
terminalctl approvals approve <approval_id>
terminalctl approvals deny <approval_id>
```

`terminalctl` 通过本地 Unix domain socket 调用运行中的 Server；CLI 不自行修改审批状态文件。approve 展示规范化规格摘要并要求本地终端明确确认；V1 不提供跳过确认的无人值守批准参数。deny 调用 Server 将申请标记为 denied。

运行目录权限限定为运行用户（0700），socket 限定为运行用户（0600）。管理入口不挂到公网 MCP 路径，不接受 MCP token 作为批准凭证。V1 无独立口令、口令验证值或失败认证限速；HTTP 的调用速率限制与此无关，仍按 12.1 实现。

实际状态更新由 Server 完成。socket 不可达时 CLI 明确报错，不生成离线批准文件。审批记录全部在内存中，Server 重启后 list 为空、旧批准失效。

不提供 approval_approve MCP Tool。MCP token 可以借原请求得到审批状态，但没有远程批准权限。申请 ID 是标识，不是授权凭证；批准本身不执行，Agent 必须用原请求加 approval_id 重试。

本地 socket 依赖 OS 用户权限而不是独立人类身份认证。同 UID 进程可能直接调用批准入口，即使绕过 CLI 的交互确认也不具备额外口令屏障。因此该审批只适用于可信单用户主机的防误操作流程，不是抵抗同 UID 恶意代码的安全隔离。

### 8.3 规范化与批准绑定

请求在创建审批记录之前完成默认值固化与规范化。记录至少绑定工具名、Server 代际、准确命令、规范化 cwd、受控环境内容摘要、执行模式、Shell、PTY 尺寸、运行 UID、运行时限及写入目标。

argv 保留元素顺序与字符串内容；shell_command 保留原文。cwd 使用批准时解析的真实绝对路径。env 按确定顺序序列化后做摘要，摘要覆盖实际基础环境与覆盖结果，原值不展示给 Agent。规格摘要使用稳定序列化与加密哈希。

run 的等待和页面预算也作为请求绑定项，避免批准后随意替换参数。write 绑定 session_id、会话代际及准确输入字节。approval_id 本身不参与规格摘要。

批准绑定启动规格，不保证工作区脚本文件或可执行文件内容永不改变。V1 不实现文件内容冻结；工作区与运行主机属于可信环境。

重试时重新校验硬限制和当前配置。解析后的执行规格不一致，返回 APPROVAL_MISMATCH；不能用原批准执行另一条命令或另一个目录。

### 8.4 内存状态、单次消费与并发

```text
pending → approved → consumed
        → denied
pending / approved → expired
Server 退出或崩溃 → 全部审批记录丢失
```

每条记录在内存中保存规范化规格摘要、截止时间及可选 session_id/write_id、执行中的 Promise 和最终回执。不设持久 execution_state，不设 unknown 状态，也不实现 EXECUTION_UNKNOWN 错误码。

获批请求执行前在内存中原子认领：在任何启动/入队副作用之前标为 consumed 并登记执行中的 Promise。两个并发重试只有一个调用启动或入队；另一个等待同一个 Promise，或返回 APPROVAL_IN_PROGRESS，之后重试仍读取同一个记录。认领后不得因本次执行失败而把批准改回 approved。

相同规格重复请求已创建会话时返回原关联会话的当前结果；write 返回原入队回执，不再入队。若执行已明确失败则重放原失败，不以同一批准再次执行。若关联会话已淘汰则返回 SESSION_NOT_FOUND，不新建会话。该保证只覆盖当前 Server 运行期且该审批记录仍存在时，不扩展为通用请求去重。

已拒绝、过期、参数不匹配或批准记录失效均不能执行。审批 ID 应能识别 Server 代际，客户端仍把它视为不透明字符串；旧代际或已不存在的审批 ID 返回 APPROVAL_INVALIDATED，而不是登记新申请。有效但 pending 的 ID 返回 APPROVAL_PENDING，绑定项变化返回 APPROVAL_MISMATCH。

pending/approved 的 expires_at 固定为申请创建时间 + approval_ttl_ms；CLI 批准及首次执行原子认领都必须在相同内存状态锁内检查该截止，未消费而到期返回 APPROVAL_EXPIRED。到期与认领竞争时只有一次确定结果，不能先过期又执行。

一旦认领为 consumed，原 expires_at 不再中止已开始的执行或禁止回放。执行中的记录不得淘汰；执行回执产生后，从该时刻起再按现有 approval_ttl_ms 保留内存回执，不新增持久化或另一个 TTL 配置。终结记录也可按 max_approval_records 容量规则提前淘汰。回执仍在时允许同规格回放且不重执行；清理后返回 APPROVAL_INVALIDATED，不复用 ID，不因“找不到记录”重新批准。需要新执行时必须显式提交不带旧 approval_id 的新请求并获得新批准。

Server 在启动/入队交界处崩溃可能已产生副作用；重启后不保存审批、执行回执或旧会话，不推断副作用未发生，不承诺跨崩溃恰好一次。RPC 断线仍属客户端未知结果，不能盲重试；这是操作与文档限制，不通过 EXECUTION_UNKNOWN 协议状态表达。

### 8.5 交互式会话的限制

启动自由 Shell/REPL 时，审批摘要必须说明它是广泛交互执行能力，不是只允许当前一条输入。后续可识别的危险文本仍可按规则 ask/deny。

通用文本过滤无法理解全部别名、拆分输入、编码和解释器行为，不能承诺拦截全部间接危险动作。脚本执行也可能在进程内部做更多操作。审批是可审计的防误操作机制，不是命令黑名单沙箱。

## 9. 工作目录、环境与审计规则

### 9.1 工作目录

配置必须提供 workspace_root 与 allowed_cwd_roots。默认只有 workspace_root。检查使用真实路径边界，不能用简单字符串前缀；相邻名称目录、符号链接逃逸必须拒绝。

创建时设置该子进程 cwd，不修改 Server 全局工作目录。检查后路径被替换的风险应尽量通过可靠打开/启动方式降低，但无沙箱时不保证对恶意同用户文件修改完全免疫。

允许启动目录只限制启动位置，不限制进程后续 cd 或绝对路径访问。不得在 README 宣称 cwd 白名单提供文件系统隔离。

### 9.2 环境变量

基础环境按允许列表构造，如受配置的 PATH、HOME、平台需要的临时目录和 locale；PTY 的 TERM 可使用配置值。caller 可覆盖的变量另有允许列表，例如 NODE_ENV、CI 或选定 locale 项。

默认不向子进程传入 MCP token、API Key、云服务认证环境。V1 不产生审批口令或验证值。危险启动或动态库注入变量默认禁止覆盖，例如 LD_PRELOAD、DYLD_INSERT_LIBRARIES、BASH_ENV。

禁止完整继承 Server 环境。工具只返回必要摘要，不返回密钥原值。用户工作目录和 HOME 中已有的密钥文件仍受 OS 权限影响，本版不承诺阻止同用户进程读取。

### 9.3 默认命令策略

硬限制之后，显式 deny 优先于 ask，ask 优先于 allow。管理员可配置规则，但不能靠批准绕过硬限制。

建议默认示例策略：sudo 为 deny；直接可识别的递归/强制删除为 ask；显式 shell_command 和自由交互 Shell/REPL 启动为 ask；受信任开发命令在允许目录中为 allow。规则必须基于 argv/规范化规格，而不是只按展示摘要判断。

可配置允许规则需要明确参数适用范围，不把“允许 python”误称为“只允许数学计算”。具体规则只是护栏，脚本内部行为不由此得到强限制。

Server 默认拒绝以 root 运行，避免误把整个服务变为无界高权限入口。测试必须以非 root 用户运行；只有确实无法使用非 root 的测试环境才可提供显式、仅测试可用且默认关闭的 root 开关，不能进入生产启动配置。当前 Linux 沙箱以 ubuntu 用户运行，不需要此开关。所运行程序仍具有对应用户权限。

### 9.4 审计与日志

审计记录 Server 代际、会话 ID、工具、规格摘要、策略结果、审批状态、输入队列关联、状态变更、发出信号、退出与清理原因。

对原始命令、环境、输入和输出明确保存策略。默认不持久保存完整输入原文；敏感输入可能回显，不能仅因输入未记录就宣称秘密安全。

审计目录与本地 socket 运行目录权限受限；审计使用有配额的轮转策略，不因审计无限增长占满磁盘。不得记录 MCP token 或其他可复用凭证。持久审计仅供诊断，不保存/重建会话或审批状态；审计轮转配额不属于已移出的全局输出配额。

输出是来自进程的不可信数据，不是系统指令。工具说明与客户端集成说明应提示 Agent 不执行日志中诱导越权的文本。脱敏为辅助措施，不保证覆盖任意编码后的秘密。

## 10. 配置基线与超限行为

以下默认值可以由用户在 Server 启动配置中修改，但必须在两平台采用同一语义，且在 README 给出当前生效值：

```json
{
  "max_live_sessions": 16,
  "max_session_records": 256,
  "per_session_output_bytes": 8388608,
  "default_output_page_bytes": 32768,
  "max_output_page_bytes": 65536,
  "max_serialized_tool_result_bytes": 1048576,
  "input_queue_bytes_per_session": 65536,
  "max_input_bytes_per_call": 16384,
  "max_waiters_total": 64,
  "max_tool_wait_ms": 10000,
  "default_runtime_timeout_ms": 3600000,
  "max_runtime_timeout_ms": 86400000,
  "idle_timeout_ms": 1800000,
  "drain_timeout_ms": 2000,
  "default_terminate_grace_ms": 2000,
  "completed_record_ttl_ms": 3600000,
  "approval_ttl_ms": 600000,
  "max_approval_records": 256,
  "match_window_bytes_per_stream": 65536,
  "max_pattern_bytes": 1024,
  "regex_eval_timeout_ms": 50,
  "max_match_compute_ms_per_call": 250
}
```

workspace_root、allowed_cwd_roots、可信 PATH、允许环境覆盖和认证配置按实际机器提供，不用示例值冒充用户真实配置。

活跃会话超限拒绝创建。记录超限先按期限淘汰终态记录；无法释放时拒绝新创建，不删除活跃会话掩盖泄漏。审批记录超限淘汰已终结记录，仍超限拒绝新增申请。等待者超限立即失败，不无限排队。

单会话环形输出缓冲区满时覆盖本会话旧输出并标记缺口，不自动杀正常任务，不淘汰其他会话输出。输入配额超限在入队前拒绝。运行/空闲超时才进入终止流程。

不设全局输出预算，因此默认 max_session_records=256 与每会话 8 MiB 的理论保留载荷上限为 2 GiB（不含元数据、解码视图与匹配窗口；缓冲按需分配）。部署时按可用内存降低这两项；max_live_sessions=16 并不把终态记录占用限制在 16 个缓冲区。V1 不承诺全局内存自适应淘汰。

Server 不提供本版未实现的 CPU、内存或文件系统沙箱保证。运行时限、并发和自身日志配额只限制明确覆盖的资源。

## 11. 错误码与重试指导

错误 details 只返回必要诊断，不暴露密钥。至少实现以下稳定错误码：

**参数与执行规格。** INVALID_ARGUMENT、INVALID_CURSOR、CWD_NOT_ALLOWED、ENV_NOT_ALLOWED、COMMAND_DENIED、UNSUPPORTED_OPERATION、SPAWN_FAILED。输入不变时盲重试通常无效；SPAWN_FAILED 仅在确认尚无副作用后可重新发起。

**会话与输出。** SESSION_NOT_FOUND、SESSION_NOT_RUNNING、CURSOR_EXPIRED。CURSOR_EXPIRED 必须给 earliest_cursor；是否跳过由调用方明确决定。重启前的会话直接返回 SESSION_NOT_FOUND，不存在 SESSION_LOST 或因旧日志未持久化而返回的 OUTPUT_UNAVAILABLE。

**配额与存储。** QUOTA_EXCEEDED、INPUT_QUEUE_FULL、STORAGE_UNAVAILABLE。写队列满可在确认未入队后重试；STORAGE_UNAVAILABLE 仅用于必要审计存储等 I/O 不可用，不再表示审批或会话状态持久化失败。执行前必要审计写入失败时拒绝新副作用；副作用之后的审计故障必须在 stderr/状态诊断中如实说明，不能触发自动重执行。

**审批。** APPROVAL_REQUIRED、APPROVAL_PENDING、APPROVAL_DENIED、APPROVAL_EXPIRED、APPROVAL_MISMATCH、APPROVAL_INVALIDATED、APPROVAL_IN_PROGRESS。pending 与 in_progress 可重查同一请求；deny/mismatch/expired 不可复用许可执行。

**输入投递不确定。** 保留 INPUT_DELIVERY_UNKNOWN：只用于本次 write 返回之前发生异常且无法确认整个输入是否已接受的故障路径，details 至少给 session_id、已生成的 write_id（如有）及不确定边界说明，调用方不得自动重发。它不能用来把明确未入队的 INPUT_QUEUE_FULL 伪装成未知，也不能在已返回 queued 后追溯改变原调用结果。

正常 V1 队列接受是全量原子操作。queued 后的异步发送故障以 write_id 关联审计事件记录实际已确认的发送事实（未确认部分不冒充已送达）；会话的状态只表达可确认的进程/句柄事实，StatusData 不新增逐输入投递查询字段。审计不能证明程序已消费输入，Agent 不得因后续 read 静默而自行重发。删除 EXECUTION_UNKNOWN；一般 RPC 响应丢失或跨崩溃副作用仍需人工核查，不因此新增持久执行状态。

**模式。** INVALID_PATTERN、MATCH_BUDGET_EXCEEDED。返回模式限制说明；修改模式后重新等待，不结束终端。

retryable 表示在改变状态、取得授权或满足条件后可能重试，不表示 Agent 应立即循环。所有请求应在可用时返回关联 session_id、approval_id 或恢复游标。

wait 的 output_gap 和 timeout、run 的 background、read 的 timed_out 都不是上述错误，仍为 ok true。

## 12. 启动、连接和客户端使用约定

### 12.1 Server 与 CLI

交付可执行入口 `terminal-server` 和 `terminalctl`，使用 TypeScript 构建后的 Node.js 入口，安装与本地构建命令在 README 给出。Server 至少支持选择 stdio 或 HTTP 传输以及配置文件路径。

stdio 模式的 stdout 只承载 MCP 消息。调试和业务日志走 stderr 或文件。不得让子进程继承 Server 的协议 stdout，也不得把提示文字或安装日志直接打印进去。[4]

HTTP 默认监听 127.0.0.1。`/mcp` 使用 Streamable HTTP，验证 Authorization Bearer 单 token，按规范校验 Origin。单个 JSON-RPC 请求最多 1 MiB；还须实施可配置的调用速率限制。不是自定义 REST/WebSocket 替代协议。[4]

公网或云端连接需要用户部署的安全可达入口；远程链路必须保护 token。Server 不自动开公网端口、不自动配置隧道。审批 socket 保持本地，不通过远程 MCP 入口转发批准操作。

### 12.2 客户端配置示意

常见 stdio 配置形式如下，实际客户端格式以其文档为准：

```json
{
  "mcpServers": {
    "terminal-controller": {
      "command": "/absolute/path/to/terminal-server",
      "args": ["--transport", "stdio", "--config", "/absolute/path/config.json"]
    }
  }
}
```

HTTP 客户端配置可访问的 MCP URL和认证方式。云端客户端的 localhost 不是开发者主机的 localhost。使用 Manus 验证时，依据其可用连接方式接入，不预设它会在用户电脑启动 stdio 进程。

### 12.3 必须提供给 Agent 的工具说明

create/run：启动只发生一次；等待结束不杀进程；响应丢失不要盲重试。

read：复用 next_cursor；空页和 has_more false 不等于退出；游标过期需明确选择恢复位置。

write：作用于现有进程；不自动换行；queued 不是业务成功；不明确投递不要重复发送。

wait_for：先查历史；scanned_cursor 直接用于下一次独立续等，read_cursor 用于完整读取；跨块匹配仅保证在一次调用内，不保证跨 timeout；普通正则按当前有限窗口求值；匹配不等于健康检查成功。

terminate：请求接受不等于所有清理完成；确认 status/output；范围仅为受管进程组。

审批：在 Server 主机由用户使用 CLI 批准，Agent 不得自行调用批准通道。

## 13. 五个端到端验收场景

### 13.1 启动项目并检查健康接口

准备一个可控 Node 测试项目，其 dev server 打印 listening 并提供 `/api/health`，安装过程可用延时 fixture 模拟。自动化测试无需依赖真实 npm 网络速度。

Agent 用 run 启动 npm install。等待预算耗尽应返回同一个活跃 session_id。随后用 read/status 确认安装退出码为零，再 create dev server。

用 wait_for 匹配 listening。至少测试日志在等待前已经出现、文字分两块出现、颜色码跨块出现、无匹配退出，以及等待超时但服务仍运行。

用第二个会话通过 run 执行 curl，请求健康接口并验证 HTTP 与业务结果。最后 terminate dev server，再确认受管组清理和输出结束。

通过条件：没有因等待超时重启安装；会话没有串输出；wait 正确命中；健康检查通过另一会话执行；服务确实按声明范围收尾。

### 13.2 REPL 与向导

在 PTY create Python REPL，输入 values，再在后续 write 中使用同一变量计算。读取结果后继续输入其他代码，证明不是每次启动新 Python。

使用 fixture 向导打印不带换行的提示，wait/read 能及时看到；write 显式发送回答与换行，原进程进入下一阶段。

通过条件：状态保持、文本按接受顺序投递、没有隐式换行、退出后的写入拒绝。统计计算正确性由测试代码和 Agent 检查，不由 Server 自行理解数据。

### 13.3 长测试、分页与最终错误

使用可重复 fixture 模拟长测试，分段输出并以非零退出码结束；实际完整演示可运行真实测试套件。

run 快速返回 background。Agent 按游标读新输出，最终得到非零退出码和最后错误。测试两个读取者从同一游标重读，内容不互相消费。

用较小日志配额产生淘汰，旧 read 返回 CURSOR_EXPIRED，wait 返回 output_gap，run 首页说明缺口。UTF-8、多字节字符、超长行和页边界不得损坏文本或阻止推进。

通过条件：内存受限、输出续读正确、非零退出不误报 MCP 工具失败、尾部 drain 完成后才确认最终日志。Agent 总结上下文是客户端职责。

### 13.4 静默任务与主动终止

fixture 分别覆盖可被 Ctrl-C 中断、忽略 TERM、组内派生子进程及主动脱离进程组。

Agent 按用户超时政策选择 Ctrl-C 或 terminate。验证 CTRL_C 不等于整会话终止；TERM 宽限后 KILL；重复 terminate 结果可理解；可等待子进程被回收；输出尾部与清理结果真实。

通过条件：受管组内进程按声明清理，没有本服务可回收但未回收的僵尸或句柄泄漏。逃逸 fixture 用于确认限制如实报告，由测试 harness 自行收尾，不能要求 V1 强制清除或误杀无关进程。

### 13.5 拒绝、申请审批与一次执行

使用临时测试目录覆盖：未授权 cwd 硬拒绝；敏感环境覆盖拒绝；直接危险操作 ask；sudo 按默认规则 deny。

ask 时核实尚未创建进程或入队。用户通过本地 CLI 展示规格并明确确认，CLI 经本地 socket 调用 Server 批准；Agent 携原参数重试才执行。测试未批准、过期、拒绝、参数变化、跨会话 write 审批、socket 权限与重启失效；不测试口令验证或失败认证限速。

两个并发获批重试只能产生一个启动或一份输入。重复成功审批请求返回原关联结果，不再执行；执行失败后同一批准不重新执行。意外退出后新 Server 的审批列表为空，旧 ID 返回 APPROVAL_INVALIDATED，不要求恢复回执或返回 unknown。

通过条件：MCP token 不能批准；申请 ID不能自行授权；API Key 未继承到子进程；批准作用准确且可审计。测试只验证本版护栏，不宣称任意恶意同用户代码无法访问主机。

## 14. 额外自动化测试与完成标准

必须测试 Schema 的互斥、未知参数和边界值；成功/失败结果符合 outputSchema；Server stdout 无协议污染；HTTP 初始化、认证、Origin 与重连符合已采用规范。

必须测试 root exit 与 PTY 输出关闭不同步、PTY 后代持有输出端或受控后端 fixture 导致 drain 截止、采集错误、并发 write/terminate、运行超时、空闲清理和等待者超限。必须测试 output_complete 的布尔生命周期、log_available 的当前记录语义、literal 与普通正则跨采集块/内部扫描片段匹配、历史扫描期间追加输出不丢失、锚点/环视合法模式、超时后直接游标续等、匹配预算错误的安全前沿与取消时释放 Worker；灾难性回溯不能阻塞其他会话的 read/status。

通过受控故障 fixture 覆盖入队前明确失败、接受结果不确定的 INPUT_DELIVERY_UNKNOWN 路径及 queued 后异步发送故障的审计关联，不新增输入投递查询工具。审批测试还须覆盖到期与原子认领竞争、执行中超过原到期仍只执行一次、回执保留期内重放、回执淘汰后旧 ID 失效。

必须测试正常 Server 退出清理全部受管会话，以及意外退出后启动新 Server：新 server_epoch、空 session/approval 集合、旧会话 SESSION_NOT_FOUND、旧审批 APPROVAL_INVALIDATED，不扫描或终止未知旧进程。崩溃 fixture 的残留由测试 harness 收尾；不要求 lost、元数据恢复、PID 复用身份核验或跨崩溃执行去重。

Linux（当前沙箱）为主开发与全量自动化测试平台，直接执行 npm test，不使用 Docker；记录 OS/架构、运行 UID、Node.js、node-pty、SDK/vitest 版本及命令。测试以非 root 用户执行，不得任意跳过失败用例。

macOS 由用户在本机按 README 执行 npm ci、npm run build、npm test，并手动验证本阶段场景，作为每阶段独立人工验收门禁。开发者只能记录 Linux 已验证，不得以 Linux 结果冒充 macOS 已通过；用户尚未回传 macOS 结果时标记人工验收待完成。不承诺覆盖所有 Linux 发行版或 macOS 版本。

必须用一个 MCP 调试客户端及 Manus 完成真实 Agent 交互闭环。Manus 接入在阶段 ④ 先完成最小冒烟，五个场景在阶段 ⑤ 完成完整演示。若网络或连接配置限制导致未完成，明确记录为外部验收阻塞，不宣称已验证或已完成最终验收。

真实演示中的启动、输入、读日志和终止必须全部通过本 Server，不借用客户端自带终端工具补齐缺失功能。人类批准通过本地 CLI 是预期例外，不是 Agent 绕过工具。

完成交付包括 TypeScript 源码、依赖锁文件、安装启动说明、配置示例、八个 Schema、CLI、测试 fixture、Linux 沙箱全量测试结果与用户 macOS 每阶段人工验收记录，以及五场景演示步骤与记录。README 明确安全定位、PTY 合并流、进程组范围、每会话环形覆盖、RPC 重试风险、内存审批、重启后空会话与崩溃残留处理。

**V1 完成的判断标准：Agent 只通过八个工具即可完成“启动 → 等待/读取 → 输入 → 继续观察 → 确认退出或终止”的闭环；Server 在并发、超时和异常情况下仍能明确表达会话、输出、审批与清理的真实状态。**

## 15. 实现阶段

按 ①～⑤ 顺序推进。每阶段先满足对应门禁，再进入下一阶段；后续阶段不得将第 17 章归档内容重新作为隐含前置条件。每阶段均提交可构建源码、Linux 沙箱全量 vitest 结果与用例清单，以及用户 macOS 本机 npm test 和手动场景所需命令；用户 macOS 人工验收未完成时明确标记，不冒充已通过。不使用 Docker。

工作量以一名熟悉 TypeScript、Node.js、MCP 和 Unix 进程语义的开发者估算，1 人日按 8 小时计；包含编码、阶段内自动化测试和排错。不是完成日期承诺，不包含审批等候、Manus 账户/网络可达性等待、隧道或生产环境运维。

### 15.1 阶段 ①：会话内核（不接 MCP）

**产出：** TypeScript 项目骨架、node-pty 后端、Session Manager、五态状态机、每会话环形输出缓冲区与不透明游标、串行输入队列、退出/drain/TERM-KILL、运行时限与空闲清理、literal 与普通正则 Wait Matcher，以及八个工具对应的内部服务接口。此阶段不接 SDK 传输，不做策略/审批，不引入另一套 run 执行内核。

**验收标准：**

- vitest 直接调用内核完成创建 → 历史/增量读取 → 同进程写入 → 等待 → 退出或终止；PTY REPL/向导保持状态，无换行输出可见。
- run 复用同一会话，等待预算到期不重启/不杀进程；非零退出仍是正常执行结果。
- 两读取者不互相消费；大事件可拆输出页，UTF-8 跨块/跨页不破坏；环形覆盖仅影响本会话，过期报 CURSOR_EXPIRED 并返回 earliest_cursor，wait/run 按既有 gap 契约报告缺口。
- wait 先历史后新增、同一次调用内跨块匹配；续等直接游标、不恢复上下文；合法锚点/环视可运行，超预算正则不会卡住其他会话。
- 并发 write/terminate、Ctrl-C、TERM→KILL、root exit 与 output_closed 不同步、drain 截止、运行/空闲时限、队列/等待者上限均通过测试；output_complete 只出现布尔值。
- 正常关闭清理全部当前受管会话并回收可等待子进程；新内核实例为空，不恢复或核验旧进程，崩溃残留测试由 harness 清理。

**工作量：6～8 人日。** 主要风险是 PTY 平台差异、退出/排空竞态、游标与文本映射；这是工期最长的阶段。

### 15.2 阶段 ②：MCP 适配 + stdio + 工作目录白名单 + 审计日志

**产出：** 官方 `@modelcontextprotocol/sdk` 的八工具适配、完整 inputSchema/outputSchema、统一 structuredContent 与兼容 JSON text、stdio 入口与配置加载、真实路径工作目录白名单、脱敏且受限轮转的审计日志。核心层保持不依赖 MCP；策略入口预留，审批和 HTTP 在后续阶段实现。

**验收标准：**

- 官方 SDK 测试客户端完成初始化、tools/list、八工具调用；名称、Schema、成功/失败封装及错误分类符合第 3～5 章。
- 未知参数、互斥条件、上下界、mode=pipe 被准确拒绝；terminal_list 单次返回全部过滤记录，不接受列表分页字段。
- Server stdout 只有 MCP 协议消息，子进程输出不污染协议；stdio EOF 触发会话清理。
- cwd 使用真实路径与目录边界，拒绝相邻前缀目录及符号链接逃逸，不调用全局 chdir。
- 审计能关联 Server 代际、会话、策略/状态/信号/退出事实，不记录 token/密钥，不作为会话或审批恢复输入；轮转及 I/O 失败行为可测。

**工作量：4～5 人日。** 主要风险是 Schema/SDK 结果一致性与协议 stdout 污染。此阶段仅允许可信本地开发联调，不对外暴露尚未完成策略的 Server。

### 15.3 阶段 ③：环境变量过滤 + 命令规则 + 审批 CLI

**产出：** 最小基础环境与覆盖白名单、allow/ask/deny 命令策略、规范化执行规格与稳定哈希、内存审批表、Unix domain socket 管理入口、`terminalctl approvals list/show/approve/deny`。不产生审批口令、验证文件、持久审批台账或 execution_state。

**验收标准：**

- 不继承 Server 完整环境；token/API Key/云认证不进入子进程，危险注入变量拒绝；硬限制不能批准绕过，deny 优先于 ask/allow。
- ask 不启动、不入队；CLI 展示足够的规格摘要并经本地 socket 批准/拒绝，目录 0700/socket 0600；MCP 入口没有批准工具，MCP token 不能作为本地批准凭证。
- argv、Shell 原文、真实 cwd、生效 env 摘要、PTY 尺寸、运行 UID/时限与 run 等待/页面预算绑定；write 绑定会话代际和准确输入，变更则 APPROVAL_MISMATCH。
- 两个并发获批重试只启动一次或入队一次，重复成功返回原关联结果；失败批准不重新执行，执行中记录不淘汰。
- 覆盖 pending/denied/expired/invalidated；Server 重启后审批列表为空，旧 ID 不执行，没有 EXECUTION_UNKNOWN 或口令失败限速测试。
- 文档/工具说明明确同 UID 进程可访问批准 socket 的局限，不把 CLI 确认当作强人类身份隔离。

**工作量：4～5 人日。** 主要风险是生效规格的稳定绑定，以及认领、执行回执与并发重试之间的竞态。

### 15.4 阶段 ④：Streamable HTTP + token + 接入 Manus

**产出：** 官方 SDK Streamable HTTP 传输、Bearer 单 token、Origin/请求大小/调用速率限制、与 stdio 共用的适配及会话内核、Manus 连接配置和真实联调记录。HTTP 默认 loopback；审批 socket 仍仅本地，不新增远程审批 API。

**验收标准：**

- HTTP 初始化、八工具调用、无/错 token、Origin 拒绝、请求过大与速率限制均通过；HTTP 重连仍共享当前 Server 代际和单所有者会话。
- read/wait 取消只移除等待者，run 启动后断线不重启、不直接终止；stdio 和 HTTP 不产生不同的业务契约。
- 使用安全可达入口把 Server 接入 Manus，真实完成启动 → read/wait → write → status → terminate 的最小交互闭环；批准需要本地主机 CLI，由人类执行。
- 记录 URL 连接方式、客户端和 Server 版本、成功调用证据，隐藏 token；不得用 Manus 自带终端能力补齐本 Server 缺失的工具行为。

**工作量：4～5 人日。** 外部账户、网络、安全入口或连接配置不可用时，记录“Manus 验收阻塞”；本地 HTTP 通过不等于本阶段真实接入已通过，也不等于 V1 完成。部署安全入口由用户提供，不包含自动公网/隧道配置开发。

### 15.5 阶段 ⑤：文档与演示

**产出：** README、配置示例、安装/构建/测试/启动命令、CLI 使用与审批边界说明、Linux 全量测试及 macOS 用户人工验收记录、五个端到端演示脚本与真实演示记录、依赖锁文件与交付清单。

**验收标准：**

- Linux 沙箱执行全部自动化测试及当前可用端到端场景；macOS 由用户按 README 执行 npm test 并手动验证第 13 章场景，作为最终人工验收。记录 OS/架构、UID、Node.js、node-pty、SDK/vitest 版本和命令，不靠跳过失败用例通过。
- MCP 调试客户端和 Manus 均完成闭环；五场景的启动、输入、读取与终止全部使用八个工具，本地人类 CLI 批准是唯一预期例外。
- 从干净检出按 README 可安装/构建/启动/回归；配置示例不含真实凭证；说明输出环形覆盖、布尔完整性、游标续等、进程组范围、同 UID 审批弱隔离、重启空状态与意外崩溃残留。
- 最终代码、Schema、配置、测试、演示与第 1～14 章一致；第 17 章的候选能力不进入 V1 完成条件。任何未完成的真实客户端验证明确列为未通过项。

**工作量：2～3 人日。** 假设各阶段已持续维护测试与文档，此阶段只做整体回归、复现和交付整理，不把全部测试编写拖至末尾。

## 16. 本次改动清单与工作量汇总

### 16.1 改动清单

| 项目 | 本次修订 | 现行章节 |
| --- | --- | --- |
| 1. 技术栈与目录 | 固定 TypeScript + 官方 @modelcontextprotocol/sdk + node-pty + vitest，补充目录与依赖锁定方式 | 2.1～2.2、3.1 |
| 2. 执行模式 | V1 仅 PTY，create/run 默认 PTY，mode/stream Schema 收窄，Pipe 分支及例子归档 | 1、4、5、6、14 |
| 3. 审批 | 删除独立口令、验证/失败限速、持久化与 EXECUTION_UNKNOWN；CLI 经本地 socket 操作 Server；内存绑定与单次消费/并发重试保护保留 | 8、9、11、13.5 |
| 4. 重启 | 不持久会话元数据、不核验旧进程身份；正常退出清理全部当前会话，重启空集合；lost/restart_cleanup 与相关旧错误归档 | 4、5、7.6、11、14 |
| 5. wait_for | literal/普通 RegExp 限长度/耗时，先历史后新增、调用内跨块；不禁用锚点/环视，不恢复跨 timeout 上下文，直接游标续等 | 5.8、10、14 |
| 6. 输出 | 仅每会话环形缓冲与游标过期恢复，无全局输出配额/淘汰；output_complete 为 boolean，既有 gap/output_gap 外部字段保留 | 4、5、6、10 |
| 7. 列表 | 删除 page_cursor/limit/next_page_cursor，保留过滤与稳定排序，单次返回完整当前快照 | 5.6 |
| 8. 测试 | Linux 沙箱主开发与全测（不用 Docker）；macOS 用户本机 npm test + 手动场景，逐阶段人工验收；测试非 root | 13～14 |
| 9. 实现阶段 | 新增五阶段产出、验收门禁、工作量与外部接入阻塞说明 | 15 |
| 10. 追溯与限制 | 所有替换/移出要求按主题保存到 docs/ARCHIVE.md；主文末只保留 17.1 表格 | 17、docs/ARCHIVE.md |

未改动的关键契约包括八工具名称、Success/Failure 封装、structuredContent 与兼容 JSON text、启动参数互斥、读游标不消费、write queued 与输入串行化、run 的同会话后台返回、根进程退出与输出结束分离、单所有者认证、规范化批准绑定、受管进程组范围及超时不等于进程终止。字段和语义的变化以本表及正文明确的收敛项为限。

### 16.2 工期汇总与估算边界

| 阶段 | 工作量（人日） |
| --- | ---: |
| ① 会话内核（不接 MCP） | 6～8 |
| ② MCP 适配 + stdio + cwd 白名单 + 审计 | 4～5 |
| ③ 环境过滤 + 命令规则 + 审批 CLI | 4～5 |
| ④ Streamable HTTP + token + Manus | 4～5 |
| ⑤ 文档与演示 | 2～3 |
| **合计** | **20～26** |

合计 **160～208 小时**，单人每周 5 个工作日约 **4～5.2 个工作周**。建议为 PTY 平台差异、SDK 接口适配及集成返工另留 **20% 缓冲**，对应总预算约 **24～32 人日**（缓冲计入总预算，不再叠加计算）。外部网络/账户/人类批准等待不在上述人日内，可能额外拉长日历时间。

前提：当前 Linux 沙箱可非 root 直接构建与全测，用户具有 macOS 本机以执行每阶段人工验收；可取得 Manus 连接权限和用户提供的安全网络入口；测试使用可重复 fixture，不依赖真实安装网络速度。测试、排错和阶段文档已含在各阶段，⑤ 不重复计算前四阶段已完成的工作。若开发者需现学 MCP、Unix PTY 或没有可用 macOS，需重新估算，而不是将未完成测试从验收中删掉。

## References

[1]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools "MCP Tools specification 2025-11-25"
[2]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle "MCP lifecycle and capability negotiation 2025-11-25"
[3]: https://github.com/microsoft/node-pty "Microsoft node-pty official implementation and security guidance"
[4]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports "MCP stdio and Streamable HTTP transports 2025-11-25"
[5]: https://man7.org/linux/man-pages/man7/pty.7.html "Linux pseudo-terminal manual"
[6]: https://man7.org/linux/man-pages/man2/setsid.2.html "Linux setsid manual"
[7]: https://man7.org/linux/man-pages/man2/waitpid.2.html "Linux wait and waitpid manual"
[8]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation "MCP cancellation specification 2025-11-25"

## 17. 后续版本与已知限制

**本章仅列后续版本候选与已知限制，不扩展 V1 验收范围。** 被替换条款的原文已移至 [docs/ARCHIVE.md](ARCHIVE.md)，其中旧字段、错误码和“必须”均非现行要求。

### 17.1 后续版本候选与 V1 已知限制

| 移出项 | 后续版本候选 | V1 已知限制与应对 |
| --- | --- | --- |
| Pipe 与 stdout/stderr 分流 | 独立 Pipe 后端、非交互默认值、Pipe 专用控制/排空测试 | V1 只有 PTY；run 默认 PTY，输出合并且可能回显、含颜色/回车；pipe 输入直接拒绝 |
| 独立审批口令、验证与失败认证限速 | 独立人类身份验证及凭证生命周期 | 仅靠本地 socket 用户权限；同 UID 进程可能绕过 CLI 确认调用批准，不能当强隔离 |
| 审批持久化、execution_state、EXECUTION_UNKNOWN | 可诊断的跨崩溃审批/执行台账 | 重启全部失效；只保证进程内一次消费，启动交界崩溃可能已执行；人工核查，不能盲重试 |
| 会话元数据持久化、lost、启动身份核验、重启清理 | 跨重启诊断与经平台核验的尽力清理；不等于 PTY 恢复 | 重启空列表，旧 ID 不存在；SIGKILL/崩溃可能留下进程，外部管理器或用户处置 |
| 受限正则禁用清单、跨超时上下文重建 | 如确有需求，再评审安全引擎与连续搜索 API | V1 普通 RegExp 限长度/耗时；锚点按当前窗口求值；直接游标续等可能漏掉跨 timeout 模式；显式较早游标可重扫保留日志 |
| 全局输出配额、全局淘汰、可空 output_complete | 全局资源预算与策略；三态完整性表达仅为历史候选，需重新评审 | 每会话环缓冲，可能丢旧日志；多会话/终态记录总占用需要配置控制；完整性未结束时 boolean=false |
| terminal_list 分页 | 在记录规模扩大后增加列表分页契约 | 一次返回至多 max_session_records 条；不保证跨调用快照 |
| 双平台扩大验证范围 | 更多 Linux 发行版/原生宿主测试和客户端兼容矩阵 | V1 Linux 沙箱直接全测，macOS 用户逐阶段人工验收；不等于任意系统版本已验证 |
