# Tailscale 客户端研究与 Team DevSpace 收敛

研究日期：2026-09-13。以官方文档及 `tailscale/tailscale` 的公开实现为依据，不把相似 UI 当作相同内部实现。

## 证据边界

[官方 changelog](https://tailscale.com/changelog) 的最新稳定客户端为 2026-09-10 发布的 **v1.102.4**；远端 tag 为 `3caf7d9e7dcaba589cfc58beda596929733e4fea`。本轮按该 tag 读取了 `ipn/prefs.go`、`ipn/localapi/localapi.go`、`client/systray/systray.go`，并检查公开的 `ipn/ipnserver/server.go`、`health/health.go` 及平台文档。

[Tailscale 的开源范围](https://tailscale.com/opensource)明确区分：核心 daemon/CLI 开源，Windows/macOS GUI 闭源。公开 `client/systray` 是 Linux 桌面实现，不能据此认定官方 Windows/macOS GUI 使用同一 Go 托盘库，更不能声称审查过闭源 GUI。Team DevSpace 不因“像 Tailscale”再引入 Go 构建链或替换已经可用的 Rust/Swift 原生适配器。

## 值得借鉴与不应照搬

| 主题 | 官方证据 | 本项目决定 |
| --- | --- | --- |
| 用户意图与运行事实分离 | [`Prefs.WantRunning` / `LoggedOut`](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/prefs.go)区分用户意图与登录/联网事实；本地启动无需等服务器才能决定 Login/Connect。 | 保留唯一持久化 `state.json.remoteAccess`；`deviceStatus` 汇总 runtime/bridge/tunnel/gateway 实际健康。UI 不持久化自己的连接状态，不把进程存在或 Enrollment 成功当成已连接。 |
| 前端是操作入口与状态投影 | [Linux systray](https://github.com/tailscale/tailscale/blob/v1.102.4/client/systray/systray.go)通过 LocalClient 调用后端、订阅 `WatchIPNBus`；断开订阅后延迟重连。 | `desktop-controller` 复用既有操作与锁，`desktop-state` 只生成菜单/按钮/状态文案；Windows/macOS 都消费相同 JSON 菜单。保留单个合并健康轮询，不为少量状态再引入事件总线、WebSocket 或额外常驻服务。 |
| 本地不等于可信 | [`LocalAPI.Handler`](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/localapi/localapi.go)检查 Host、拒绝浏览器 Origin/Referer，区分读写权限，并支持同用户证明密码；[`ipnserver`](https://github.com/tailscale/tailscale/blob/main/ipn/ipnserver/server.go)检查连接用户身份。 | 浏览器控制面不能原样复制“拒绝所有 Origin”：本项目采用仅 IPv4 loopback、每进程随机能力令牌、严格 Host/同源/Fetch-Site 检查、变更操作必须有同源 Origin、字段白名单、请求大小上限、CSP 与禁止缓存。绝不挂到公网 Gateway/Bridge，也不返回 Access Key、设备密钥或任意命令接口。 |
| 生命周期交给系统 | [daemon 文档](https://tailscale.com/docs/reference/tailscaled)：Linux 使用 init/systemd，Windows 使用服务，非 GUI macOS 使用 launchd。普通 `tailscale down` 是闲置联网而非杀 daemon。 | 保留当前用户 Task Scheduler + Job Object、LaunchAgent、systemd-user；无 systemd 时保留现有窄范围 keeper。Team DevSpace 不需要 TUN/驱动权限，不新增 SYSTEM Service。暂停仍停止 Runtime/Tunnel 并保留托盘控制面：这是现有未修改上游及 fail-closed 边界的适配，不把 VPN daemon 的 idle 机制机械移植进来。 |
| 平台差异是真实边界 | [macOS 三种变体](https://tailscale.com/docs/concepts/macos-variants)：Standalone SystemExtension、App Store NetworkExtension、无 GUI utun daemon；[Linux systray](https://tailscale.com/docs/features/client/linux-systray)依赖 D-Bus/桌面环境。 | 不引入 VPN 系统扩展或新的跨平台 GUI 框架。Windows 用已有 tray-icon/winit，macOS 用 AppKit，Linux 保持 CLI/远程服务器目标。单实例复用 Windows named mutex / macOS flock，以规范化本地状态目录而非远端 Key/Binding 定义实例。 |
| 健康与诊断需要解释原因 | [`health.Tracker`](https://github.com/tailscale/tailscale/blob/main/health/health.go)按意图比较子系统状态；[bug report](https://tailscale.com/docs/account/bug-report)关联日志与时间，而不是简单输出“在线”。 | 展示各子系统、暂停意图、当前操作和可重试错误；日志/诊断默认脱敏。配置损坏与尚未安装必须区分，不能把读取异常说成“未绑定”。本项目无需复制云端日志上传或完整健康事件平台。 |
| 安装成功不等于登录成功 | [Windows EXE](https://tailscale.com/docs/install/windows)、[MSI](https://tailscale.com/docs/install/windows/msi)安装后从托盘发起认证；[Linux](https://tailscale.com/docs/install/linux)支持包管理器及静态包。 | 保留现有离线产物验证、应用目录/私有状态分离、幂等重装、A/B 激活/恢复与原生卸载。安装认证失败留下可恢复状态，不删除身份重新绑定。继续以最终产物与实际安装树为验收对象，而不是重写 NSIS/PKG 或增加自动更新守护进程。 |

## 本轮代码变更

原有未提交的托盘收敛工作一并接续审查：减少原生菜单中的业务决策、重复状态与模态设置流程；统一控制中心承载项目目录、Access Key、连接检查、Repair、日志/诊断和作者信息。首次安装原生表单保留，避免扩大安装链路重构范围。

进一步通过失败用例定位并修复：

- 浏览器 `submitting` 状态原先屏蔽后端进度，恢复按钮禁用期间的真实操作进度展示；浏览器 smoke 跨越一个真实轮询周期验证，不只断言提交完成。
- 启动时迟到的 `localState` 读取原先能覆盖已完成操作的新目录；复用现有 `revision` 丢弃过期结果，不增加第二份配置存储。
- `diagnosticReport` 原先将损坏/不可读配置误报成未绑定；现在明确报告未知健康与不可读状态，并脱敏错误。
- 删除已无调用的 Windows 换 Key WinForms、macOS 托盘认证分发包装，以及原生复制诊断分支和其派生展示字段；首次安装仍复用现有原生表单，复制诊断只保留实际使用的浏览器实现。

## 复审原则与验收证据

复审覆盖全部 tracked/untracked diff，不把 tracked 行数减少等同于总复杂度减少。新增控制中心确实增加一个受限的本地 HTTP 面；其收益是删除两套设置/反馈实现，而非新增远程管理能力。它仅在打开设置时启动、随桌面进程退出，不是另一个 supervisor。持久化事实、设备操作锁、启动所有权、Gateway 授权与现有安装事务均不迁移。

必须分别记录以下证据，不能互相替代：

1. `check`、全量测试、真实浏览器生产 UI + 注入测试操作：覆盖状态并发、进度、错误重试、敏感字段和同源边界，但不宣称连接了公网设备。
2. Windows `platform-acceptance`：最终 payload、真实 native tray/单实例、原生任务及隔离 NSIS 安装事务。隔离注册表的本机 smoke 不等同于安装未改动的最终 EXE；最终用户安装验证另记。
3. `tray-live-smoke --live`：临时独立测试 Key，经真实 Gateway/Cloudflare 验证连接、暂停/恢复、重启、Repair、更换 Key 与退出；清理临时授权并检查员工状态未变。
4. WSL `linux-wsl.ps1`：真实 systemd-user、离线包/安装树/运行时/权限与升级卸载；`linux-no-systemd.sh` 在隔离 PID/mount namespace 内验证真正缺失 systemd 时的 keeper、异常恢复及清理，其 Tunnel 是明确标记的 fixture。
5. Codemagic arm64/x64：真实 macOS 构建、`.pkg` 系统安装、LaunchAgent 和 native UI smoke；x64 在 Apple Silicon/Rosetta 上不等于 Intel 实机，CI GUI 自动验收不等于同事电脑上 Gatekeeper/手工授权/所有交互都已验证。

具体结果以本轮命令输出、`acceptance.json`、最终文件 SHA-256 与 Codemagic 构建记录为准；构建产物、日志和任何密钥均不提交到 Git。
