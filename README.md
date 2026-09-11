# Team DevSpace

让一个共享的 ChatGPT 工作空间 App，按员工的 Access Key 连接到各自电脑上的官方 DevSpace。

Team DevSpace 不修改个人 DevSpace，不替换 `devspace.568920429.xyz`，也不维护 DevSpace fork。云端使用单独的 `team-devspace.568920429.xyz`。本地将官方 DevSpace 与认证适配放在同一个 Node 进程，另由 `cloudflared` 提供出站连接；Windows/macOS 的极薄原生托盘只转发控制事件，不是 supervisor 或事实源。管理员页面由同一个 Gateway Worker 提供，不增加第二个 Worker、数据库或登录系统。

**发布状态与真实验收范围见 [验证记录](docs/verification.md)。生成安装包、通过本地测试，不等于已经完成 Cloudflare、ChatGPT 和 macOS 实机验收。**

## 工作方式

```text
ChatGPT 工作空间 App + 员工 Access Key
                  |
        Cloudflare Worker + D1
                  |
      Access Key -> Device Binding
                  |
        该设备专属 Cloudflare Tunnel
                  |
        本机认证适配 -> 官方 DevSpace
```

一个 Access Key 只绑定一个 Device，允许多个 ChatGPT 会话。Gateway 不相信模型传入的设备标识，不会在设备离线时转发到别人电脑。同一台电脑的修复安装保留绑定；换电脑由管理员重置；凭据泄露时撤销旧 Key 并签发新 Key，而不是只重置绑定。

## 固定版本

| 组件 | 版本 |
| --- | --- |
| Team DevSpace | 0.2.1 |
| 官方 DevSpace | 1.0.8 |
| Node.js | 22.23.0 |
| cloudflared | 2026.8.3 |
| Windows Git/Bash 后备环境 | Git for Windows 2.55.0.windows.5 |
| Windows 安装器 | NSIS 3.12 |
| Windows 原生托盘 | tray-icon 0.24.2 / Rust 1.85.1 |
| macOS 原生界面 | 系统 AppKit / Foundation，单文件 Swift，无第三方 UI 依赖 |
| Admin CSS | Pico CSS 2.1.1 |

构建固定使用 npm 11.19.1，避免上游发布的旧 shrinkwrap 绕过安全补丁覆盖；只允许已审核、精确版本的依赖安装脚本。官方 DevSpace 代码保持原样，下游 `undici`、`brace-expansion` 和 `protobufjs` 使用已修补的锁定版本。包管理锁文件和二进制 SHA-256 固定实际输入。员工端不执行 `npm update`；升级使用经过重新验证的 Team DevSpace 安装包。二进制来源和校验值见 `scripts/binaries.json`，安装包内附组件说明、SBOM 和构建来源记录。

## 管理员首次部署

在本仓库目录运行：

```sh
npx --yes npm@11.19.1 ci --no-fund --no-audit
npm run configure
npm run deploy
```

`configure` 使用本机终端的隐藏输入，保存到私有、Git 忽略的 `.runtime/cloudflare.json`。不要把任何令牌粘贴到聊天、Issue 或仓库。所需 Cloudflare 账号、区域与权限见 [部署说明](docs/deployment.md)。此脚本不购买套餐，也不修改现有个人域名的 DNS 或 Worker。

`deploy` 先确认或创建项目拥有的 Cloudflare Access `/admin*` Application 与管理员邮箱 allow policy，再准备 D1、应用迁移，将静态资源与 Gateway/Secret 部署到同一个 Worker。Access 配置失败时不会上传含管理页的 Worker；部署后还会从未认证视角确认 `/admin` 被 challenge/deny。重复执行只复用 `deployment.config.json` 明确记录的项目资源；部署失败时尝试恢复已记录的 Worker 版本和旧资源路由，但不会自动回滚 D1 迁移。管理员令牌与加密主密钥首次生成后保存在 `.runtime/admin.json`，再次部署必须保留该文件，否则现有设备密文将无法解密。

仅验证构建、不访问或修改 Cloudflare：

```sh
npm run deploy -- --dry-run
```

### 员工凭据管理

管理员可在通过 Cloudflare Access 登录后打开 `https://team-devspace.568920429.xyz/admin`。页面与下列 CLI 共用同一个 Admin Service：浏览器本地用 Web Crypto 生成 Access Key，只把 `id`、`label` 和 SHA-256 发给 Worker；明文仅在当前 `sessionStorage` 中保留到管理员确认已复制。网络失败时使用同一 credential 重试。

```sh
npm run admin -- key create "张三-Windows" --output zhangsan.json
npm run admin -- key list
npm run admin -- key revoke "张三-Windows"
npm run admin -- device reset "张三-Windows"
```

CLI 默认使用本仓库部署生成的 `.runtime/admin.json`；如果本机还保留旧的 `~/.team-devspace-admin/config.json`，会自动回退读取，不需要每条命令重复传 `--config`。显式 `--config` / `TEAM_DEVSPACE_ADMIN_CONFIG` 只保留给自动化或特殊环境覆盖。相对 `--output` 路径会写入当前管理员配置所在的私有目录；控制台只输出文件位置。创建请求可重试，不会因网络超时丢失第一次签发的 Key。重复使用一个已有标签返回同一签发记录；已撤销标签不能重新激活，应为新凭据使用新标签。

撤销先在数据库拒绝后续访问，再禁用隧道入口、断开连接并删除隧道。Cloudflare 清理失败时保持拒绝访问并返回 `cleanup_pending`，重复同一命令完成清理，不会假报撤销全部成功。

### ChatGPT 工作空间 App

管理员单独发布 **Team DevSpace**，地址使用新 Gateway 的 `/mcp`，不要编辑原个人 DevSpace App。按工作空间现有的“访问令牌或 API 密钥”连接机制，将**每位连接者自己的** Access Key 作为 `Authorization: Bearer ...` 发送。

必须在真实工作空间验证每名员工的凭据分别传递；不能把管理员 Key 写成所有用户共用的静态请求头。只有真正的 ChatGPT 工具调用通过后才能关闭接入验收项，远程 MCP SDK 测试不能代替这一项。

## 员工安装和使用

管理员先完成云端部署，再按平台取得安装包并分发对应员工的 Access Key。Windows/Linux 只在对应原生主机本地打包，不再走 GitHub Actions；macOS arm64 由根目录 `codemagic.yaml` 的 Codemagic M2 workflow 手动构建。当前构建产物可直接由管理员下载后分发，private GitHub Release 仅作为可选的固定版本归档/交付位置。发行目录和离线布局见 [客户端发行模型](docs/distribution.md)。

**Windows x64：**管理员分发 `Team-DevSpace-0.2.1-windows-x64.zip`。员工解压后，首次先运行 `Trust-Team-DevSpace-Internal-Publisher.ps1` 为当前 Windows 用户信任随包附带的固定内部发布者证书，再运行单个自包含 `Team-DevSpace-0.2.1-windows-x64-setup.exe`，输入 Key、选择项目目录。EXE 内已包含固定 manifest、Node、DevSpace runtime、cloudflared 和按需 PortableGit fallback，不再依赖同目录 `objects` 或持久 payload cache；PortableGit 只在系统 Git 不可用时展开。程序使用 `%LOCALAPPDATA%\TDS` 的短 A/B 版本槽完成本地原子切换，Enrollment/配置独立保存在 `%LOCALAPPDATA%\TeamDevSpace`。本地程序安装成功后才进行首次 Enrollment；Access Key、Gateway、DNS 或 Tunnel 暂时失败只进入“连接待完成/Offline”，不会把已验证的本地安装回滚。已有 Binding 的覆盖升级直接复用原 Enrollment，不再次调用 `/v1/enroll`。

**macOS：**使用 Apple Silicon (`arm64`) 自包含 `.pkg`，最低支持 macOS 12.0 Monterey，包内已包含离线 runtime 组件。当前 Codemagic 走 `internal-free` unsigned/unnotarized 路径，不要求 Apple 付费凭据；workflow 只做原生打包、release layout 校验和 Mach-O/最低系统版本检查，不执行系统级 `.pkg` 安装事务。管理员下载 Codemagic 产物并核对随包 SHA-256，再交给同事真机安装验收；unsigned 包首次安装若被 Gatekeeper 拦截，使用系统“隐私与安全性”中的“仍要打开”，不要关闭整机 Gatekeeper。安装完成后 PKG 会自动打开 Team DevSpace，并通过用户状态目录中的启动标记确认 App 确实进入了首启脚本；如果 LaunchServices/Gatekeeper 导致自动首启没有真正发生，会直接向当前登录用户显示恢复指引，而不是静默显示“安装成功”。首次打开完成本地校验和解压后，在同一个 AppKit 窗口输入 Access Key、选择项目目录，并显示验证、错误、重试和完成状态，不下载 runtime；绑定失败时保留已产生的待配置状态与菜单栏入口，用户取消设置不作为安装失败。日常操作使用原生菜单栏与系统单色图标，不弹常规成功通知，设置窗口仍复用 Node 中的验证和生命周期逻辑。

**Linux x64：**当前包要求 `x86_64`、glibc 2.34+ 和可用的 systemd user manager。Linux 当前不走 GitHub Actions；需要时在原生 Linux x64 主机执行 `npm run package`，取得 `Team-DevSpace-<version>-linux-x64-offline.tar.gz` 与对应 SHA-256。校验并解压后，以员工本人运行 `install.sh`，不要 `sudo`。安装器会写入稳定的 `~/.local/bin/team-devspace` 入口；首次安装若尚未 Enrollment，再执行 `team-devspace setup --credential-file <employee-key.json> --root <project-directory>`。已有 Binding 的覆盖升级只需重新运行新版 `install.sh`，安装器会复用现有 Enrollment、刷新固定 systemd user units，并让服务始终通过 `active-path` 解析当前版本。

内部发行仍可能触发 Windows SmartScreen 或 macOS Gatekeeper 的额外确认；只对管理员提供、SHA-256 已核对的固定版本包建立例外，不要关闭整机安全功能。

安装成功后，员工在 ChatGPT 连接共享 App，输入同一个 Access Key 即可。状态检查只报告可观测到的本地/网关健康状态，不会伪造“ChatGPT 已连接”。

Windows/macOS 登录后显示统一的系统托盘/菜单栏入口，可检查真实状态、暂停/恢复远程访问、更换当前项目目录、重启、打开日志和复制脱敏诊断。项目目录使用本机系统目录选择器，不做 Windows/macOS/Linux 路径猜测或映射。退出托盘不会停止 runtime/tunnel；托盘崩溃也不改变远程访问状态。Linux 使用稳定 CLI + systemd user service，不额外引入托盘或 supervisor。Windows 开始菜单仍提供 **Status**、**Repair connection** 和卸载入口；macOS/Linux 使用 `team-devspace`：

```sh
team-devspace status
team-devspace stop
team-devspace start
team-devspace restart
team-devspace suspend
team-devspace resume
team-devspace diagnostics
team-devspace logs
team-devspace logs --follow   # Linux: journalctl --user
team-devspace project-root show
team-devspace project-root set <绝对项目目录>
```

修改目录会重启本机 runtime，现有 MCP 会话需要重新连接。停止 runtime 会终止它管理的子进程，因此不要在仍需保留的开发命令运行中执行停止、升级或卸载。

### 权限边界

**Current Project Root 约束工作区及文件工具，不是 Shell 沙箱。** Team DevSpace 产品层只暴露一个当前项目目录；upstream DevSpace 内部仍使用 `allowedRoots: [currentProjectRoot]`。Shell 以员工自己的系统账户执行，能访问该账户本来有权访问的资源。不要把“选择了项目目录”误解为强制隔离整机；取得 Access Key 的人能远程调用这些开发能力。

本地 Owner Token、设备 Secret、Tunnel Token 与员工 Access Key 不同。私有状态使用当前用户权限保护；Windows runtime 只绑定 loopback。云端只持久化路由、凭据摘要、加密后的设备 Secret 与运行元数据，不记录 MCP body、源码、Prompt 或 Shell 内容。

### 升级和卸载

重新运行明确版本的完整离线安装包，先取得并验证候选版本，再切换 active slot。失败时保留当前版本；成功激活后清理旧解压版本和当前 manifest 不再引用的缓存。没有长期保留的手动回滚槽，需要退回时由管理员重新分发旧版本安装包。私有状态位于应用目录以外：

- Windows：`%LOCALAPPDATA%\TeamDevSpace`
- macOS：`~/Library/Application Support/TeamDevSpace`
- Linux：`${XDG_STATE_HOME:-~/.local/state}/team-devspace`

修复和升级保留 Key、Device Binding、Current Project Root，**不需要重新认证或重新输入 Access Key**。管理员执行 Reset 后，原设备或新设备都可用同一个 Key 重新 Enrollment；Revoke 后则需要管理员重新发放。若升级前远程访问已暂停，不会暗中启动 runtime/tunnel 或把 Gateway 改回 active；Linux 保留已安装但 disabled 的固定 user units，恢复时只重新 enable/start。卸载停止并移除用户登录启动项，**保留 Enrollment 和项目文件**；退休或丢失的设备仍需管理员撤销 Key。

macOS 卸载执行一次 `team-devspace uninstall`：它先停止/移除用户 LaunchAgent，再通过 macOS 原生管理员授权删除包拥有的 App、命令入口和安装 receipt；Enrollment 与员工项目不会删除。Windows 使用系统卸载入口。高级隔离测试可通过 `TEAM_DEVSPACE_HOME` 或 CLI `--home` 指定独立状态目录，但不要复用他人的状态文件。

## 开发、验证、构建

```sh
npm run check
npm test
npm run deploy -- --dry-run
npm run package
npm run build:tray
npm run test:tray
npm run test:native
```

`package` 必须在目标系统/CPU 原生构建，不能跨平台复制 SQLite/PTY 模块。输出包含固定版本的离线布局 `release/offline/<version>/<target>`；员工安装只使用管理员提供的完整离线包，不从远端拉取 runtime。再次本地构建可使用 `npm run package -- --reuse-dependencies`，只复用指纹匹配的依赖树，不复用生成目录。构建器优先复用启动它且版本完全匹配 `packageManager` 的 npm，避免 hosted macOS 为取得 npm CLI 再完整安装一次仓库依赖；本地全局 npm 版本不匹配时仍可回退到仓库锁定的 npm devDependency。构建后自动清理解压/组装中间文件；所有平台的员工 runtime archive 都排除 source map 与 TypeScript 声明文件，并且不携带构建用 npm 和 lock/.npmrc。

`test:tray` 在当前 Windows/macOS 桌面实际启动 native helper、通过 JSON-lines 切换状态并正常退出。Windows Rust helper 使用 `cargo build --locked`，构建还检查 PE 必须是原生 x64 GUI 子系统；macOS helper 使用系统 `xcrun swiftc`，额外验收菜单事件、错误输入拒绝、表单单实例、错误后原地重试与正常关闭。macOS 构建中的 `--self-test` 不要求 GUI，但不替代桌面验收。`test:native` 使用临时状态和原生用户启动项验证实际安装载荷、认证 MCP 调用、停止、重启与清理，不启动公网 Tunnel，不访问现有个人 DevSpace；这些深度验收保留为本地/人工诊断，不进入当前 Codemagic 快速打包路径。Windows 计划任务以当前用户的 `InteractiveToken` 直接运行预编译的 `tds-launcher.exe`；launcher 通过 `CREATE_NO_WINDOW` 启动 Node/cloudflared/托盘控制器、重定向日志，并以 kill-on-close Job Object 清理进程树，不保留 PowerShell/cmd supervisor。Linux 固定使用 `team-devspace-runtime.service` / `team-devspace-tunnel.service`，日志进入 journald。Windows 的 `test:installer` 和 Unix 的 `test:installer:unix` 仍可显式执行真实离线安装事务；Unix 打包仍会实际启动 native PTY。

原生客户端打包已经从 GitHub Actions 拆出：Windows/Linux 只在原生主机本地按需构建；macOS arm64 使用 Codemagic `mac_mini_m2` 手动构建，且不配置 push/PR 自动触发，以节省免费额度。Codemagic 只持久化经过 fingerprint、SHA-256、arm64 和最低系统版本校验的最终 `cloudflared` 原生产物；AppKit helper 直接使用已固定的 Xcode 工具链编译，不再安装 Rust 或维护 Tray 产物缓存。npm cache、`node_modules`、Cargo target/registry、Go SDK/build cache 和下载归档都不持久化。cloudflared cache miss 时才安装 Go 工具链并从锁定源码重建，缓存损坏也自动回退重建；release layout 校验和 Mach-O arm64/最低系统版本检查始终保留。兼容性扫描只枚举可执行文件和 `.node`/`.dylib`/`.so`/`.bundle` 原生候选，不再逐个探测整个 `node_modules`。它不跑完整测试矩阵和系统级 `.pkg` 安装。当前 canonical trust profile 仍是 `internal-free`，员工机器不需要 GitHub Token。免费内部发行的操作边界见 [内部发行与信任](docs/internal-distribution.md)。

跨机器和真实 ChatGPT 验收使用 [验收流程](docs/acceptance.md)。

## 设计依据

术语在 `CONTEXT.md`；已确认边界见 `docs/adr/`。运行层、隧道、安装器、进程恢复优先使用官方或操作系统已有能力，只在个人 Key、Device Binding 和认证衔接处增加必要适配。
