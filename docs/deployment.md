# 部署与凭据

## 发布前提

使用有权管理的 Cloudflare Account 与 DNS Zone；该 Zone 已在 Cloudflare 正常解析。准备一个**全新的单层子域名**作为 Team Gateway，例如 `team-devspace.example.com`。每台设备自动获得另一个同级子域名 `tds-<随机绑定标识>.example.com`，避免依赖多级通配证书。

本项目的固定目标在 `release.config.json`。目标域名与员工安装包内的配置必须一致。部署脚本发现域名已指向其他 Worker 或已有不属于本项目的 DNS 时会停止，不覆盖现有个人服务。

## 两种 Cloudflare API 令牌

令牌均限定到实际使用的 Account / Zone，不能选择所有账号或所有区域。

| 用途 | Account 权限 | Zone 权限 | 保存位置 |
| --- | --- | --- | --- |
| 管理员部署 | Workers Scripts Edit、D1 Edit | DNS Edit、Zone Read | 本机 `.runtime/cloudflare.json` |
| Worker 运行时建 Tunnel | Cloudflare Tunnel Edit | DNS Edit | Worker Secret `CF_API_TOKEN` |

这些是 Cloudflare 管理令牌，**不是员工的 Access Key**。员工安装包和 Employee 电脑只得到自己 Tunnel 的运行 token，不得到以上账号级令牌。

在自己电脑的项目终端运行 `npm run configure`。输入使用密码框；不要通过聊天、环境变量截图、GitHub Issue 或提交文件传递秘密。配置文件所在目录会限制为当前用户可访问。

仓库已有的 Cloudflare 账号 ID / Zone ID 只是预填元数据，不代表 Worker/D1 已获授权。拥有旧的 cloudflared 证书，也不代表有 Worker 部署权限。

## 可重复的部署动作

`npm run deploy` 按以下顺序处理：校验新域名归属；查找或创建项目 D1；保存可复用的管理员密钥与主密钥；应用数据库迁移；以单次 Worker 部署安装代码和 Secret；验证公网健康接口。

管理员本机应一起备份 `.runtime/admin.json` 与 `.runtime/deployment.json`。前者的 `masterKey` 用于解密 D1 中的设备凭据，后者记录本项目明确拥有的 D1 ID；不能为了“重新部署”随手重新生成或按名称接管陌生数据库。再次部署只复用这组已记录资源。

不会自动修改收费套餐、迁移已有 DNS 服务、部署 VPS 或把管理员电脑当作 Gateway。即便脚本不购买套餐，仍应确认账号自身的套餐和免费用量；已有付费账号的超额用量可能产生账单，不能将“未点击升级”当作无限免费。

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
