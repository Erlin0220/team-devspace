# 部署与凭据

## 发布前提

使用有权管理的 Cloudflare Account 与 DNS Zone；该 Zone 已在 Cloudflare 正常解析。准备一个**全新的单层子域名**作为 Team Gateway，例如 `team-devspace.example.com`。每台设备自动获得另一个同级子域名 `tds-<随机绑定标识>.example.com`，避免依赖多级通配证书。

本项目的固定目标在 `release.config.json`。这里只声明员工安装包真正需要的 Gateway，以及不可可靠推导的 Cloudflare Zone ID；Account ID 与设备域名在部署时从该 Zone 的实际元数据解析，不再重复手填。目标域名与员工安装包内的配置必须一致。部署脚本还会确认 Gateway 是该 Zone 下的单层子域名；发现域名已指向其他 Worker 或已有不属于本项目的 DNS 时会停止，不覆盖现有个人服务。

## 两种 Cloudflare API 令牌

令牌均限定到实际使用的 Account / Zone，不能选择所有账号或所有区域。

| 用途 | Account 权限 | Zone 权限 | 保存位置 |
| --- | --- | --- | --- |
| 管理员部署 | Workers Scripts Edit、D1 Edit、Access: Apps and Policies Write、Access: Organizations, Identity Providers, and Groups Read | Workers Routes Edit、DNS Edit、Zone Read | 本机 `.runtime/cloudflare.json` 或 GitHub `production` 环境 |
| Worker 运行时建 Tunnel | Cloudflare Tunnel Edit | DNS Edit | Worker Secret `CF_API_TOKEN` |

这些是 Cloudflare 管理令牌，**不是员工的 Access Key**。员工安装包和 Employee 电脑只得到自己 Tunnel 的运行 token，不得到以上账号级令牌。

在自己电脑的项目终端运行 `npm run configure`。输入使用密码框；不要通过聊天、环境变量截图、GitHub Issue 或提交文件传递秘密。配置文件所在目录会限制为当前用户可访问。

Gateway 与 Zone ID 唯一读取 `release.config.json`；Cloudflare Account ID 与设备域名从 Zone 查询结果派生。本机配置只保存令牌和允许登录 Admin 的邮箱列表，CI 使用 `ADMIN_ACCESS_EMAILS`（逗号分隔）变量。`deployment.config.json` 只保存项目明确拥有的 D1 ID 与 Access Application ID。这些公开元数据不代表 Worker/D1 已获授权。拥有旧的 cloudflared 证书，也不代表有 Worker 部署权限。

## 可重复的部署动作

`npm run deploy` 按以下顺序处理：校验域名和 D1 归属；按 `deployment.config.json` 确认或创建唯一的 `Team DevSpace Admin` Access Application（精确覆盖 `<gateway-host>/admin*`），把 allow policy 收敛为且仅为配置的管理员邮箱，并读取 Access organization 的签发域名和 Application AUD；保存可复用的管理员密钥与主密钥；用运行时令牌执行 Tunnel/DNS 只读 preflight；记录当前 Worker 版本和旧静态资源路由；应用数据库迁移；单次部署 Gateway、静态资源和 Secret；验证固定 release/upstream 版本、Admin/D1 和真实资源，最后从无 Access 会话的请求确认 `/admin` 只会 redirect/challenge/deny。Worker 自身还会用 Cloudflare Access 公钥验证 JWT 的签名、issuer 与 AUD。所有探测通过才输出 `deployed: true`。

部署脚本不会按名称接管现有 Access Application，也不会删除未知 policy。首次创建后立即记录 Application ID；策略失败会使新 Application 保持无 allow policy，并在 Worker 上传前停止。`workers.dev` 和 preview URL 均关闭，防止绕过 custom domain 上的 Access。管理员在 Access 登录后打开 `<gateway>/admin`；浏览器页面从不接收 `ADMIN_TOKEN`，CLI `/v1/admin/*` 仍继续使用它。

从双 Worker 版本升级时，先部署带 Assets binding 的主 Worker，确认 Admin/D1 后删除项目拥有的旧资源路由，再验证资源由新 Worker 提供。失败会尝试恢复原路由和原 Worker 版本，并明确报告恢复失败；不会覆盖其他 Worker 的路由。成功后删除退休的独立 assets Worker。

D1 迁移不是 Worker 版本回滚的一部分。迁移必须向后兼容，破坏性 schema/data 更改需要单独设计迁移和备份计划。本脚本不承诺云端多资源强事务，也不会谎称一次 GET 验证了 Tunnel/DNS 的写权限、实际设备在线或 ChatGPT 调用。

管理员本机应一起备份 `.runtime/admin.json` 与仓库的 `deployment.config.json`。前者的 `masterKey` 用于解密 D1 中的设备凭据，后者记录本项目明确拥有的 D1 ID；不能为了“重新部署”随手重新生成或按名称接管陌生数据库。再次部署只复用这组已记录资源。CI 的 `ADMIN_TOKEN`、`MASTER_KEY` 和两类 Cloudflare Token 存在 GitHub `production` Environment；不要为迁移配置而生成新主密钥。临时 `deployment-recovery.json` 仅记录非秘密资源 ID，部署临时 secrets 文件在退出时删除。

请求日志仅包含 `requestId`、内部枚举 `operation`、状态码、错误码和耗时。`/health`、控制接口、MCP 与资源响应统一带 request ID；不记录凭据、动态路径、源码或 Shell 内容。

不会自动修改收费套餐、迁移已有 DNS 服务、部署 VPS 或把管理员电脑当作 Gateway。即便脚本不购买套餐，仍应确认账号自身的套餐和免费用量；已有付费账号的超额用量可能产生账单，不能将“未点击升级”当作无限免费。

`internal-free` 发布不把 Apple 付费凭据作为发布 gate。若 GitHub `production` 环境完整配置 Developer ID Application/Installer P12 与 App Store Connect API Key，macOS job 会在临时 keychain 中依次 codesign 内层 Tray.app 和安装 App、签名 PKG、提交 `notarytool --wait`、staple 并验证，然后无论成功失败都删除临时材料；只配置一部分字段会失败而不会生成身份不明的发布物。完全未配置时仍明确产出 unsigned/unnotarized 内部包，不能把它描述为已完成签名或公证。

## 设备网络条件

`cloudflared` 从设备建立出站连接，不开放员工机器的入站端口。公司网络仍需允许 Cloudflare Tunnel 的出站流量；“不需要公网 IP”不等于能绕过公司网络策略。Tunnel 用官方客户端重连，Team DevSpace 不实现另一套隧道或重连协议。

设备本机只监听 loopback。设备入口还需有效 Device Secret 与 Device Binding，知道随机子域名或 Tunnel 地址不等于获得 MCP 使用权限。

## 凭据与故障处理

- 员工 Key 泄露：撤销旧 Key，签发新 Key。`device reset` 不是凭据轮换，不能修复已泄露的 Key。
- `cleanup_pending`：该 Key 已被拒绝路由，但 Cloudflare 清理尚未完成。清理顺序为禁用 ingress、轮换 Tunnel Secret、断开所有 connectors、删除 Tunnel 和所属 DNS，避免旧 Token 在清理与删除之间重新连接。重复同一个 revoke/reset 动作，直到返回 `cleanup: complete`。
- 同机修复：重新运行安装器或 `setup`，使用保留的安装标识与私有 Secret。不要删除状态后假装仍是原来的 Device。
- 换电脑：管理员重置后再在新电脑 Enrollment。持有旧电脑完整私有状态的攻击者不在硬件证明保护范围内；当前版本没有硬件证明或企业身份验证。
- 离线：返回明确不可用。不会自动选择其他员工的电脑，也不会自动重放已经可能执行过的写命令。

## 参考

- Cloudflare Tunnel API 管理：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
- Tunnel token：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/
- D1 Sessions：https://developers.cloudflare.com/d1/best-practices/read-replication/
- Workers 定价：https://developers.cloudflare.com/workers/platform/pricing/
- Windows Job Objects：https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
