# 被移出条款原文存档

本文件保留修订前条款，仅供追溯，**不属于 V1 或阶段 ① 的实现与验收要求**。现行契约见《V1 开发规格书》。

### 17.2 被替换或移出条款的原文存档

下列摘录按主题保存，包含理解旧要求所需的原类型与上下文；它们不是当前 Schema。现行定义以第 4、5、10、11 章为准。

#### 17.2.1 普通正则与跨超时续等

````markdown
7. `terminal_wait_for`：等待输出满足字面量或受限正则条件。

---

字面量默认区分大小写，不接受 flags。正则只允许 i、s 标志，禁止重复或其他标志，采用安全受限引擎。V1 禁止回溯引用、环视、零宽断言和行/流锚点，包括 ^、$、\A、\z、\Z、\b、\B；同时拒绝可匹配空字符串的模式。这样不将临时块末尾误当成最终 EOF。普通分组、选择、字符类和受引擎支持的量词可用。

---

匹配在连续 UTF-8 文本视图上进行，先增量去除常见 SGR 颜色序列。匹配跨度最多为单一流的 64 KiB 原始数据，包含其控制序列开销。超出窗口的跨历史匹配不在保证范围。模式预算与扫描时间有硬限制，不能让编译或匹配阻塞整个 Server。

---

命中只表示当前已观察文本中存在合法的非空匹配，不等待未来输出形成所谓全局最长贪婪结果。多个流均命中时以采集位置最早的合法命中为准。

---

继续等待时，使用 scanned_cursor。Server 必须保留或重建必要后缀及原搜索边界；可在不透明游标中关联轻量匹配上下文。相同模式跨一次 timeout 边界仍应命中。更换模式视为从新扫描位置开始，不继承旧模式状态。

重建只依赖本运行期上下文和保留日志，不要求跨重启恢复。如所需前缀不可得，返回 output_gap，不静默丢弃。start 为 now 的首调用不得用调用前文本组成匹配，后续续等则保留这个搜索边界。

---

正在等待的匹配器可保留自己已经检查的有限状态，不要求锁住全部历史。但不能为了等待者无限保留日志；续等重建失败必须报告缺口。
````

#### 17.2.2 Pipe 执行模式

````markdown
支持 macOS 和 Linux。支持 PTY、Pipe 两种执行模式，支持多会话同时运行、有界日志存储、退出结果、尾部输出排空和正常退出清理。

---

       ├─ Output Store：事件、游标、分页、淘汰
       ├─ Wait Matcher：跨块匹配、历史扫描、续等
       └─ Process Backend：PTY/Pipe、信号、wait、drain

---

`seq` 表示采集事件顺序，不证明两个 Pipe 的真实写入时间顺序。同一事件拆分页时可复用 seq，但片段游标必须准确。跨页重组由游标位置决定，不靠 seq 唯一性。

---

create 默认 `mode: pty`，run 默认 `mode: pipe`。PTY 默认 100 列、30 行，cols/rows 为 1～500 的整数。Pipe 模式禁止提供 cols/rows，而不是静默忽略。

---

PTY 的 CTRL_C 向终端发送控制字符，按终端当前行规程作用于前台进程；程序可改变行为。Pipe 模式提供 key 时返回 `UNSUPPORTED_OPERATION`，不把控制字节等同于信号。[5]

---

stream 默认 all。PTY 只允许 pty/all，Pipe 只允许 stdout/stderr/all。all 是分别检查每一条流，绝不拼接 stdout 与 stderr 形成模式。

---

  "mode": "pipe",

---

每个会话有持续采集器。即使没有 read/wait 调用，仍消费 PTY master 或两个 Pipe，避免内核缓冲区满后阻塞子进程。

---

PTY 只有合并流 pty，不能按颜色或文本内容推断 stderr。Pipe 可以保留两个来源，但事件序号只是采集顺序。[5]

---

必须测试 root exit 与 output EOF 不同步、继承 Pipe 的后代使 drain 截止、采集错误、并发 write/terminate、运行超时、空闲清理和等待者超限。
````

#### 17.2.3 技术栈与平台验收旧要求

````markdown
开发语言不锁定。可使用成熟 MCP SDK 与 PTY 库，但必须在 macOS/Linux 分别测试进程组、控制终端、信号和退出语义。若采用 node-pty，不得跨多个 worker thread 不安全地共享实例。[3]

---

本规格中的 TypeScript 类型是语言无关的数据结构定义，不要求使用 TypeScript 实现。开发时必须据此生成或编写等价 JSON Schema；本文给出的所有默认值、范围和条件约束也须落实到校验中。

---

至少在 macOS 和 Linux 各执行核心测试并给出环境记录。必须用一个 MCP 调试客户端和至少一个真实 Agent 客户端完成交互闭环。若某客户端因网络或配置限制未完成，明确记录，不宣称已验证。
````

#### 17.2.4 旧状态与 Pipe 数据模型

````markdown
  | "spawn_failed"
  | "lost";

type Mode = "pty" | "pipe";
type Stream = "pty" | "stdout" | "stderr";
````

#### 17.2.5 重启元数据、lost 与身份核验

````markdown
  | "server_shutdown"
  | "restart_cleanup"
  | null;

---

`exited` 表示根进程退出已被确认，不保证输出已排空。非零退出码仍属于 `exited`。`spawn_failed` 表示启动阶段已确认失败。`lost` 表示 Server 已不能可靠控制旧会话，不伪造退出结果。

---

`group_cleared` 只表示受管组范围已清理，不等于没有逃逸后代。PID、PGID 和平台身份核验信息保存在内部，不要求 Agent 使用，也不列为对外必返字段。

---

对 lost 记录仍可查询元数据，退出结果未知时为 null，日志不可用时 log_available 为 false、日志游标为 null。记录超过保留期已删除后返回 `SESSION_NOT_FOUND`。

---

对于活跃会话，标记 stopping、拒绝新输入，向核实的受管进程组发送 SIGTERM，宽限后仍存活才发送 SIGKILL。grace_ms 为 0 表示不等待宽限；必要时立即升级。

---

重复终止不重复创建清理任务。已经退出且受管清理结束时返回现有结果。lost 会话只返回已有核验与清理结果，不接受调用方提供 PID，也不盲目发信号。

---

旧活跃记录在重启后 → lost
终态记录超过保留期限 → 删除

---

根进程退出后，仍留在受管组内的后代不作为无限后台服务保留；对能够核实归属的残留组执行清理。其他新进程组或守护化后代属于本版限制。

---

对受管进程组执行 TERM、宽限、KILL，并回收 Server 可等待的子进程。必须记录清理结果，失败或身份不确定不能返回 group_cleared。

---

### 7.6 重启后只标记 lost，不恢复交互

持久化最小元数据，包括 session_id、server_epoch、状态、创建时间、PID/PGID、运行 UID 及平台可复核的进程启动身份。文件使用受限权限和原子替换，不能记录审批口令或环境密钥。

意外重启时，旧 starting/running/stopping 记录，以及尚未结束采集的记录标为 lost。旧审批失效，等待上下文废止，不尝试接管原 PTY。

此前已经完全退出的记录可以保留退出结果；没有持久日志时 log_available 为 false。对 lost 的 read/wait/write 返回 SESSION_LOST；status/list 仍可查看诊断。对已退出但日志未持久化的记录，read 返回 OUTPUT_UNAVAILABLE。

启动清理仅针对能够核实仍属旧受管组的实体。Linux 可使用 boot 身份、UID、进程启动时间与 PGID 交叉核验；macOS 使用其平台进程启动身份、UID 和 PGID 的等价证据。必须分别实现和测试，不退化为仅检查进程名或 PID 存活。

如果根进程已消失、证据不足、PID 已复用，或记录损坏，则 cleanup_result 为 unverified 并提示人工处置，不能盲杀旧 PGID。核验和发信号也不是对抗恶意并发的强原子边界，本版本只作尽力清理。

未知退出码保持 null。保存 PID 或 PTY 路径不构成活跃会话恢复能力；新 Server 通常不能任意 wait 非自身子进程。[7]



---

**会话与输出。** SESSION_NOT_FOUND、SESSION_NOT_RUNNING、SESSION_LOST、OUTPUT_UNAVAILABLE、CURSOR_EXPIRED。CURSOR_EXPIRED 必须给 earliest_cursor；是否跳过由调用方明确决定。

---

必须测试正常 Server 退出清理，以及意外重启：旧活跃记录为 lost；日志不可用如实表达；PID 复用或身份不足不盲杀；旧审批不可继续使用。

---

完成交付包括源码、依赖锁定、安装启动说明、配置示例、八个 Schema、CLI、测试 fixture 与自动化结果，以及五场景演示步骤。README 明确安全定位、进程组范围、日志淘汰、RPC 重试风险和 lost 处理。
````

#### 17.2.6 输出存储与完整性旧要求

````markdown
  output_complete: boolean | null;

---

`output_complete` 在采集尚未最终结束时为 null。自然读取至 EOF 并排空后为 true；读取错误、drain 超时或主动提前关闭时为 false。它只表示采集完整性，不表示历史日志仍全部保留。

---

V1 使用有界内存日志，完整磁盘转录非必需。每会话及全局均有容量上限，达到时淘汰最旧记录并更新 earliest_cursor、log_has_gaps。

---

达到全局日志配额时淘汰全局最旧可淘汰日志，仍须让受影响会话明确报告缺口。不能停止读取子进程输出来无限等待客户端。

---

  "total_output_bytes": 67108864,


---

日志配额超限淘汰并标记缺口，不自动杀正常任务。输入配额超限在入队前拒绝。运行/空闲超时才进入终止流程。
````

#### 17.2.7 terminal_list 分页

````markdown
  page_cursor?: string;
  limit?: number;
  statuses?: SessionStatus[];

---

  sessions: SessionSummary[];
  next_page_cursor: string | null;

---

limit 默认 20，范围 1～100。statuses 和 label 为可选过滤条件，label 精确匹配。第一页省略 page_cursor；后续使用 next_page_cursor，并保持相同过滤条件。

---

按 created_at 加 session_id 稳定排序。分页游标记录查询范围与排序位置，不能混用输出游标。并发新增和淘汰可以导致列表变化，但同一次分页扫描不得重复返回同一记录；新记录可留给下一次扫描。
````

#### 17.2.8 独立审批口令与失败认证限速

````markdown
### 8.2 本地 CLI 与独立人类认证

CLI 必须提供：

```bash
terminalctl approvals list
terminalctl approvals show <approval_id>
terminalctl approvals approve <approval_id>
terminalctl approvals deny <approval_id>
```

首次配置通过可信本地交互流程设置独立审批口令，保存加盐的口令验证值，不保存明文。approve/deny 在本地终端安全读取口令，不通过命令行参数或环境变量传递；approve 还展示请求并要求明确确认。V1 不提供绕过确认的无人值守批准参数。

CLI 经本地 Unix domain socket 访问管理入口。socket 与状态目录权限限定为运行用户，验证本机访问权限；管理入口不挂到公网 MCP 路径，也不接受 MCP token 作为批准凭证。

实际认证与状态更新由 Server 完成，不由 CLI 自行修改审批 JSON。失败认证有次数和速率限制，错误不泄露口令或验证值。

不提供 approval_approve MCP Tool。MCP token 可以借原请求得到审批状态，但没有批准权限。申请 ID是标识，不是授权凭证。

同 UID 的本机进程可能访问文件或尝试调用 socket，故还需要独立人类口令。即使如此，也不声称抵抗拥有同 UID 任意代码执行的恶意进程；本版不具备强 OS 隔离。[3]



---

默认不向子进程传入 MCP token、审批口令及验证值、API Key、云服务认证环境。危险启动或动态库注入变量默认禁止覆盖，例如 LD_PRELOAD、DYLD_INSERT_LIBRARIES、BASH_ENV。

---

ask 时核实尚未创建进程或入队。用户通过本地 CLI 验证口令并批准，Agent 携原参数重试才执行。测试未批准、过期、拒绝、参数变化、跨会话 write 审批与重启失效。
````

#### 17.2.9 审批持久化与 EXECUTION_UNKNOWN

````markdown
### 8.4 状态、单次消费与并发

```text
pending → approved → consumed
        → denied
pending / approved → expired
Server 重启 → 旧审批失效
```

记录另有 execution_state：not_started、starting、started、completed、unknown、failed，以及可选关联 session_id/write_id。

获批请求在执行前独占认领，先持久登记 consumed 与 starting，再启动或入队，并登记结果。两个并发重试只能一个发起执行。

已关联成功创建的会话时，相同审批重试返回该原会话的当前结果，不重新启动。write 的相同审批重试返回此前入队回执，不再入队。这是审批局部的一次消费保护，不扩展为所有请求的通用去重。

已消费但无可核实结果时返回 EXECUTION_UNKNOWN，不自动再次执行。已拒绝、过期、参数不匹配、重启失效均不能产生新执行。

在审批持久化、进程启动或写入交界处崩溃，无法证明副作用未发生时必须保守标为 unknown。数据库事务不能使外部进程启动天然原子化；V1 不承诺跨崩溃恰好一次。



---

审计与状态目录权限受限，采用有配额的轮转策略，不因审计无限增长占满磁盘。不得记录口令、MCP token 或其可复用凭证。

---

**配额与存储。** QUOTA_EXCEEDED、INPUT_QUEUE_FULL、STORAGE_UNAVAILABLE。写队列满可在确认未入队后重试；状态或审批无法可靠持久化时不得执行需要该记录保护的副作用。

---

**未知副作用。** EXECUTION_UNKNOWN、INPUT_DELIVERY_UNKNOWN。不得自动重试启动或输入，应核查已有会话和审计，必要时由用户决定新操作。

---

两个并发获批重试只能产生一个启动或一份输入。重复成功审批请求返回原关联结果，不再执行。启动交界崩溃返回 unknown，不自动重启命令。
````


## 2026-10-25：被替换的测试平台要求

Linux Docker 核心测试与 macOS 主开发/全量测试要求被替换。现行要求：Linux 沙箱直接全量测试；macOS 用户每阶段人工验收。旧目录中的 docker/Dockerfile.test 与 scripts/test-linux.sh 不再要求交付。
