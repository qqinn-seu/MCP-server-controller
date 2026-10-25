# macOS PTY 启动问题与重验

当前最新版签收标准为10个文件、80/80通过；下文68/71是历史补丁时的数量，请以末尾第三轮修复与验收步骤为准。

2026-10-25 收到的 macOS ARM64 验收结果为：46/63 通过，17/63 失败。失败都集中在真实 PTY 创建，统一报 `SPAWN_FAILED: posix_spawnp failed`；demo 与 ps 脚本也在第一次创建时失败。因此本轮 macOS 验收**未通过**，不能仅凭关闭后的空列表或五个测试文件通过就签收。

## 已确认的打包问题

本项目实际安装的固定 `node-pty@1.1.0` 包中，`prebuilds/darwin-arm64/spawn-helper` 与 `prebuilds/darwin-x64/spawn-helper` 都是模式 `644`，没有执行位。该版本 `src/unix/pty.cc` 的 Darwin 分支把 helper 路径放入 `argv[0]`，通过 `pty_posix_spawn` 启动；失败后统一抛出 `posix_spawnp failed`。这解释了为什么 Shell、Python、sleep 等不同程序都同时无法启动。

这是已确认的发布包缺陷，也是当前日志最直接的排查方向；用户本机 helper 的实际模式与重跑结果仍需确认。不能仅由这条通用错误证明所有其他平台因素都已排除。

新增 `scripts/prepare-pty.mjs`，只针对当前 Node 平台/架构以及该固定版本的候选 helper 添加 **owner execute**。例如 `644 → 744`，不修改二进制内容，不增加读写权限，不修改其他架构文件，不使用 sudo，不解除 root 拒绝策略。已有正确执行位的文件保持原样。Linux 直接跳过，不改任何权限。

安装的 postinstall、测试、demo 与 ps 验收命令均接入该准备步骤；也可手动执行 `npm run prepare:pty`。这是安装准备修复，不更换 node-pty、不引入其他终端后端、不改变八工具契约或阶段范围。

## 你现在执行的命令

在已有仓库目录执行，不需要重新克隆或先重装依赖：

```bash
cd ~/MCP-server-controller
git pull --ff-only origin phase-1/session-kernel
npm run prepare:pty
npm test
```

如果准备步骤找到了预构建 helper，首次应显示类似：

```text
[pty-prepare] checked 1 helper(s), added owner execute to 1
```

已有正确权限或第二次运行显示 `added owner execute to 0` 是正常的。测试现在含 5 个新增安装准备用例，完整通过标准变为 **8 个文件、68/68 通过，0 失败、0 跳过**。不能靠跳过真实 PTY 测试签收。

只有测试全过之后再执行：

```bash
npm run demo
npm run evidence:ps
```

重新检查 demo 的实际 matched/background/exit_code 结果，并确认 ps 最后出现 `REMAINING_TRACKED_ROWS=0 TRACKED_ZOMBIES=0`。之前 ps 脚本在创建阶段就异常退出，其日志不构成进程清理成功证据。

本次 Linux 沙箱已完成 68/68 自动化回归，包括现有真实 PTY 测试和新增权限准备的确定性单测。**没有在沙箱中运行 macOS Mach-O 程序，也未把这些单测冒充 macOS 已修复。**

## 如果仍失败

请回传准备步骤和第一个失败用例的完整输出，并执行以下只读检查：

```bash
node --version
node -p 'process.platform + "-" + process.arch'
id -u
python3 --version
xcode-select -p
ls -l node_modules/node-pty/prebuilds/darwin-*/spawn-helper
```

你当前日志使用 Node 26.11.1，满足所用 vitest 的 engines，不能直接断言 Node 26 是此次错误根因。为了与开发基线对齐，使用 nvm 的用户可另行执行 `nvm install && nvm use`，切到仓库的 22.13.0；若换版本后需要重新安装，再执行 `npm ci`。不要全局卸载 Node，不要用 sudo npm test，也不要关闭系统安全机制。

npm 的 install-scripts 警告值得保留，但仅凭“尚未 covered by allowScripts”不能认定安装脚本已被禁止；该版本自身的 prebuild/post-install 脚本也没有修复 Darwin helper 执行位。若准备步骤反而报原生模块缺失，再根据具体安装日志处理所需的依赖脚本或原生构建，不要一概放开所有安装脚本。

## 第二轮：立即终止压力测试仍失败

第二轮 macOS 结果为 67/68 通过：正常 PTY、REPL、向导、TERM/KILL、Ctrl-C、组内子进程清理以及宿主退出均已通过，说明辅助程序权限补丁已经生效。仍有一次 `IMMEDIATE-TERMINATE` 返回 `cleanup_result=failed`，因此阶段①仍不能验收通过。

原失败信息只有“expected failed to be group_cleared”，没有底层错误码。当前只能确定 `startCleanup` 捕获了异常，不能直接断言是权限、信号发送或存活探测。此轮提供的是**诊断补丁，不是已经证实解决该清理失败的功能补丁**：保留原 TERM→KILL、建组等待与根/组均消失才报告清空的语义，不吞 EPERM，不放宽断言，不跳过 macOS。

诊断补丁会在内存 `cleanup_error` 事实回调记录 `code`、`errno`、`syscall`、`operation`、`phase`、`attempted_signal`、PID/PGID 与是否观察到根退出。没有新增磁盘审计、持久化或重启进程身份核验。压力测试失败时输出 `IMMEDIATE_TERMINATE_DIAGNOSTIC=` JSON，附上本次受管 PID/PGID 的只读 ps 行。harness 清理阶段的错误另行输出，避免覆盖最初的诊断。未枚举或清理逃逸后代。

请在 macOS 本机运行：

```bash
cd ~/MCP-server-controller
git pull --ff-only origin phase-1/session-kernel
npm test -- tests/integration/pty.test.ts
```

请回传 `IMMEDIATE_TERMINATE_DIAGNOSTIC=` 所在的完整行和错误堆栈，包括其中的 `cleanup_error.details`、`process_rows`。若出现 `HARNESS_ROOT_PROBE` 或 `HARNESS_KILL` 也一并保留。不能把 test finally 中的手动收尾当作核心已清理成功。

这条命令定位运行整个 PTY 文件的16个用例，不是完整签收。如果暂时16/16全通过，也请回传结果，不以一次偶然通过关闭先前出现的竞态问题。最终仍需要全量 `npm test`、demo和ps证据，并由用户确认人工验收。

为验证诊断不吞掉权限失败，本轮新增3个确定性用例，分别模拟组探测、根探测和TERM发送的EPERM。Linux当前全量为**9个文件、71/71通过**；macOS签收标准也相应变为71/71，仍待重验。现有256次立即终止循环、每次根/组消失断言以及时限保持不变。

## 第三轮：确认终止信号成功后的 EPERM 探测竞态

第三轮诊断明确：同一会话的 SIGTERM、SIGKILL 均成功返回，随后 `phase=final_wait` 的 `operation=probe_group` 抛出 `kill EPERM`；稍后针对该 PID/PGID 的 ps 快照没有任何行，根退出回调当时尚未到达。问题位于“终止后的消失确认”，不是此前的 helper 启动权限，也不是实际信号发送失败。

本轮实现已针对该竞态修复：本次清理至少一个终止信号成功返回后，才允许对 `kill(...,0)` 的 EPERM 做有限只读重试。EPERM始终表示当前不能确认，不返回不存在。每次重试重新采样组和根的完整布尔快照，不短路、不沿用重试前的旧false。只有两者明确不存在才报告group_cleared。

截止时间只在首次成功终止信号返回时创建：TERM成功为当时的单调时间加grace、drain_timeout_ms与500ms；若TERM为ESRCH、首次成功的是KILL，则使用KILL返回时间加drain_timeout_ms与500ms。重试不会刷新或延长截止时间，重试期间不再次发送TERM/KILL。实际信号EPERM、其他探测错误，以及信号成功前的权限错误仍立即failed；持续的终止后EPERM在截止时间后failed，不能用ps空行或SDK回调代替两个探测的确认。

新增9个确定性用例覆盖瞬时组/根拒绝、根仍存在时不得早清空、持续拒绝有界失败、实际KILL错误不重发、未知错误不重试、完整重采样、组仍存在时根权限拒绝、迟到退出回调与首次KILL成功的路径。当前Linux全量**10个文件、80/80通过，连续三轮通过**；每轮真实立即终止256次通过，回归后未发现fixture或僵尸行。macOS仍需用户本机验证，不能用这些Linux结果代替签收。

当前最新 macOS 验收步骤：

```bash
cd ~/MCP-server-controller
git pull --ff-only origin phase-1/session-kernel
npm test
# 请按同样命令连续完成三轮，不以一次偶然通过签收。
npm run demo
npm run evidence:ps
```

三轮每次都应为10个测试文件、80/80通过，并显示 `IMMEDIATE_TERMINATE_SUMMARY` 的 `cleared_iterations:256`。`deferred_probe_events` 大于0说明确实遇到并等待了受限探测，不等于失败；为0也正常，它是事件数，不是全部系统调用重试次数。demo应全部符合README预期，ps最终为`REMAINING_TRACKED_ROWS=0 TRACKED_ZOMBIES=0`。

若再失败，请保留完整的IMMEDIATE_TERMINATE_DIAGNOSTIC行。新诊断保留cleanup_probe_retry事件，以区分持续权限拒绝、其他阶段的真实失败与重试后重新采样的结果。若git pull因本机证据文件被修改而拒绝更新，请保留本机结果，不要hard reset或删除证据，回传Git报错再处理。
