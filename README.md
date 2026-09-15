# Team DevSpace

让共享的 ChatGPT 工作空间 App 根据每名员工自己的 Access Key，连接到对应电脑上的官方 DevSpace。

**Source-available · PolyForm Shield 1.0.0。** 原创代码适用未经修改的 [LICENSE](LICENSE)，不是 OSI 开源许可。第三方组件保留各自许可证，见 [NOTICE](NOTICE) 和 [第三方说明](LICENSES/README.md)。公开源码不授予任何生产服务的访问权限。

## 工作方式

```text
ChatGPT + 每位员工的 Access Key
              ↓
Cloudflare Worker + D1 → Key / Device Binding
              ↓
该设备专属 Cloudflare Tunnel
              ↓
本机薄认证适配 → 官方 DevSpace
```

一个 Key 同时绑定一台设备，支持多个会话。重置允许重新绑定，撤销立即拒绝后续访问；设备离线不会转发到别人的电脑。Gateway、Admin 和公共静态资源复用同一个 Worker。Windows/macOS 原生托盘负责展示，操作复用共享控制器和系统生命周期，不增加第二套 supervisor。

**选择项目目录不是 Shell 沙箱。** 开发命令以员工的系统账户运行；持有有效 Access Key 的人可以调用该账户的开发能力。仅把 Key 交给被授权的使用者。

## 员工安装

从组织管理员提供的**正式下载站或正式发行包**下载对应平台安装器，安装后输入管理员发放的 Access Key、选择项目目录，再连接共享 App。不需要 GitHub 登录，也不需要每人一个下载链接。

支持 Windows x64、macOS ARM64 / Intel x64 和 Linux x64。具体版本、最低系统版本及工具链以 [release.config.json](release.config.json)、锁文件和 `scripts/binaries.json` 为准，不以 README 中的版本快照为准。

安装包自包含 Node、DevSpace、cloudflared 和按需使用的 Windows PortableGit；员工机器不执行 npm 安装。覆盖升级保留 Key、绑定、项目目录与暂停意图。卸载保留员工配置和项目文件；退休设备还需管理员撤销 Key。内部发行的系统签名限制见 [内部发行与信任](docs/internal-distribution.md)，不要关闭整机 Gatekeeper 或 SmartScreen。

本仓库默认是**不可连接生产的示例发行配置**。`gateway.example.com`、`downloads.example.com` 和示例公钥不是可用服务，开发构建不能发给员工。正式构建由管理员注入组织配置；配置不包含员工 Key。

## 开发与贡献

使用锁定的 Node/npm，按 Issue → 分支 → PR → CI / Review → Squash Merge 工作；不要在 `main` 日常开发。单维护者不要求自我 Approval，但仍需要 PR、测试和处理 review threads。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
npx --yes npm@11.19.1 ci --no-audit --no-fund
npm run check
npm test
npm run deploy -- --dry-run
```

最后一个命令只打包 Gateway，不部署、不执行生产迁移。Windows 测试需要 Git for Windows 的 Bash，不应误用系统的 WSL Bash 启动器。

报告漏洞请先阅读 [SECURITY.md](SECURITY.md)。不要在公开 Issue、日志或截图中提供 Key、令牌、员工路径或未经脱敏的诊断文件。

## 构建、发布与更新

[原生候选工作流](.github/workflows/build-installers.yml)使用 Windows、Linux、macOS ARM64 和原生 Intel runner；构建手动触发，不因每次 PR 自动消耗四平台打包额度。示例候选与生产配置候选明确分开，工作流不自动发布或调整版本策略。

**迁移状态：原生 GitHub 四平台工作流尚需实际运行验收。** 现有 Codemagic / 本地构建保留为过渡回退，不代表已经完成替代。构建成功也不等于跨版本安装、员工 UI、Gatekeeper 和真实 ChatGPT 验收成功。见 [公开准备状态](docs/public-readiness.md)。

发行复用原安装器、不可变版本、Ed25519 更新签名和 `stable / auto / minimumSupported / enforceAfter`。正式包必须与验收的提交、发行配置及最终字节一致。不能重建已发布的同一版本，也不能重新生成现有客户端信任的更新密钥。

GitHub Releases 是后续大文件分发的候选，而不是已经切换的生产源。旧客户端拒绝 HTTP 重定向，直接把旧下载地址改成 302 会破坏更新。现有静态下载源和旧版恢复包继续保留，待兼容客户端、公开匿名下载和四平台验证完成后再迁移。见 [分发迁移说明](docs/public-readiness.md#发行链与下载迁移)。

## 管理员部署

生产资源标识、管理员邮箱和凭据均在源码之外管理。复制 `config/*.example.json` 为私有 `.runtime` 配置，或通过受保护的 GitHub `production` Environment 注入；正式发行参数用 `TEAM_DEVSPACE_RELEASE_PROFILE` 或 `TEAM_DEVSPACE_RELEASE_PROFILE_JSON` 显式选择，不能同时设置两者。

详见 [部署说明](docs/deployment.md)。部署和公开仓库是两个独立决定；合并 PR 不授权部署，切换仓库可见性不授权更换生产发行源。

## 更多资料

[架构与术语](CONTEXT.md) · [更新策略](docs/updates.md) · [安装验收](docs/acceptance.md) · [发行布局](docs/distribution.md) · [历史验证记录](docs/verification.md)

历史记录描述当时的证据，不保证当前源码或候选已经通过同样验收。当前公开准备结论以 `docs/public-readiness.md` 为准。
