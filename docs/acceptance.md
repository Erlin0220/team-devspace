# 真实设备与 ChatGPT 验收

## 证据不能互相替代

单元/边界测试可以证明 D1 的绑定、凭据校验、流量路由和错误处理。原生启动测试可以证明本机运行和停止没有残留。**它们不能代替真实 Cloudflare Tunnel、真实 ChatGPT 工作空间以及另一台 Mac 的验证。**

最终验收需要两台独立设备同时在线，至少一台 Windows、一台 macOS；macOS arm64/x64 两种安装器各自需要原生构建和平台运行证据。用同一电脑启动两个测试进程只能作为开发测试。

## 无凭据的本地验证

```sh
npx --yes npm@11.19.1 ci --no-fund --no-audit
npm run acceptance:local
```

`acceptance:local` 是本机单一发布前门槛：依次执行 source/check、全部测试、distribution contract、Gateway dry-run、当前平台真实 package，然后对刚生成的 packaged artifact 执行 `acceptance:platform`。不要再把单独跑过 `test:tray`、`test:native` 或 `test:installer` 当成整体通过；这些脚本仍可用于定位失败。

Windows 的本地 installer transaction 从生产 manifest/bootstrap 源重新编译一个只更换随机注册表和开始菜单键的隔离自包含 NSIS，避免覆盖已安装的员工版本；它验证首次 Enrollment 503、Repair、覆盖升级、credential 恢复、损坏 payload 修复、A/B 版本回收、卸载和零测试 Task 残留。`test:native` 使用真实 Task Scheduler/runtime/MCP，并额外制造同一 `TEAM_DEVSPACE_HOME` 的未知旧 owner task 与另一 state home 的 foreign task：前者必须被迁移，后者必须保留。packaged Tray 会真实启动第二个进程，第二个进程必须在创建图标前被 OS single-instance guard 拒绝。

每个平台验收成功后会在该 target 的 offline layout 写入 `acceptance.json`，记录 release、commit、source 是否 dirty、入口文件 SHA-256 和实际运行的检查。正式 GitHub `publish=true` 时，Windows 先签名，再直接安装/修复/卸载**最终签名 EXE 本身**；publish job 下载三个平台产物后重新计算入口 SHA-256，只有与验收证据完全一致才允许创建 Release。macOS hosted runner 可以验证最终 PKG/bootstrap 与原生 Tray single-instance，但不能伪装成已验证真实员工 LaunchAgent 登录会话；该限制会明确写进 acceptance evidence。

所有 native/installer smoke 都必须把自己的状态目录和启动项限定在测试作用域并在结束时清理。不要在真实员工设备的状态目录内改造测试夹具。

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
