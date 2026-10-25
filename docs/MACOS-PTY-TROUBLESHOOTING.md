# macOS PTY 启动问题与重验

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
