// Public delivery metadata is separate from the embedded runtime-component manifest.
export const DOWNLOAD_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
export const SHA256 = /^[a-f0-9]{64}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const ALIASES = { 'win32-x64': 'windows-x64.exe', 'darwin-arm64': 'macos-arm64.pkg',
  'darwin-x64': 'macos-x64.pkg', 'linux-x64': 'linux-x64.tar.gz' };

export function packageName(version, target) {
  if (!VERSION.test(version ?? '') || !DOWNLOAD_TARGETS.includes(target)) throw new Error('Invalid package identity');
  const suffix = { 'win32-x64': 'windows-x64-setup.exe', 'darwin-arm64': 'macos-arm64.pkg',
    'darwin-x64': 'macos-x64.pkg', 'linux-x64': 'linux-x64-offline.tar.gz' }[target];
  return `Team-DevSpace-${version}-${suffix}`;
}

export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== value ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname)) {
    throw new Error('Downloads origin must be a canonical HTTPS origin without credentials, port or path');
  }
  return url.origin;
}

export function validateCatalog(value) {
  if (value?.schema !== 1 || !VERSION.test(value.version ?? '') || !/^[a-f0-9]{40}$/.test(value.commit ?? '') ||
      !value.targets || Object.keys(value.targets).sort().join() !== [...DOWNLOAD_TARGETS].sort().join()) {
    throw new Error('A download release requires one accepted build for each of the four targets');
  }
  for (const target of DOWNLOAD_TARGETS) {
    const asset = value.targets[target];
    if (!asset || asset.file !== packageName(value.version, target) || !SHA256.test(asset.sha256 ?? '') ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3) {
      throw new Error(`Invalid download package: ${target}`);
    }
  }
  return value;
}

export function packageUrls(catalog, origin) {
  validateCatalog(catalog); httpsOrigin(origin);
  return Object.fromEntries(DOWNLOAD_TARGETS.map(target =>
    [target, `${origin}/releases/${catalog.version}/${catalog.targets[target].file}`]));
}

const html = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function downloadPage(catalog, origin) {
  const urls = packageUrls(catalog, origin);
  const names = { 'win32-x64': 'Windows x64', 'darwin-arm64': 'macOS Apple Silicon',
    'darwin-x64': 'macOS Intel', 'linux-x64': 'Linux x64' };
  const prefix = `${origin}/releases/${catalog.version}`;
  const cards = DOWNLOAD_TARGETS.map(target => {
    const item = catalog.targets[target];
    return `<article><h2>${names[target]}</h2><p>${(item.size / 1024 ** 2).toFixed(1)} MiB</p>` +
      `<a class="download" href="${urls[target]}">下载安装包</a> <a href="${urls[target]}.sha256">SHA-256</a></article>`;
  }).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team DevSpace 下载</title>
<style>body{font:16px/1.7 system-ui,sans-serif;color:#1d2939;background:#f6f8fb;margin:0}main{max-width:960px;margin:auto;padding:40px 24px}h1{font-size:32px;margin-bottom:8px}h2{font-size:19px}a{color:#145dc0}nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}article,section{background:white;border:1px solid #dce3eb;border-radius:10px;padding:20px;margin-bottom:16px}.download{display:inline-block;padding:8px 12px;background:#145dc0;color:white;border-radius:6px;text-decoration:none;margin:0 8px 8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f4f8;padding:14px;border-radius:6px}small{color:#536274}footer{margin-top:24px;font-size:14px}</style></head><body><main>
<h1>Team DevSpace</h1><p>版本 <strong>${catalog.version}</strong> · 同一份软件，安装完成后在应用内输入管理员发放的 Access Key。</p>
<nav><a href="${origin}/">当前稳定版</a><a href="${origin}/releases/">历史版本</a><a href="${prefix}/catalog.json">版本与文件清单</a><a href="${prefix}/SHA256SUMS">全部校验值</a><a href="${prefix}/release-notes.txt">更新说明</a></nav>
<div class="cards">${cards}</div>
<section><h2>固定安装入口</h2><p>以下命令通过 HTTPS 获取并执行本站安装脚本。脚本先校验固定版本安装包的 SHA-256，再调用系统安装器；可先打开脚本检查内容。</p>
<p>Windows · PowerShell</p><pre>${html(`irm ${origin}/install.ps1 | iex`)}</pre>
<p>macOS / Linux · 终端（自动识别系统与 Mac 架构）</p><pre>${html(`curl -fsSL ${origin}/install.sh | sh`)}</pre>
<p><a href="${origin}/install.ps1">查看 PowerShell 脚本</a> · <a href="${origin}/install.sh">查看 Unix 脚本</a></p></section>
<section><h2>安装、升级与恢复</h2><p>无需下载票据、GitHub 登录或在安装命令中填写密钥。Windows/macOS 安装后打开 Team DevSpace 完成连接设置；Linux 安装后运行 <code>~/.local/bin/team-devspace setup</code>。更换密钥无需重装。</p>
<p>再次运行固定入口可升级；旧版本可从历史页下载。软件升级保留设备身份、项目目录与暂停状态。稳定版回滚只改变后续下载，不会偷偷降级已经运行的客户端；客户端降级应先确认状态格式兼容。</p>
<p>当前采用 internal-free 信任模式：不承诺 Windows 公共签名或 Apple Developer ID/公证。保留系统安全确认，不关闭 Gatekeeper、不自动信任根证书。SHA-256 校验防止损坏，不是独立于本站 HTTPS 的代码签名。</p></section>
<footer>源代码提交：<code>${catalog.commit}</code><br><small>作者：常二林 · 软件分发与远程访问授权相互独立。</small></footer></main></body></html>\n`;
}
