# Team DevSpace 0.2.3

## 本次修复

- 本地控制中心改用标准 AbortController 管理请求超时，兼容没有 AbortSignal.timeout 的旧版 Safari；请求完成即释放计时器，保留操作结果不确定时的提示，不自动重放更换 Key 等操作。
- macOS 客户端文件损坏后的卸载兜底等待 launchd 完成退出，避免把短暂卸载过程误判为失败；超时仍保留启动恢复文件，不强行删除仍被使用的安装目录。
- macOS 发布验收增加最终 PKG 的卸载后重装、损坏 CLI 后卸载，以及绑定和项目文件保留检查。未新增运行时依赖。

## 同事安装入口

访问组织管理员提供的固定下载站，Apple 芯片选择 arm64，Intel Mac 选择 x64。下载安装不需要 GitHub 登录、临时票据或管理员生成下载链接。安装后再输入管理员发放的 Access Key，选择实际项目目录；在 ChatGPT 的 Team DevSpace 连接中使用同一个 Key，并实际读取一次所选项目中的文件确认完整链路。

系统安装器要求的本机管理员授权，与 Team DevSpace 的 Access Key 是两回事。升级、修复和默认卸载保留原绑定及用户项目；更换 Key 后，ChatGPT 连接也需要使用对应的新 Key。

## 仍需了解的限制

当前为内部使用的未签名、未公证包，不承诺免 Gatekeeper 提示。仅对确认来自本站且校验一致的包，按系统“隐私与安全性”提示批准本次打开；不要关闭整机 Gatekeeper。如果提示损坏或恶意内容，停止安装并检查来源和日志，不把所有安全警告都当作可忽略提示。

macOS 的兼容性目标为 12.0 及以上。Codemagic 的 arm64 原生运行和 x64/Rosetta 运行不能替代所有旧版 macOS、物理 Intel、真实员工权限和公司网络的验证。首启界面、菜单栏外观、真实 Key 绑定及真实 ChatGPT 调用仍须在员工 Mac 上完成最终确认。

Apple 的站外分发与安全授权说明：
- https://developer.apple.com/developer-id/
- https://support.apple.com/102445
