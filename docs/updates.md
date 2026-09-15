# 企业内部客户端更新

## 边界与策略

下载站经四平台验收并签名的 `/update.json` 是新版本 `stable` 的发现入口，其签名 payload 绑定验收 catalog；Gateway 的既有 D1 保存 `auto`、`minimumSupported`、`enforceAfter` 与乐观并发 revision。管理后台直接显示设备已上报版本，可暂停推广；stable 不能绕过发布验收在表单里任意改写。仅历史 0.2.3 及更早版本保留下述手动恢复例外。

先发布 stable，并用真实设备观察，再批准 auto。最低支持版本必须先获得自动推广批准，并设置明确的 UTC 生效时间。到期后 Gateway 返回 `426 client_upgrade_required` 拒绝旧版/未上报版本设备的新远程工作；已开始的响应、流重连、清理、状态、暂停、恢复、换 Key 与本地安装恢复入口不被该策略关闭。Gateway 的策略读取缓存最多 60 秒，设备授权/吊销不被此缓存覆盖。版本上报是受设备凭据保护的资产信息，不是硬件证明或防恶意降级证明。

首次上线默认 `auto=null`、`minimumSupported=null`。0.2.3 及更早客户端没有更新检查器，必须先从固定下载站手动覆盖安装一次 0.2.4；不要先把它们锁在最低版本策略外。将 auto 调低只停止继续推广，不会降级已安装设备。

当前客户端协议仍要求设置最低支持版本时满足 `minimumSupported <= auto <= stable`，因此 `auto=null` 不能同时保留 minimum；三个概念分工不同，不代表字段之间没有约束。Admin 清除 minimum（包括选择暂停推广导致清除）必须明确确认解除限制。只需暂停问题版本的继续推广时，优先把 auto 调回一个不低于 minimum 的已验证版本；不要隐式放开旧客户端，也不要在旧客户端仍使用当前校验器时直接引入 `auto=null + minimum!=null` 的不兼容策略。

## 状态接口的 Expand / Migrate / Contract

`bbedda8` 先完成了 Expand；0.2.5 起客户端使用 `/v1/device/status-v2`。2026-09-15 经管理员明确批准进入 Contract：生产 Cloudflare WAF 在 Worker 之前阻断 Gateway 退休的 `/v1/device/status`，并对该 Gateway 主机执行产品 namespace 之外的默认拒绝；Worker 同时删除旧路由，只保留 `/v1/device/status-v2`。WAF 不覆盖同 Zone 的其他服务或动态 `tds-*` 设备 Tunnel。最低版本门禁仍只限制新的远程工作；版本上报和本地升级恢复入口继续可用。

发布阶段按以下顺序完成，代码审查不执行这些生产操作：

1. 先应用向后兼容的 D1 加法迁移，再部署双接口 Gateway，并检查旧客户端仍可工作。既有部署脚本已经按此顺序执行；新 Worker 不能先于 `0005_update_inventory.sql` 上线。
2. 在该 Gateway 上完成最终客户端构建、跨版本验收与发布。0.2.4 已有 updater 但仍使用旧 status；0.2.3 及更早版本需要手动覆盖安装。版本别名更新不等于设备已升级。
3. 根据实际安装、受支持设备清单和低频版本快照确认迁移，同时处理长期离线设备与失败恢复。不能把短时没有请求、单条快照或源码版本号当作全量迁移证明。迁移后的 Gateway 回滚目标也必须支持 v2。
4. Contract 已于 2026-09-15 独立实施：Cloudflare `http_request_firewall_custom` 中唯一项目自有规则 `team-devspace-gateway-surface` 在 Edge 同时终止旧 status 和未知 Gateway 路径，因此它们不再进入 Worker；Worker 代码也删除旧路由，避免 Edge 规则意外移除后恢复旧协议。0.2.4 可继续通过既有 updater 升级；0.2.3 及更早版本按既有规则手工覆盖安装。Gateway 回滚必须保留 v2 支持，不能回滚到只支持旧 status 的版本。

Worker 内提前返回错误仍消耗 Worker 请求，所以 Contract 使用 Edge Block，而不是在 Worker 内做 410/426 墓碑。新客户端的本地展示缓存与低频更新检查保持不变；MCP 鉴权不使用展示缓存。

## 员工体验

Windows/macOS 托盘的“软件更新…”进入现有本机设置页；用户可检查、更新、关闭自动更新。CLI 为 `update check|apply|status|repair` 和 `update auto on|off`，沿用已安装的 Team DevSpace 命令入口。`update repair` 是显式重装当前版本的签名安装包，不是连接 Repair，不自动触发，也不会降级。该版本已经从服务器回收时，应使用固定下载站升级，不能绕过签名或换一个来源。关闭自动更新不等于免除最低版本要求。

手动检查发现新版本时，本机设置页读取固定下载源 `/releases/<version>/release-notes.txt` 的有界摘要并自动打开确认框；完整说明仍直接链接下载源，读取失败不阻止签名更新。后台发现只更新入口提示，不弹确认框；检查操作本身永不安装。确认绑定当次目标版本，下载完成后若 stable 已变化则要求重新检查，不能静默安装另一个版本。

Local WebUI listens on loopback only. `53682` is the preferred first port; the selected port is persisted in private `control-endpoint.json` and reused across normal restarts/upgrades. A short-lived old owner is retried for a bounded period, while a persistent collision migrates to a browser-safe high port and stores the new endpoint. If an existing endpoint migrates, rotate its local capability and open the new Control Center; the abandoned origin must not keep a credential accepted by the new endpoint. Control Center port/assets/browser failures affect only that auxiliary surface and must not terminate Tray, Runtime, Bridge, or Tunnel. The private capability still survives normal upgrades and is delivered only through the URL fragment; Host, Origin, Fetch Site, Authorization and CSP checks remain unchanged.

检查间隔为 6–7 小时，带随机抖动并持久化，调度器按这个 deadline 唤醒，而不是在缓存命中后重新加上 6 小时。检查失败至少等待一小时；429/503 的有效 `Retry-After` 可以延长后台等待，但最多 24 小时。失败缓存也记录当前运行版本，首次失败或升级后失败不会因为重启绕过退避。时钟回拨或安装版本变化会使旧检查缓存失效。退出会取消在途检查（含手动检查）和下载，不写入假失败。绑定及恢复请求同时上报版本，不需要追加高频心跳。Windows/macOS 使用现有桌面控制器；Linux 使用现有运行进程，暂停/退出后没有额外后台 daemon，仍可手动更新。

自动更新只使用管理员批准的 auto，执行前重新确认策略与本机偏好。下载可以先完成，激活仍由本机操作和 Bridge 的 admission gate 把关；返回的延迟原因也会保留。忙碌后每十分钟只先重新检查本机操作/Bridge readiness，仍忙时不重新拉取策略或扫描整个安装包。macOS 已准备、等待系统授权的状态不会每次唤醒都重复准备。该 gate 不承担安装激活、版本切换或回滚。Gateway 保留经过设备认证的 `client_update_in_progress`，附带 30 秒 `Retry-After`，不把它误报成设备离线，也不透传上游错误正文。

Windows 使用当前用户、非提权、无计划触发器的一次性系统任务交接安装器，复用已有 GUI launcher，避免托盘 Job Object 杀死安装器或闪出控制台。任务执行后删除自身。Linux 使用现有 user systemd 的临时单元或无 systemd 环境下的独立安装进程。二者最终都调用现有 installer/bootstrap。

macOS 自动检查和准备更新，但安装仍需用户确认原生 PKG 的系统授权；不引入特权 helper，不绕过 Gatekeeper，也不声称完全静默更新。关闭原生安装窗口不会留下持续暂停远程访问的状态。

更新不重写 Access Key、Device Binding、Current Project Root 或暂停意图。实际候选验证、active pointer 切换、原生启动入口刷新与失败恢复仍由现有安装事务负责。安装结果和延迟原因在本机设置中展示。检查和安装使用不同的锁身份；安装锁一直覆盖异步系统交接。未确认的安装尝试在请求策略或扫描安装包之前拒绝重复执行。Windows/Linux 交接结果携带 attemptId，旧任务的结果不能解除新任务的防重入保护。调度器保存实际准备/交接的目标版本，不能用较早检查缓存中的 auto 覆盖它。

低频检查会回收不再需要的规范下载文件，保留当前版本、stable/auto 和仍被交接记录引用的安装包。清理与 apply 共享锁；不递归删除未知目录/文件，不跟随版本目录中的符号链接。退出遗留且超过一天的规范 `.part` 可回收。这不是已安装 payload 的回滚策略。

## 信任链与发布恢复

客户端内置 Ed25519 公钥。每个新发布的不可变目录包含 `update.json`，签名绑定版本、源提交及四平台规范文件名、大小、SHA-256；签名使用独立域分隔上下文。必须先验证签名，再流式下载并验证完整大小/哈希，最后交给安装器。HTTPS 主机旁的普通 SHA 文件不单独作为自动更新的信任根。仅接受固定源，不跟随下载或元数据重定向，不自动降级。

Gateway 的 stable 发现也验证 `/update.json`，对成功结果做最多 60 秒的内存缓存与并发合并，不为每个设备重复向下载站请求。策略写入重新读取，不能使用缓存批准新版本。仅 root update 返回 404 且 catalog 不高于 0.2.3 时保留历史手动恢复路径；新的缺失/无效签名不降级到普通 catalog。签名真实性不等于防冻结，当前没有宣称实现 TUF 的过期/根密钥恢复协议。

签名私钥首次在管理员当前用户保护目录 `~/.team-devspace-admin/update-signing/release-key.pem` 生成，不上传 Gateway、下载服务器、仓库或 CI。必须与管理员恢复材料一起离线备份；私钥丢失/泄露需要明确的公钥轮换发布，不能直接覆盖现有客户端信任根。测试只使用临时测试密钥，不给模拟产物签发生产签名。

发布仍要求四平台最终安装入口的 exact-byte、同一干净提交 acceptance。例行交付使用服务器完整哈希与有界公网 HEAD/Range 检查，避免四个包反复全量公网下载。新上传不会立即改变 stable。

切 stable 和清理期间，发布者使用同一 D1 策略行的 15 分钟自动过期租约，防止管理员同时引用正被删除的旧版本。崩溃最多暂时阻止策略编辑，不阻止设备连接。服务器继续使用既有 SSH、flock、stable CAS 和 activation log；不增加发布服务。

保留 stable、auto、minimumSupported 引用的版本以及最近已知稳定前驱，只删除无引用、非恢复必需的旧产物。0.2.3 的不可变字节不补签或改写，它作为原有手动恢复路径保留。切回较低 stable 前先撤回不兼容的 auto/minimum；回退下载入口不自动回退已安装设备。

## 管理接口

后台 `/admin` 使用现有 Cloudflare Access。管理员 CLI 支持 `update-policy show` 与 `update-policy set <policy.json>`。写入文件仅包含 `revision`、`auto`、`minimumSupported`、`enforceAfter`；使用 show 读取当前 revision，空策略使用 JSON null。过时的 revision、未完整发布或未通过签名验证的推广版本均拒绝。

设备通过现有 `/v1/device/version` 可选上报 `updateReport`，只含目标版本、有限状态和错误代码，不接收日志、项目路径或凭据。D1 migration `0005_update_inventory.sql` 为加法迁移；不支持该字段的旧客户端仍可上报版本，旧 Gateway 可忽略新字段。相同快照不重复写入，新快照与版本库存共用原来的上报时机，未新增心跳。同版本/平台的旧式上报不擦掉快照；版本或平台变化而未携带新快照时，清除旧快照，避免新版本继承旧安装结果。Admin 明确显示这是低频快照及上报时间，不是实时在线/安装进度。安装器 exitCode=0 但当前运行版本仍旧时，只报告等待重启确认，不报告新版本已经运行；设备 Reset 会清除快照。

该快照通常随 6–7 小时检查或手动检查更新；不要把它当成实时发布监控或强制自动推广的充分验收条件。原生签名、真实跨版本安装和灰度观察仍是独立交付边界。研究取舍与本轮验证见 `docs/ops/update-review-2026-09-14.md`。

## 官方设计依据

- Expand/Migrate/Contract 接口迁移：先扩展服务端兼容面，再迁移消费者，最后删除旧接口。https://martinfowler.com/bliki/ParallelChange.html
- Cloudflare Worker/静态资源计费与 D1 查询计划：真正绕过 Worker 才减少该请求用量；索引使用应通过查询计划和 rows_read 验证。https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ https://developers.cloudflare.com/d1/best-practices/use-indexes/
- Tailscale 更新与系统策略：复用安装方式，稳定观察后推广，不增加复杂调度。https://tailscale.com/kb/1067/update https://tailscale.com/docs/features/tailscale-system-policies
- VS Code Enterprise updates：区分更新发现、用户更新设置和企业管理。https://code.visualstudio.com/docs/enterprise/updates
- Chrome Enterprise 的 ChromeOS 最低版本策略：最低支持门槛与宽限时间；本项目仅借鉴治理语义，不声称桌面 Chrome 具有相同 API。https://chromeenterprise.google/intl/en_uk/policies/device-minimum-version/
- Cloudflare WebCrypto：Ed25519 签名验证。https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

这些产品的服务端、签名系统与特权能力不直接搬入当前薄客户端。
