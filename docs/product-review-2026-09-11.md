# Team DevSpace 产品级审查与修复记录

日期：2026-09-11（Asia/Tokyo；部分工具日志使用 UTC 2026-09-10）。

## 审查基线与边界

- 仓库：`C:\project\team-devspace`，分支 `main`，基线提交 `ca5f842eba597dc7aec6c0a81ef41207878bece9`，版本 `0.2.1`。
- 开始时工作区已有托盘、暂停/恢复、Windows 桌面交互和安装脚本方面的未提交改动。本轮保留并验证这些改动，没有 reset、覆盖恢复或把前序工作冒充本轮新增修复。
- 进行了三轮“全局复审 → 当前 Top 3 修复 → 验证”，共修复九个问题；随后再次检查整个产品链路、实际部署行为和最终产物。
- 不增加后台常驻服务，不更换原生生命周期架构，不修改上游 `@waishnav/devspace@1.0.8`，不扩大既定三平台矩阵。
- 本轮未提交、推送、触发 CI、部署 Worker、发布 Release、修改账单或轮换生产凭据。真实云端验证只使用独立临时测试 Key/设备，并在结束时清理。

## 覆盖面与证据层级

| 产品链路 | 审查和验证方式 |
| --- | --- |
| 网页 GPT 插件、Gateway、Tunnel、Bridge、上游 DevSpace | 代码/配置检查、上游 MCP 集成测试、真实 Windows 原生服务、当前 ChatGPT 会话中的 Team DevSpace 工具调用、真实 Cloudflare 链路测试。 |
| Access Key、设备、会话隔离、授权与清理 | 本地 Worker/Miniflare/D1 回归，包含真实 SQLite 状态变更、旧绑定请求、清理并发、失败恢复；独立测试设备真实更换 Key。 |
| Windows 托盘与生命周期 | Rust 测试、真实原生托盘创建/协议/重复实例拒绝、Task Scheduler/Job Object 验收、真实暂停/恢复/重启/修复/退出服务。桌面点击验收另列限制。 |
| 管理平台 | 生产 HTML/JS/CSS 的真实 Playwright 浏览器检查；隔离模拟 API 失败/重试/登录失效，不操作真实员工 Key。后端鉴权另由集成测试验证。 |
| 安装、升级、卸载和残留 | 当前候选包的真实隔离 NSIS 安装事务、首次注册失败恢复、离线升级、丢失凭据和损坏程序修复、官方 Git fallback、卸载保留项目及零残留。 |
| Windows/macOS/Linux 打包 | 目标/版本/签名策略、安装入口、原生依赖、发布清单、哈希和证据门检查；本轮 Windows 原生构建实测，macOS/Linux 不冒充原生实测。 |
| CI / GitHub Releases / 部署 | 工作流和门禁检查、真实 Actions 失败注释、真实 Release 列表、Worker dry-run、线上只读/未认证控制路由探测。 |

以上不表示对第三方依赖逐行安全认证，也不表示未运行的平台已通过。

## 第一轮：恢复流程与暂停意图

### 1. 丢失 Tunnel 凭据后，修复会取消本地暂停

原行为：删除 `tunnel.token` 后重新 Enrollment，使用 Gateway 返回的 active 状态覆盖本地明确的 suspended 状态。

修复：`configureDevice` 恢复凭据时保留本地暂停；显式恢复操作才能解除暂停。

证据：新增回归先失败，修复后通过。验证同一 Device/Binding/Secret 和项目目录继续保留，凭据恢复后仍暂停。

主要文件：`client/setup.mjs`、`test/client.test.mjs`。

### 2. 更换 Key 的响应丢失后，设备无法从托盘继续恢复

原行为：服务端已绑定新 Key，但本地没有拿到响应；托盘不允许 repair，同一个 Key 又被判定为“无需更换/已经绑定”。

修复：状态显式报告 `enrollmentPending`；托盘提供恢复入口；同一个待完成 Key 使用原设备身份进行幂等 Enrollment，不再次 preflight、不再次释放绑定、不生成另一套身份。

证据：故障注入在服务端提交绑定后断开连接；原逻辑失败，修复后恢复成功，断言没有额外 preflight/release。

主要文件：`client/setup.mjs`、`client/tray.mjs`、`test/client.test.mjs`。

### 3. 过期注册清理使用了错误的时间比较

原行为：ISO `T...Z` 时间与 SQLite `datetime()` 的空格分隔文本做大小比较，导致同一天的过期 provisioning 未按阈值清理。

修复：使用 `julianday` 进行时间数值比较。

证据：真实 D1/SQLite 测试区分 20 分钟前与 1 分钟前的记录，先失败后通过，并验证实际清理结果。

主要文件：`gateway/store.mjs`、`test/gateway.test.mjs`。

第一轮门禁：70/70 Node 测试、分发契约检查通过。

## 第二轮：管理反馈、原生隔离与云端竞态

### 4. 管理页面创建失败后仍显示“已创建”，并删除重试凭据

真实浏览器复现：服务返回 503 后，“我已保存并关闭”仍可点击；点击后显示成功且 sessionStorage 中的待重试 Key 被删除。

修复：只有服务端确认后才允许保存确认和复制；确认状态跨刷新保留；失败保留原 Key/id/hash；请求进行中禁止重复提交和关闭后重入；请求有明确超时及“结果未确认”提示。

证据：13 项真实浏览器检查全部通过，覆盖 503、同 Key 重试、重复提交、Esc/关闭按钮、刷新重开、窄屏布局、登录失效、异步清理待完成反馈和无脚本错误。浏览器请求不包含明文 Access Key。

主要文件：`assets/admin/admin.js`、`test/admin.test.mjs`；复用入口：`scripts/admin-ui-fixture.mjs`、`scripts/admin-browser-smoke.js`。

### 5. 原生验收的全局单实例锁与员工已有托盘互相阻塞

真实复现：员工托盘正在运行时，隔离平台验收的原生托盘没有进入 ready，测试超时。

修复：控制器按规范化私有状态目录计算固定 SHA-256 实例身份；Windows mutex / macOS 文件锁按该身份隔离。同一安装仍只能有一个托盘，换 Key/升级不改变身份，隔离测试不接管员工托盘。原生辅助程序拒绝缺失或非法身份。

证据：真实托盘创建、同身份第二实例拒绝、独立验收与员工安装共存、Rust 身份校验和 JS 目录规范化测试通过。

主要文件：`client/tray.mjs`、`native/tray/src/main.rs`、`scripts/tray-smoke.mjs`、`test/tray.test.mjs`。

### 6. 清理任务的旧快照可能重置刚恢复的设备

原行为：扫描出过期 provisioning 后，设备已恢复 active 或更新时间；清理仍可使用旧快照无条件 reset。

修复：数据库原子条件更新同时验证 Binding、状态、更新时间和过期阈值，再取得本次清理所有权；不再事后读取可能已变化的记录。

证据：真实 D1 测试模拟扫描后激活/推进注册，旧实现会删除两条当前绑定，修复后均保持不变。

主要文件：`gateway/store.mjs`、`gateway/index.mjs`、`test/gateway.test.mjs`。

第二轮门禁：73/73 Node 测试、3/3 Rust 测试、真实托盘协议/单实例、Windows 构建及完整隔离安装验收通过。

## 第三轮：跨入口并发和过期设备授权

### 7. 并发修复可以覆盖已经完成的暂停

真实复现：修复等待 Enrollment 响应时，另一个入口先完成暂停；较旧的修复响应随后将状态写回 active。

修复：CLI、托盘及安装器调用的状态变更统一进入每个安装目录的操作锁。直接复用原本已有的 `proper-lockfile@4.1.2`，将它声明为直接依赖；保留嵌套操作的同一所有者。状态/日志读取和常驻运行入口不取锁，输入 Key 时不占用锁；冲突有界等待，失败明确报告本次没有执行。

证据：原并发回归先失败后通过；新增真实子进程互斥、不同安装互不阻塞、嵌套异常释放、强杀进程后模拟锁过期回收测试。没有增加新的运行依赖种类或常驻服务。

主要文件：`client/operation.mjs`、`client/cli.mjs`、`client/setup.mjs`、`client/control.mjs`、`package.json`/lock、`test/operation.test.mjs`、`test/client.test.mjs`。

### 8. 暂停时修改 Allowed Roots 会错误地启动运行时

真实复现：暂停且没有 runtime 启动项时，CLI 修改目录后仍调用 Task Scheduler 启动，导致配置已经写入但命令失败。

修复：暂停时只更新目录和配置，不创建或启动运行时，并明确报告访问保持暂停。

证据：真实 Windows CLI 子进程回归先失败后通过，状态与目录正确保留。

主要文件：`client/cli.mjs`、`test/client.test.mjs`。

### 9. 旧设备的延迟解绑可能禁用替换后的新绑定

原行为：设备请求通过旧 Binding 的鉴权后，管理员 reset 并重新绑定；迟到的释放请求只按 Key ID 修改记录，会影响新设备。

修复：设备授权的 disable 原子条件更新必须匹配已鉴权的 Binding；使用 UPDATE RETURNING 返回本次确切变更，不再读取可能已经替换的记录。

证据：真实 D1 流程完成旧注册、管理员 reset、新注册，再执行旧 Binding 的释放；旧实现错误重置新绑定，修复后返回拒绝且新绑定保持 active。

主要文件：`gateway/store.mjs`、`gateway/index.mjs`、`test/gateway.test.mjs`。

第三轮及最终回归：79/79 Node 测试、3/3 Rust 测试通过；当前候选包再次通过完整 Windows 原生与安装事务验收。

## 最终执行记录

| 命令 / 环境 | 本轮结果 |
| --- | --- |
| `npm run check` | 通过：源代码语法、配置/版本/依赖边界、发布策略与 diff whitespace。 |
| `node --test --test-concurrency=1 test/*.test.mjs` | 79/79 通过。 |
| `npm run test:distribution` | 通过；同组测试也包含在全量测试内。 |
| `npm run build:tray` / 包构建中的 Cargo gate | Rust 3/3；Windows x64 原生托盘构建通过。 |
| `npm run package -- --reuse-dependencies` | 当前 Windows EXE 重建成功；锁文件变化正确触发依赖重装，原生 SQLite 加载成功。 |
| `npm run acceptance:platform` | 当前包通过 release layout、真实托盘协议/单实例、真实原生服务/MCP、安装升级修复卸载、零残留。 |
| `npm run deploy -- --dry-run` | Worker 与静态资源 bundle 校验成功，未修改 Cloudflare 部署。 |
| `node node_modules/npm/bin/npm-cli.js audit` | 当前锁定依赖图 0 个已知漏洞。不能替代源代码安全审查。 |
| `bash -n` / PowerShell 7 Parser / `node --check` | POSIX 安装入口、5 个 PowerShell 文件、管理页面和浏览器验收脚本语法通过。 |
| 管理平台真实浏览器 | 13 项通过；生产页面/资源 + 隔离故障响应，不冒充真实管理账号操作。 |
| 当前网页 Team DevSpace 插件 | 实际经过现有 Gateway/Tunnel 执行工作区打开、仓库读取，以及写入本报告；选定 `C:\project` 不被额外嵌套。 |
| `node scripts/tray-live-smoke.mjs --live --runtime-root build/bundle-win32-x64` | 当前候选运行时 + 现有线上 Gateway 的 9 项真实链路检查全部通过。 |

真实链路检查包含：独立设备就绪、暂停、恢复、通过真实 Cloudflare Tunnel 的鉴权 MCP、重启、修复、更换 Access Key 并保持身份/目录、新旧绑定切换、退出停止全部连接服务。两个临时测试 Key 已吊销并清理；员工状态文件指纹在验证前后保持不变。

历史记录中的 `/v1/enrollment/preflight` 和 `/v1/device/release` 返回 404，本轮没有再复现：两个接口对未认证 POST 返回 401，并且真实 Key 更换已经通过。此结论来自本轮实际请求，不是依据版本字符串推断。

## 当前产物和证据

Windows 本地安装包：

`C:\project\team-devspace\release\Team-DevSpace-0.2.1-windows-x64-setup.exe`

SHA-256：

`e4fd7488584c946e9d219e274b1f0bb266728f0653f988d7c2177f1971e47780`

签名状态：`signed: false`。这是本地候选包，不是本轮新发布的 GitHub Release。

平台证据：`release/offline/0.2.1/win32-x64/acceptance.json`。其 `sourceDirty` 为 true，`finalEntrypointTransaction` 为 false；没有将这些字段改写成通过。

## 仍受环境或外部条件限制的项目

1. **当前 Windows 桌面锁定。** 用 PowerShell 7 执行原生桌面探针时明确拒绝发送输入。没有把菜单实际点击、焦点、弹窗视觉行为全部记为通过；原生协议和真实服务控制不等于这项验收。
2. **macOS/Linux 当前版本原生验收未在本轮执行。** 当前主机为 Windows，未发现可用 WSL 发行版；没有 macOS 硬件。本轮检查代码、契约、脚本和打包策略，不能替代 PKG/Gatekeeper/LaunchAgent 或 Linux/systemd 原生安装运行。
3. **GitHub Actions 被外部账单/支出限制阻断。** 本轮读取的最新失败 run 为 `34464458921`，注释说明任务因付款失败或 spending limit 没有启动；不是一次新的代码编译失败。未修改账单或启动收费资源。原生 CI 和正式多平台发布不能据此打勾。
4. **最终签名安装包的同字节事务未验证。** 本地使用隔离注册表/开始菜单身份编译的真实 NSIS 测试安装器，避免覆盖员工安装；并非最终签名发布 EXE 的同字节安装测试。签名/公证策略保持现有 internal-free，不把付费 Apple 认证强制设为新增门槛。
5. **本轮新 Gateway 代码尚未部署。** 新清理与授权竞态修复经过本地 Worker/D1 回归；真实云端测试使用现有线上 Gateway，不能称作新 Gateway 代码的生产验收。员工正式安装也没有被本轮候选运行时替换。
6. **没有多员工、多平台同时在线的生产隔离证明。** 已有本地隔离回归和独立 Windows 实际链路证据，不等同于两名员工的 Windows/macOS 同时运行验收。

结论：三轮修复后的最终全局复审，在本轮可执行和可观察范围内没有继续复现需要立即处理的高优先级产品问题。源代码修复、当前 Windows 候选包和已执行测试均有具体证据；跨平台原生、桌面交互及正式发布仍必须保留上述未通过标记。保留原架构和轻量运行模式，不用新增抽象或扩大兼容矩阵制造“成熟度”。
