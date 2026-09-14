# 更新与状态迁移复审：2026-09-15

## 审查边界

基线为实际工作区 `bbedda8` 加已有未提交修改，不是只审 HEAD。保留其他会话的 UI/Updater 工作；本轮没有暂存、提交、推送、安装包构建、Codemagic、发布、Gateway 部署、生产 D1 migration 或生产版本策略修改。审查过程中三个本地 UI 文件发生并发修改，未覆盖；其最后修改早于最终回归运行。

## 结论

保留薄控制层、低频 pull、现有 installer/bootstrap 与独立签名元数据。代码可作为统一构建和发布前验收的基础，但本轮不构成最终安装包或生产环境验收。

`bbedda8` 的双接口 Expand 正确：旧、新 status 都由 Worker 鉴权；v2 客户端发布前必须先上线兼容 Gateway。Contract 是后续独立变更，不能根据源码版本或别名已更新就执行。Gateway 回滚也必须与已迁移客户端兼容。具体顺序与旧客户端恢复边界见 `../updates.md`。

## 本轮直接修复

- Gateway 策略缓存：并发 miss 合并为一次 D1 读取；失效前的旧读取和 fresh 读取之间通过缓存 entry 身份隔离，旧响应不能覆盖新策略。
- 检查失败缓存：记录当前运行版本，使首次失败、升级后失败在重启时仍遵守退避。
- 实际目标版本：自动更新结果和准备失败保留本次实际选择的版本，不再被旧检查缓存的 auto 覆盖。
- 重复安装门禁：未确认的 attempt 在网络请求及安装包哈希扫描前拒绝重复准备；保留既有时限、attemptId 和系统安装链。
- 本地退出：手动检查更新接收控制器取消信号，不再等网络结束或记录一次假的退出失败。
- 库存一致性：同版本/平台的旧式上报保留已有快照；运行版本/平台变化而未提供新报告时清除旧报告。
- Admin 安全反馈：移除 minimum 时明确确认解除限制，覆盖暂停 auto 连带清除 minimum 的场景；保持现有客户端策略校验兼容。

另外修正旧 UI 回归断言：主动检查应以真实完成反馈替换上一条生命周期提示，而不是要求所有提示消失。没有回退新 UI 的完成反馈。

## 验证证据

针对新问题先新增回归：7 项初始失败，修复后通过。最终运行 Gateway/status/static routing、updater/lifecycle/report/cache、Admin、desktop controller/UX、真实本地 DevSpace/Bridge 请求链共 84 项，84 通过、0 失败、0 跳过。

最终日志：`.runtime/review-2026-09-15-tests.log`（本地忽略目录，不含生产凭据）。

关键覆盖：

- 新旧 status 的 active/suspended、错误凭据/绑定、Reset 后旧凭据失效、Revoke，以及最低版本生效后仍可读取状态。
- 已有设备数据应用 `0005` 后保持绑定；旧式版本写入仍可执行；未变更测试策略默认值。
- 在本地 D1 的 2,000 条已吊销历史记录上，捕获 `KeyStore.cleanupCandidates()` 实际 SQL，通过 EXPLAIN 确认两个 partial index 被使用，空候选扫描的 rows_read 均小于 10。
- 真实本地 MCP 请求执行期间拒绝更新 drain；安装准备期间拒绝新 POST；释放 drain 后恢复请求。
- 取消、失败退避、跨 attempt 结果、待授权状态、缓存清理的符号链接/未知文件保护，以及默认不降级。

`node scripts/check.mjs`、Admin JavaScript 语法检查、`git diff --check`、Windows 更新 helper 的 PowerShell AST 解析，以及经 WSL 执行的 Unix helper `sh -n` 解析通过。两种 helper 均只解析、不执行。没有运行会编译合成安装器或创建系统更新任务的 native handoff 验收。

## 后续发布阶段门槛

冻结并汇合仍在修改的工作区后，以同一最终提交构建四个平台产物；验收升级前后的身份、绑定、目录、暂停、失败恢复与原生交接，再发布通过验收的同一字节。生产先加法 migration、后兼容 Gateway；客户端迁移和真实观察完成后再分别决定 auto/minimum 推广与旧接口 Contract。

保留 stable/auto/minimum 引用版本和已知良好前版；库存是低频观察，不是实时健康或完整迁移证明。长期离线设备、0.2.3 及更早的手动覆盖升级和 v2 兼容回滚需要单独确认。本轮没有生产用量测量，因此不声称实际 Cloudflare 账单已经降低。

## 一手参考

- Parallel Change / Expand-Migrate-Contract: https://martinfowler.com/bliki/ParallelChange.html
- Cloudflare Workers static assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Cloudflare D1 index validation: https://developers.cloudflare.com/d1/best-practices/use-indexes/
- Tailscale existing-installation update paths: https://tailscale.com/docs/features/client/update
