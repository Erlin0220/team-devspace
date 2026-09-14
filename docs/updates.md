# 企业内部客户端更新

## 边界与策略

下载站的四平台验收 catalog 是 `stable` 唯一事实源；Gateway 的既有 D1 保存 `auto`、`minimumSupported`、`enforceAfter` 与乐观并发 revision。管理后台直接显示设备已上报版本，可暂停推广；stable 不能绕过发布验收在表单里任意改写。

先发布 stable，并用真实设备观察，再批准 auto。最低支持版本必须先获得自动推广批准，并设置明确的 UTC 生效时间。到期后 Gateway 返回 `426 client_upgrade_required` 拒绝旧版/未上报版本设备的新远程工作；已开始的响应、流重连、清理、状态、暂停、恢复、换 Key 与本地安装恢复入口不被该策略关闭。Gateway 的策略读取缓存最多 60 秒，设备授权/吊销不被此缓存覆盖。版本上报是受设备凭据保护的资产信息，不是硬件证明或防恶意降级证明。

首次上线默认 `auto=null`、`minimumSupported=null`。0.2.3 及更早客户端没有更新检查器，必须先从固定下载站手动覆盖安装一次 0.2.4；不要先把它们锁在最低版本策略外。将 auto 调低只停止继续推广，不会降级已安装设备。

## 员工体验

Windows/macOS 托盘的“软件更新…”进入现有本机设置页；用户可检查、更新、关闭自动更新。CLI 为 `update check|apply|status` 和 `update auto on|off`，沿用已安装的 Team DevSpace 命令入口。关闭自动更新不等于免除最低版本要求。

检查间隔为 6–7 小时，带随机抖动并持久化，升级后的版本变化会使旧检查缓存失效。绑定及恢复请求同时上报版本，不需要追加高频心跳。Windows/macOS 使用现有桌面控制器；Linux 使用现有运行进程，暂停/退出后没有额外后台 daemon，仍可手动更新。

自动更新只使用管理员批准的 auto，执行前重新确认策略与本机偏好。Bridge 的短时 admission gate 避免在真实 MCP POST 正在执行或刚结束时自动安装；失败、重启或等待超时可恢复。该 gate 不承担安装激活、版本切换或回滚。

Windows 使用当前用户、非提权、无计划触发器的一次性系统任务交接安装器，复用已有 GUI launcher，避免托盘 Job Object 杀死安装器或闪出控制台。任务执行后删除自身。Linux 使用现有 user systemd 的临时单元或无 systemd 环境下的独立安装进程。二者最终都调用现有 installer/bootstrap。

macOS 自动检查和准备更新，但安装仍需用户确认原生 PKG 的系统授权；不引入特权 helper，不绕过 Gatekeeper，也不声称完全静默更新。关闭原生安装窗口不会留下持续暂停远程访问的状态。

更新不重写 Access Key、Device Binding、Current Project Root 或暂停意图。实际候选验证、active pointer 切换、原生启动入口刷新与失败恢复仍由现有安装事务负责。安装结果和延迟原因在本机设置中展示。

## 信任链与发布恢复

客户端内置 Ed25519 公钥。每个新发布的不可变目录包含 `update.json`，签名绑定版本、源提交及四平台规范文件名、大小、SHA-256；签名使用独立域分隔上下文。必须先验证签名，再流式下载并验证完整大小/哈希，最后交给安装器。HTTPS 主机旁的普通 SHA 文件不单独作为自动更新的信任根。仅接受固定源，不跟随下载或元数据重定向，不自动降级。

签名私钥首次在管理员当前用户保护目录 `~/.team-devspace-admin/update-signing/release-key.pem` 生成，不上传 Gateway、下载服务器、仓库或 CI。必须与管理员恢复材料一起离线备份；私钥丢失/泄露需要明确的公钥轮换发布，不能直接覆盖现有客户端信任根。测试只使用临时测试密钥，不给模拟产物签发生产签名。

发布仍要求四平台最终安装入口的 exact-byte、同一干净提交 acceptance。例行交付使用服务器完整哈希与有界公网 HEAD/Range 检查，避免四个包反复全量公网下载。新上传不会立即改变 stable。

切 stable 和清理期间，发布者使用同一 D1 策略行的 15 分钟自动过期租约，防止管理员同时引用正被删除的旧版本。崩溃最多暂时阻止策略编辑，不阻止设备连接。服务器继续使用既有 SSH、flock、stable CAS 和 activation log；不增加发布服务。

保留 stable、auto、minimumSupported 引用的版本以及最近已知稳定前驱，只删除无引用、非恢复必需的旧产物。0.2.3 的不可变字节不补签或改写，它作为原有手动恢复路径保留。切回较低 stable 前先撤回不兼容的 auto/minimum；回退下载入口不自动回退已安装设备。

## 管理接口

后台 `/admin` 使用现有 Cloudflare Access。管理员 CLI 支持 `update-policy show` 与 `update-policy set <policy.json>`。写入文件仅包含 `revision`、`auto`、`minimumSupported`、`enforceAfter`；使用 show 读取当前 revision，空策略使用 JSON null。过时的 revision、未完整发布或未通过签名验证的推广版本均拒绝。

## 官方设计依据

- Tailscale 更新与系统策略：复用安装方式，稳定观察后推广，不增加复杂调度。https://tailscale.com/kb/1067/update https://tailscale.com/docs/features/tailscale-system-policies
- VS Code Enterprise updates：区分更新发现、用户更新设置和企业管理。https://code.visualstudio.com/docs/enterprise/updates
- Chrome Enterprise 的 ChromeOS 最低版本策略：最低支持门槛与宽限时间；本项目仅借鉴治理语义，不声称桌面 Chrome 具有相同 API。https://chromeenterprise.google/intl/en_uk/policies/device-minimum-version/
- Cloudflare WebCrypto：Ed25519 签名验证。https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

这些产品的服务端、签名系统与特权能力不直接搬入当前薄客户端。
