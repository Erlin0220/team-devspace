# 验收异常记录 — 2026-09-13

## Windows 真实换 Key 的首次失败

首次 `tray-live-smoke --live --runtime-root build/bundle-win32-x64` 完成真实 Gateway/Tunnel 就绪、暂停、恢复、认证 MCP、重启和 Repair 后，在换 Key 后等待就绪超时：runtime/bridge 为 false，Tunnel/Gateway 正常。首次运行只记录了有限的监听事件，没有足够证据确定原因；不能声称这一偶发失败已被某个生命周期补丁修复。

随后补齐验收失败前的产品脱敏诊断，不增加重试次数、不放宽就绪条件。独立复测完整通过，包括换 Key 后身份/项目保留、旧绑定释放、退出、临时 Key 清理及员工状态未变。又增加三轮连续换 Key，每轮经真实公网 MCP 执行 open_workspace、write、read 和 bash；三轮均通过。该测试只使用独立临时目录和两个测试 Key，不修改员工的 Key。

证据分别位于忽略的 `build/windows-live-20260913.*.log`、`build/windows-live-recheck-20260913.*.log` 和 `build/windows-live-repeat-20260913.*.log`；首次失败没有被改写成通过。后续成功不构成对首次失败根因的证明。

## 工具调用的独立限制

一次同时请求公开上游源码和本机日志摘要的 DevSpace bash 调用被安全检查拦截，未执行结果不可用。该拒绝没有被归因为产品运行失败，也没有关闭保护或重试该组合探针。公开源码通过已授权的官方 GitHub 连接器阅读；正常源代码审查和明确授权的独立产品测试另行记录。不要把这个工具层事件当作 Windows runtime 的故障根因。

三端验收的范围及 fixture/真实云连接区别见 `docs/tailscale-client-review-2026-09-13.md`；是否通过以各次实际输出、产物哈希和 Codemagic 构建记录为准，不由本记录推定。
