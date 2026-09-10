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
| Team DevSpace | 0.2.0 |
| 官方 DevSpace | 1.0.8 |
| Node.js | 22.23.0 |
| cloudflared | 2026.8.3 |
| Windows Git/Bash 后备环境 | Git for Windows 2.55.0.windows.5 |
| Windows 安装器 | NSIS 3.12 |
| 原生托盘 | tray-icon 0.24.2 / Rust 1.85.1 |
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

管理员先完成云端部署，再从 private GitHub Release 下载并分发对应的完整离线包和该员工的 Access Key。发行目录、离线布局和发布 gate 见 [客户端发行模型](docs/distribution.md)。

**Windows x64：**解压管理员提供的完整离线 ZIP，先运行 `Trust-Team-DevSpace-Internal-Publisher.ps1` 为当前 Windows 用户信任随包附带的固定内部发布者证书，再运行 `Team-DevSpace-0.2.0-windows-x64-setup.exe`，输入 Key、选择项目目录。EXE 使用内部自签 Authenticode，不把私钥交给员工；公开 `.cer` 只用于建立当前用户信任。EXE 只携带固定版本 manifest 和 bootstrapper，不能脱离同目录的 `objects` 单独分发。Node、DevSpace runtime、cloudflared 和可选 Git/Bash 均从离线介质或已校验缓存取得；Git 直接使用官方 PortableGit 自解压包，不再解压重打包。应用使用 `%LOCALAPPDATA%\TDS` 下的 cache、staging 和短版本槽，Enrollment/配置单独保存在 `%LOCALAPPDATA%\TeamDevSpace`。失败不会切换当前可用版本。

**macOS：**分别使用 arm64 或 x64 的自包含 `.pkg`，包内已包含离线 runtime 组件。`internal-free` 不要求 Apple 付费凭据；凭据齐全的 production job 会签名、公证并 staple，未配置时明确保持 unsigned/unnotarized。管理员只通过 private GitHub Release 交付并核对 SHA-256；unsigned 包首次安装若被 Gatekeeper 拦截，使用系统“隐私与安全性”中的“仍要打开”，不要关闭整机 Gatekeeper。首次打开完成本地校验、解压和原生 Enrollment 对话框，不下载 runtime。

**Linux：**使用对应 x64/arm64 离线 `.tar.gz`，解压后运行其中的 `install.sh`；安装和 native 依赖测试与实际 systemd 用户会话自启动验收分开记录。

内部发行仍可能触发 Windows SmartScreen 或 macOS Gatekeeper 的额外确认；只对管理员提供、SHA-256 已核对的固定版本包建立例外，不要关闭整机安全功能。

安装成功后，员工在 ChatGPT 连接共享 App，输入同一个 Access Key 即可。状态检查只报告可观测到的本地/网关健康状态，不会伪造“ChatGPT 已连接”。

Windows/macOS 登录后显示统一的系统托盘/菜单栏入口，可检查真实状态、暂停/恢复远程访问、重启、打开日志和复制脱敏诊断。退出托盘不会停止 runtime/tunnel；托盘崩溃也不改变远程访问状态。Linux 始终使用可靠的 CLI fallback。Windows 开始菜单仍提供 **Status**、**Repair connection** 和卸载入口；macOS 使用 `team-devspace`：

```sh
team-devspace status
team-devspace stop
team-devspace start
team-devspace restart
team-devspace suspend
team-devspace resume
team-devspace diagnostics
team-devspace logs
team-devspace roots list
team-devspace roots add <绝对项目目录>
team-devspace roots remove <绝对项目目录>
```

修改目录会重启本机 runtime，现有 MCP 会话需要重新连接。停止 runtime 会终止它管理的子进程，因此不要在仍需保留的开发命令运行中执行停止、升级或卸载。

### 权限边界

**Allowed Roots 约束工作区及文件工具，不是 Shell 沙箱。** Shell 以员工自己的系统账户执行，能访问该账户本来有权访问的资源。不要把“选择了项目目录”误解为强制隔离整机；取得 Access Key 的人能远程调用这些开发能力。

本地 Owner Token、设备 Secret、Tunnel Token 与员工 Access Key 不同。私有状态使用当前用户权限保护；Windows runtime 只绑定 loopback。云端只持久化路由、凭据摘要、加密后的设备 Secret 与运行元数据，不记录 MCP body、源码、Prompt 或 Shell 内容。

### 升级和卸载

重新运行明确版本的完整离线安装包，先取得并验证候选版本，再切换 active slot。失败时保留当前版本；成功激活后清理旧解压版本和当前 manifest 不再引用的缓存。没有长期保留的手动回滚槽，需要退回时由管理员重新分发旧版本安装包。私有状态位于应用目录以外：

- Windows：`%LOCALAPPDATA%\TeamDevSpace`
- macOS：`~/Library/Application Support/TeamDevSpace`
- Linux：`${XDG_STATE_HOME:-~/.local/state}/team-devspace`

修复和升级保留 Key、Device Binding、Allowed Roots，**不需要重新认证或重新输入 Access Key**；只有管理员已 reset/revoke、状态文件丢失或改用另一个 Gateway/Key 时才需重新 Enrollment。若升级前远程访问已暂停，升级只恢复托盘，不会暗中启动 runtime/tunnel 或把 Gateway 改回 active。卸载停止并移除用户登录启动项，**保留 Enrollment 和项目文件**；退休或丢失的设备仍需管理员撤销 Key。

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

`package` 必须在目标系统/CPU 原生构建，不能跨平台复制 SQLite/PTY 模块。输出包含固定版本的离线布局 `release/offline/<version>/<target>`；员工安装只使用管理员提供的完整离线包，不从远端拉取 runtime。再次本地构建可使用 `npm run package -- --reuse-dependencies`，只复用指纹匹配的依赖树，不复用生成目录。构建后自动清理解压/组装中间文件；员工 runtime 不携带构建用 npm 和 lock/.npmrc。

`test:tray` 在当前 Windows/macOS 桌面实际启动 native helper、通过 JSON-lines 切换四种状态并正常退出；Rust helper 使用 `cargo build --locked`，Windows 构建还检查 PE 必须是原生 x64 GUI 子系统。`test:native` 使用临时状态和临时原生启动项验证实际安装载荷、认证 MCP 调用、停止、重启与清理，不启动公网 Tunnel，不访问现有个人 DevSpace。Windows 计划任务以当前用户的 `InteractiveToken` 直接运行预编译的 `tds-launcher.exe`；launcher 通过 `CREATE_NO_WINDOW` 启动 Node/cloudflared/托盘控制器、重定向日志，并以 kill-on-close Job Object 清理进程树，不保留 PowerShell/cmd supervisor。Windows 的 `test:installer` 和 Unix 的 `test:installer:unix` 另外执行真实离线安装包的事务测试。Unix 打包还会实际启动 native PTY；托管 CI 的包安装测试不等于真实登录会话自启动验收。

GitHub Actions 的固定版本 release workflow 覆盖 Windows x64、macOS arm64/x64、Linux x64/arm64，聚合 native layout 后才允许发布。当前 canonical trust profile 是 `internal-free`：发布前只要求 `production` 环境中的固定 Windows 内部自签 PFX；CI 用它签 Windows 安装器，并把公开证书和当前用户信任脚本一起放进 Windows 离线 ZIP。Apple 凭据不是 gate，但完整配置时会启用 Developer ID app/installer 签名、公证与 staple；未配置时明确记录为 unsigned/unnotarized。CI 会先确认仓库仍为 private，再创建一次性的固定版本 GitHub Release；同版本已存在时直接失败，不覆盖旧发布物。员工机器不需要 GitHub Token，由管理员下载并分发离线包。免费内部发行的操作边界见 [内部发行与信任](docs/internal-distribution.md)。

跨机器和真实 ChatGPT 验收使用 [验收流程](docs/acceptance.md)。

## 设计依据

术语在 `CONTEXT.md`；已确认边界见 `docs/adr/`。运行层、隧道、安装器、进程恢复优先使用官方或操作系统已有能力，只在个人 Key、Device Binding 和认证衔接处增加必要适配。
