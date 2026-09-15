# 真实设备与 ChatGPT 验收

## 证据不能互相替代

单元/边界测试可以证明 D1 的绑定、凭据校验、流量路由和错误处理。原生启动测试可以证明本机运行和停止没有残留。**它们不能代替真实 Cloudflare Tunnel、真实 ChatGPT 工作空间以及另一台 Mac 的验证。**

正式发布必须覆盖 Windows、Linux 和两个 macOS 目标的真实安装器事务与安装后运行验证。darwin-arm64 使用 Apple Silicon；darwin-x64 优先使用 Intel。按当前内部发行决策，在没有 Intel 机器时，允许免费 Codemagic M2 上用 Rosetta 完整安装、升级和运行同一份 x64 PKG，发布验证仍要求所有其余门禁通过，并保留 nativeArchitecture: false 与 Intel 实机未验收的明确限制。这不是物理 Intel 验收，也不能用来宣称最低 macOS 版本、Gatekeeper 或员工交互已验证。安装器不会自动安装 Rosetta，ARM64 包仍不能安装到 Intel；不得修改机器类型或付费套餐来绕过限制。两个 macOS 目标继续共用一个既有 workflow。

## 无凭据的本地验证

```sh
npx --yes npm@11.19.1 ci --no-fund --no-audit
npm run acceptance:local
```

`acceptance:local` 是本机单一发布前门槛：依次执行 source/check、全部测试、distribution contract、Gateway dry-run、当前平台真实 package，然后对刚生成的 packaged artifact 执行 `acceptance:platform`。不要再把单独跑过 `test:tray`、`test:native` 或 `test:installer` 当成整体通过；这些脚本仍可用于定位失败。

Windows 主机需要构建 Linux x64 时，使用已经启用 systemd 的 Ubuntu 22.04 WSL2：

```powershell
npm run acceptance:linux:wsl
```

该命令把当前 Windows 工作区（包括未提交源码）同步到 WSL ext4 下的 `~/team-devspace-linux`，保留 Linux 原生 `node_modules` 与构建缓存，依据 Git index 恢复已跟踪文件的 Unix 执行权限（避免 DrvFS 将普通文件投影为可执行文件），然后在 WSL 内执行完整 `acceptance:local`。通过后会再次校验 Linux 离线包 SHA-256，并把 `.tar.gz` 与 `.sha256` 复制回 Windows 仓库的 `release/`。默认要求 WSL 使用普通用户、`systemd --user` 可用、Node/npm 与发行固定版本一致；不会用 root daemon 或 GitHub Actions 代替本地 Linux 生命周期验证。未提交源码产生的 `acceptance.json` 会保留 `sourceDirty: true`，只能作为开发验收证据；正式发布前需从干净提交重新运行。WSL 能验证当前 Linux 包和 user-service 生命周期，但不能代替真实 Linux 机器的注销/登录或重启验收。

Windows 的本地 installer transaction 从生产 manifest/bootstrap 源重新编译一个只更换随机注册表和开始菜单键的隔离自包含 NSIS，避免覆盖已安装的员工版本；它验证首次 Enrollment 503、Repair、覆盖升级、credential 恢复、损坏 payload 修复、A/B 版本回收、卸载和零测试 Task 残留。`test:native` 使用真实 Task Scheduler/runtime/MCP，并额外制造同一 `TEAM_DEVSPACE_HOME` 的未知旧 owner task 与另一 state home 的 foreign task：前者必须被迁移，后者必须保留。packaged Tray 会真实启动第二个进程，第二个进程必须在创建图标前被 OS single-instance guard 拒绝。

显式运行 `acceptance:platform` 时仍会在 target 的 offline layout 写入 `acceptance.json`，记录 release、commit、source 是否 dirty、入口文件 SHA-256 和实际运行的检查。Codemagic workflow 在打包和 Mach-O 检查后调用 `scripts/platform-acceptance.mjs --system-macos-installer`，x64 使用 x64 Node/Rosetta 执行相同入口。该选项仅允许非 root 的 Codemagic 临时环境，且遇到既有 App、设备状态、CLI、安装收据或 LaunchAgent 会拒绝覆盖。测试通过系统 `installer -pkg` 安装真实包，再用安装后的 payload 验证原生 Runtime/MCP、LaunchAgent、菜单栏可见性、重复安装、损坏 CLI 修复、暂停与身份保留、卸载及测试文件清理；复用已有测试，不建立第二套运行时。

普通 macOS `acceptance:platform` 仍只解包并测试内部 bootstrap，必须记录 `finalEntrypointTransaction: false`；发布验证拒绝这类证据，也拒绝缺少 `nativeStartup` 的 macOS 证据。配置了工作流不代表已经执行通过，应检查对应构建的 `acceptance.json`。系统安装测试会实际经过 postinstall 自动打开并确认首个原生窗口可见；随后仅在 Codemagic 临时用户内终止这个等待人工 Access Key 的测试进程树，再继续使用隔离的暂停状态验证安装后 Runtime、LaunchAgent、菜单栏、重复安装和修复。它不代替管理员授权弹窗、Gatekeeper、真实首次 Enrollment、员工登录/重启或最低支持系统版本的实机验收。保持 Codemagic Personal 免费 M2，不启用付费订阅、额外机器类型或其他 CI 服务。

三个平台的安装 smoke 都在实际解包后的目录调用现有 `verify-release.mjs --target <target> --installed <path>`：逐字节比对内嵌 manifest，核对关键文件与构建输出的 SHA-256，执行已安装 Node 验证平台/架构/版本，检查 cloudflared 版本和来源哈希、上游 DevSpace 版本及 Unix 可执行权限；macOS 另用系统 lipo 校验安装后的原生二进制架构。只有这些检查执行通过，报告才记录 `installedPayload: true`，缺少该证据的旧报告不再通过发布检查。任何验收重跑先清除上次成功 evidence，失败不留下旧的假绿。

所有 native/installer smoke 都必须把自己的状态目录和启动项限定在测试作用域并在结束时清理。不要在真实员工设备的状态目录内改造测试夹具。

## 无 systemd Linux 补充验收

无 systemd 云电脑与普通 Linux 复用同一离线包；运行方式和 `/workspace` 持久目录安装方法见 [Linux standalone](linux-standalone.md)。先保留上述普通 WSL/systemd 完整验收，再执行 `npm run test:standalone`（目标必须实际没有 systemctl），或者在 WSL 中使用文档所列的隔离 mount/PID namespace helper。该 helper 的 root 仅用于创建隔离测试环境，产品和安装测试始终以普通用户运行，不修改宿主的 systemd。

此验收使用真实离线安装器、Node/native modules、Runtime、Bridge 和 MCP，但 Tunnel 与 Enrollment 控制面为显式测试替身；不得将其写成真实 Cloudflare 或网页 ChatGPT 已验收。测试包含进程崩溃/有界退避、孤儿及独立会话子进程回收、PID 复用保护、重复启动、暂停后 start/repair 不复活、恢复、Current Project Root 切换范围、升级失败恢复、日志跟随退出和新终端卸载清理。普通 systemd 原生验收同时覆盖从运行中的 standalone 到 systemd 的显式所有权迁移。

真实 Grok 验收使用独立测试 Key 和 `/workspace` 测试仓库，另外验证实际 cloudflared、公网 MCP、客户端退出后连接、暂停返回 403、恢复与撤销。SDK 验收保留 `realChatGPT: false`；只有网页会话实际调用插件才可以修改该结论。完整 VM 重建/休眠唤醒与本机 Grok 客户端退出不是同一项测试；未运行的平台恢复测试必须明确保留。

## 部署与两个员工安装

管理员先按 [部署说明](deployment.md) 完成私有凭据配置与云端部署，签发两个不同的员工 Access Key。分别运行对应平台安装器。`team-devspace status` 必须显示 DevSpace、Bridge、Tunnel 和 Gateway 都可用。

管理员发布一个新的 **Team DevSpace** App，使用新 Gateway 的 `/mcp`，保留原个人 App 和域名不动。两个员工分别连接同一个 App，输入各自的 Access Key。必须实际确认平台分别携带用户凭据，不能将一个共享静态 Key 配到 App 本身。

## 可重复的外部 MCP 路径验证

在每台已 Enrollment 的设备上，使用本仓库的 Node 运行：

```sh
node scripts/prepare-acceptance.mjs
```

这会在允许项目目录生成一个随机标识文件，在目录以外生成另一个已知存在的标识文件，并将该设备的私有描述文件写入自己的 Team DevSpace 状态目录。它们不包含任何业务源码。描述文件包含 Access Key，只通过公司的私密途径交给执行验证的人，不能上传到 Issue 或提交 Git。

准备两台设备的描述文件后，在管理端运行：

```sh
node scripts/acceptance.mjs --device <Windows私有描述文件> --device <Mac私有描述文件> --phase online --output .artifacts/online.json
```

脚本通过真实 HTTPS 地址和 MCP SDK 调用绑定电脑，验证两个标识不串设备、文件工具拒绝读取真实存在的目录外文件、不同员工 Key 不能复用别人的 MCP Session、无效 Key 返回 401。报告明确标记 `realChatGPT: false`，因为 MCP SDK 不等于实际 ChatGPT。

## 实际 ChatGPT 验证

分别在两个员工的 ChatGPT 会话中执行下面同一种测试：打开该员工的临时验收项目，读取 `marker.txt`，检查随机标识与自己的描述文件一致；另一台设备不应收到这次调用。随后尝试读取目录外的测试标识，必须拒绝，不能把文件不存在当作安全验证成功。

验证多个会话并发与正常重连，并实际检查官方 DevSpace 的展示资源能加载。记录运行时间、设备 ID、平台、版本、调用结果及脱敏截图；**不记录 Key、Tunnel Token、Owner Token、业务源码或完整 MCP 请求。**

如果工作空间 App 的实际凭据传递与所选 API Key 模式不兼容，应保持验收未通过，调查该集成边界；不能改成所有人共用管理员 Key 来“跑通”。

## 离线、恢复、升级和撤销

| 场景 | 动作 | 必须观察的结果 |
| --- | --- | --- |
| 员工 A 离线 | A 执行 `team-devspace stop`；对 A 运行 `--phase offline` | A 返回不可用，B 仍正常，绝不回退到 B |
| 恢复 | A 执行 `team-devspace start`；双设备执行 `--phase reconnected` | 不重复 Enrollment，原 Key/Binding 可用 |
| 网络中断 | 在测试设备临时断开再恢复网络 | 官方 cloudflared 自动恢复；不用重配 DNS、Token 或 Key |
| 登录启动 | 注销/登录设备后检查状态并实际调用 | Runtime 与 Tunnel 以该用户身份恢复，不需要管理员电脑在线 |
| 覆盖升级 | 记录两台设备的 Key ID、Device ID、Binding ID、Roots；运行另一版本安装器 | 原记录不变，运行的是新发行版本；旧依赖文件不残留 |
| 升级后连通 | 使用旧描述文件执行双设备 `--phase upgraded` | 原 Binding 仍能到同一设备；**此脚本本身不证明安装器确实完成版本升级** |
| 撤销 | 对可废弃的测试设备执行 `--phase revoke --device <描述文件> --admin-config .runtime/admin.json` | 已连接的 Key 后续调用被拒绝；清理成功，不再能用旧 Tunnel Token 重连 |
| 换电脑 | 管理员 reset 后在替换设备 Enrollment | 旧 Binding/Session 失效；新电脑绑定成功 |

撤销会阻断后续请求，但不能撤销已经执行到员工系统中的文件写入或命令；不能承诺将已执行的副作用回滚。已建立连接的清理与新请求拒绝需要分别观察。

完成后删除脚本输出的临时标识目录，撤销专门用于验收的 Key，妥善销毁私有描述文件。保留不含秘密的验收报告。

## 发布门槛

只有安装、用户身份传递、两设备隔离、权限提示、原生启停/登录恢复、断网恢复、撤销/重置、覆盖升级在上述范围内都有真实证据，才能将 Spec #1 与子任务 #2–#8 标记为整体完成。编译成功、Localhost Mock 成功或“已经写好脚本”都不能关闭还未运行的真实验收项。
