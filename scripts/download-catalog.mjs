// Public delivery metadata is separate from the embedded runtime-component manifest.
export const DOWNLOAD_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
export const SHA256 = /^[a-f0-9]{64}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const ALIASES = { 'win32-x64': 'windows-x64.exe', 'darwin-arm64': 'macos-arm64.pkg',
  'darwin-x64': 'macos-x64.pkg', 'linux-x64': 'linux-x64.tar.gz' };

const TARGET_META = {
  'win32-x64': { name: 'Windows', arch: 'x64', badge: 'WIN', note: 'Windows 10 / 11 · 标准安装程序' },
  'darwin-arm64': { name: 'macOS', arch: 'Apple Silicon', badge: 'MAC', note: 'M1 及更新 Apple 芯片 · PKG' },
  'darwin-x64': { name: 'macOS', arch: 'Intel', badge: 'MAC', note: 'Intel Mac · PKG' },
  'linux-x64': { name: 'Linux', arch: 'x64', badge: 'LIN', note: 'x86_64 · 离线安装包' },
};

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

const sizeMiB = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export function downloadPage(catalog, origin, { stable = false } = {}) {
  validateCatalog(catalog); httpsOrigin(origin);
  const pinned = packageUrls(catalog, origin);
  const prefix = `${origin}/releases/${catalog.version}`;
  const urls = Object.fromEntries(DOWNLOAD_TARGETS.map(target => [target,
    stable ? `${origin}/stable/${ALIASES[target]}` : pinned[target]]));
  const cards = DOWNLOAD_TARGETS.map(target => {
    const item = catalog.targets[target];
    const meta = TARGET_META[target];
    return `<article class="platform-card">
      <div class="platform-head"><span class="platform-badge">${meta.badge}</span><span class="file-size">${sizeMiB(item.size)}</span></div>
      <h3>${meta.name}</h3><p class="arch">${meta.arch}</p><p class="muted">${meta.note}</p>
      <div class="card-actions"><a class="button button-dark" href="${urls[target]}">下载安装包 <span aria-hidden="true">↓</span></a><a class="text-link" href="${urls[target]}.sha256">SHA-256</a></div>
    </article>`;
  }).join('\n');
  const modeNote = stable
    ? '这里始终提供已经验收的当前稳定版。新版本发布后，固定入口自动切换，安装命令无需改变。'
    : `这是 Team DevSpace ${catalog.version} 的不可变历史版本页面，安装包和校验值保持固定。`;
  const primaryWindows = stable ? `${origin}/stable/${ALIASES['win32-x64']}` : pinned['win32-x64'];
  const scriptBase = stable ? origin : prefix;
  const windowsCommand = `irm ${scriptBase}/install.ps1 | iex`;
  const unixCommand = `curl -fsSL ${scriptBase}/install.sh | sh`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f5f1e8">
<meta name="description" content="Team DevSpace — 让网页 ChatGPT 安全连接你的开发环境。Windows、macOS 与 Linux 固定安装入口。">
<title>Team DevSpace · 下载与安装</title>
<style>
:root{--paper:#f5f1e8;--paper-2:#ebe6dc;--ink:#20201e;--muted:#6f706c;--line:#d8d2c7;--card:#fffdf8;--accent:#5a63d8;--accent-soft:#e9e8ff;--success:#28785a;--shadow:0 18px 50px rgba(32,32,30,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit}.nowrap{white-space:nowrap}code,pre{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}.shell{width:min(1180px,calc(100% - 40px));margin:auto}.topbar{border-bottom:1px solid rgba(32,32,30,.09)}.topbar-inner{height:76px;display:flex;align-items:center;justify-content:space-between;gap:28px}.brand{display:inline-flex;align-items:center;gap:11px;text-decoration:none;font-weight:760;letter-spacing:-.02em}.brand-mark{width:30px;height:30px;border-radius:9px;background:var(--ink);display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}.brand-mark span{width:14px;height:14px;display:grid;grid-template-columns:repeat(2,5px);grid-template-rows:repeat(2,5px);gap:4px}.brand-mark i{display:block;width:5px;height:5px;border-radius:50%;background:#fff;font-style:normal}.nav{display:flex;align-items:center;gap:28px;font-size:14px}.nav a{text-decoration:none;color:#454641}.nav a:hover{text-decoration:underline;text-underline-offset:5px}.nav .nav-cta{padding:10px 16px;border:1px solid var(--ink);border-radius:999px;color:var(--ink);font-weight:700}.hero{padding:92px 0 76px;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(380px,.95fr);gap:72px;align-items:center}.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;font-weight:760;letter-spacing:.08em;text-transform:uppercase}.eyebrow:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--success)}h1{font-size:clamp(46px,6vw,82px);line-height:.98;letter-spacing:-.065em;margin:0;max-width:760px;font-weight:780}.hero-lead{font-size:clamp(18px,2vw,22px);line-height:1.5;max-width:660px;margin:28px 0 0;color:#4d4e49}.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;border-radius:8px;padding:13px 18px;font-weight:720;transition:transform .15s ease,box-shadow .15s ease}.button:hover{transform:translateY(-1px)}.button-dark{background:var(--ink);color:#fff;box-shadow:0 8px 24px rgba(32,32,30,.13)}.button-light{border:1px solid var(--line);background:rgba(255,255,255,.45)}.hero-note{margin-top:18px;color:var(--muted);font-size:13px}.network-visual{position:relative;min-height:390px;border:1px solid var(--line);border-radius:28px;background:#ece8df;padding:28px;overflow:hidden;box-shadow:var(--shadow)}.network-visual:before,.network-visual:after{content:"";position:absolute;border-radius:50%;filter:blur(1px)}.network-visual:before{width:260px;height:260px;background:#dbd8ff;right:-70px;top:-90px}.network-visual:after{width:220px;height:220px;background:#f5cdbb;left:-100px;bottom:-110px}.visual-window{position:relative;z-index:1;background:#242522;color:#f7f5ef;border-radius:18px;padding:20px;box-shadow:0 25px 55px rgba(32,32,30,.18)}.window-top{display:flex;align-items:center;justify-content:space-between;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,.12);font-size:13px}.window-dots{display:flex;gap:6px}.window-dots i{width:8px;height:8px;border-radius:50%;background:#777;font-style:normal}.status{display:inline-flex;align-items:center;gap:7px;color:#cfe9dc}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:#58b487;box-shadow:0 0 0 4px rgba(88,180,135,.13)}.network-path{display:grid;grid-template-columns:1fr 34px 1fr;align-items:center;gap:8px;padding:26px 0 14px}.endpoint{border:1px solid rgba(255,255,255,.12);background:#30312e;border-radius:13px;padding:15px}.endpoint strong{display:block;font-size:14px}.endpoint small{color:#aaa;font-size:12px}.line{height:1px;background:linear-gradient(90deg,#767672,#c7c3ff,#767672);position:relative}.line:after{content:"";position:absolute;right:-1px;top:-3px;width:7px;height:7px;border-radius:50%;background:#c7c3ff}.terminal{margin-top:12px;background:#191a18;border-radius:12px;padding:15px 16px;font:12px/1.65 "SFMono-Regular",Consolas,monospace;color:#cfd0ca}.terminal .prompt{color:#a9b0ff}.trust-strip{border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.trust-grid{display:grid;grid-template-columns:repeat(4,1fr)}.trust-item{padding:24px 20px;text-align:center;border-right:1px solid var(--line);font-size:14px;font-weight:700}.trust-item:last-child{border-right:0}.section{padding:88px 0}.section-header{display:flex;align-items:end;justify-content:space-between;gap:30px;margin-bottom:34px}.section-kicker{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}h2{font-size:clamp(34px,4vw,52px);line-height:1.05;letter-spacing:-.045em;margin:10px 0 0}.section-copy{max-width:500px;color:var(--muted);margin:0}.platform-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.platform-card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:23px;min-height:290px;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(32,32,30,.035)}.platform-head{display:flex;align-items:center;justify-content:space-between}.platform-badge{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:30px;border-radius:8px;background:var(--accent-soft);color:#444cb2;font-size:11px;font-weight:850;letter-spacing:.06em}.file-size{font-size:12px;color:var(--muted)}.platform-card h3{font-size:25px;letter-spacing:-.03em;margin:26px 0 0}.arch{font-weight:700;margin:2px 0 0}.muted{color:var(--muted);font-size:13px;margin:12px 0 0}.card-actions{margin-top:auto;padding-top:24px;display:flex;align-items:center;gap:14px}.platform-card .button{padding:10px 13px;font-size:13px}.text-link{font-size:12px;color:#575952;text-underline-offset:3px}.install-wrap{display:grid;grid-template-columns:.8fr 1.2fr;gap:38px;align-items:start;background:#242522;color:#f6f2e9;border-radius:26px;padding:40px}.install-wrap .section-kicker{color:#b6b8ff}.install-wrap h2{font-size:42px}.install-wrap p{color:#bebfb8}.command-stack{display:grid;gap:14px}.command-card{border:1px solid rgba(255,255,255,.12);background:#191a18;border-radius:14px;padding:18px}.command-label{display:flex;align-items:center;justify-content:space-between;color:#b7b8b1;font-size:12px;margin-bottom:10px}.command-label a{color:#d8d9ff;text-underline-offset:3px}.command-card pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#fff;font-size:13px}.principles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.principle{border-top:1px solid var(--ink);padding-top:20px}.principle .num{font:12px/1.2 "SFMono-Regular",Consolas,monospace;color:var(--muted)}.principle h3{font-size:22px;letter-spacing:-.025em;margin:20px 0 8px}.principle p{color:var(--muted);margin:0}.security{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:56px}.security-card{background:#eae4d9;border-radius:18px;padding:25px}.security-card strong{font-size:16px}.security-card p{margin:9px 0 0;color:#62635f;font-size:14px}.release-row{display:flex;justify-content:space-between;gap:20px;align-items:center;border-top:1px solid var(--line);padding:22px 0;color:#555650}.release-links{display:flex;gap:18px;flex-wrap:wrap}.release-links a{text-underline-offset:4px}.footer{border-top:1px solid var(--line);padding:34px 0 48px}.footer-inner{display:flex;align-items:flex-start;justify-content:space-between;gap:30px}.footer p{margin:7px 0 0;color:var(--muted);font-size:13px}.footer code{font-size:11px;color:#777873}.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;z-index:20;background:#fff;padding:10px}.historical{background:#fff1c9;border-bottom:1px solid #dfcf9f;text-align:center;padding:9px 20px;font-size:13px}
@media(max-width:960px){.hero{grid-template-columns:1fr;gap:44px;padding-top:64px}.network-visual{min-height:0}.platform-grid{grid-template-columns:repeat(2,1fr)}.install-wrap{grid-template-columns:1fr}.trust-grid{grid-template-columns:repeat(2,1fr)}.trust-item:nth-child(2){border-right:0}.trust-item:nth-child(-n+2){border-bottom:1px solid var(--line)}}
@media(max-width:680px){.shell{width:min(100% - 28px,1180px)}.topbar-inner{height:66px}.nav a:not(.nav-cta){display:none}.nav{gap:0}.hero{padding:54px 0 58px}.hero-lead{font-size:17px}.network-visual{padding:16px;border-radius:20px}.network-path{grid-template-columns:1fr;padding-bottom:0}.line{width:1px;height:20px;margin:auto;background:linear-gradient(#767672,#c7c3ff,#767672)}.line:after{right:-3px;top:auto;bottom:-1px}.section{padding:64px 0}.section-header{display:block}.section-copy{margin-top:16px}.platform-grid,.principles,.security{grid-template-columns:1fr}.platform-card{min-height:260px}.install-wrap{padding:26px 20px;border-radius:20px}.install-wrap h2{font-size:34px}.release-row,.footer-inner{align-items:flex-start;flex-direction:column}.trust-item{border-right:0!important;border-bottom:1px solid var(--line)}.trust-item:last-child{border-bottom:0}}
</style>
</head>
<body>
<a class="skip" href="#download">跳到下载</a>
${stable ? '' : `<div class="historical">历史版本 ${catalog.version} · <a href="${origin}/">返回当前稳定版</a></div>`}
<header class="topbar"><div class="shell topbar-inner">
  <a class="brand" href="${origin}/" aria-label="Team DevSpace 首页"><span class="brand-mark" aria-hidden="true"><span><i></i><i></i><i></i><i></i></span></span><span>Team DevSpace</span></a>
  <nav class="nav" aria-label="主导航"><a href="#download">下载</a><a href="#install">安装</a><a href="#security">安全</a><a href="${origin}/releases/">历史版本</a><a class="nav-cta" href="#download">获取稳定版</a></nav>
</div></header>
<main>
<section class="shell hero">
  <div><div class="eyebrow">Team developer access</div><h1>把开发机，安全带到 <span class="nowrap">ChatGPT 里。</span></h1>
    <p class="hero-lead">Team DevSpace 让网页 ChatGPT 连接员工自己的开发环境。安装软件与 Access Key 完全解耦：所有人使用同一份客户端，安装后再完成设备绑定。</p>
    <div class="hero-actions"><a class="button button-dark" href="${primaryWindows}">下载 Windows x64 <span aria-hidden="true">↓</span></a><a class="button button-light" href="#install">使用一行命令安装</a></div>
    <p class="hero-note">当前稳定版 ${catalog.version} · 四个平台使用同一发布批次 · ${modeNote}</p>
  </div>
  <div class="network-visual" aria-label="Team DevSpace 连接示意">
    <div class="visual-window"><div class="window-top"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="status">Connected</span></div>
      <div class="network-path"><div class="endpoint"><strong>Web ChatGPT</strong><small>Team DevSpace 插件</small></div><span class="line" aria-hidden="true"></span><div class="endpoint"><strong>Your DevSpace</strong><small>员工开发机</small></div></div>
      <div class="terminal"><span class="prompt">$</span> team-devspace status<br>remote access&nbsp;&nbsp;connected<br>workspace&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;your project<br>access key&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;configured after install</div>
    </div>
  </div>
</section>
<div class="trust-strip"><div class="shell trust-grid"><div class="trust-item">Windows x64</div><div class="trust-item">macOS Apple Silicon</div><div class="trust-item">macOS Intel</div><div class="trust-item">Linux x64</div></div></div>
<section class="section" id="download"><div class="shell">
  <div class="section-header"><div><div class="section-kicker">Download</div><h2>选你的平台，直接安装。</h2></div><p class="section-copy">不需要管理员为每个人生成下载链接，也不在安装命令里携带 Access Key。下载安装后，再由 Team DevSpace 自己完成授权与设备绑定。</p></div>
  <div class="platform-grid">${cards}</div>
  <div class="release-row"><span>版本 <strong>${catalog.version}</strong> · 发布提交 <code>${catalog.commit.slice(0, 12)}</code></span><div class="release-links"><a href="${prefix}/catalog.json">文件清单</a><a href="${prefix}/SHA256SUMS">全部 SHA-256</a><a href="${prefix}/release-notes.txt">更新说明</a></div></div>
</div></section>
<section class="section" id="install"><div class="shell install-wrap"><div><div class="section-kicker">Install in minutes</div><h2>${stable ? '固定入口，一条命令。' : `安装 ${catalog.version}，一条命令。`}</h2><p>安装脚本固定走本站 HTTPS，并在调用系统安装器之前校验${stable ? '当前稳定版本' : `版本 ${catalog.version}`}的 SHA-256。你可以先查看脚本源码，再执行。</p></div>
  <div class="command-stack"><div class="command-card"><div class="command-label"><span>Windows · PowerShell</span><a href="${scriptBase}/install.ps1">查看脚本</a></div><pre>${html(windowsCommand)}</pre></div>
  <div class="command-card"><div class="command-label"><span>macOS / Linux · Terminal</span><a href="${scriptBase}/install.sh">查看脚本</a></div><pre>${html(unixCommand)}</pre></div></div>
</div></section>
<section class="section" id="security"><div class="shell"><div class="section-header"><div><div class="section-kicker">Simple by design</div><h2>安装简单，授权仍然独立。</h2></div><p class="section-copy">软件下载只是拿到客户端，不会获得远程访问权限。真正的设备身份和访问控制继续由 Team DevSpace 的 Access Key 与现有控制面负责。</p></div>
<div class="principles"><div class="principle"><span class="num">01</span><h3>同一安装方式</h3><p>所有员工使用相同固定入口。更换 Access Key 不需要重新下载安装软件。</p></div><div class="principle"><span class="num">02</span><h3>版本可追溯</h3><p>每个正式版本都有不可变安装包、文件清单和 SHA-256，可随时回看历史发布。</p></div><div class="principle"><span class="num">03</span><h3>回滚不惊扰设备</h3><p>稳定入口回滚只影响之后的下载，不会偷偷降级已经安装并运行的客户端。</p></div></div>
<div class="security"><div class="security-card"><strong>升级保留本地意图</strong><p>重复安装和升级继续保留设备身份、项目目录、暂停状态等现有生命周期数据。</p></div><div class="security-card"><strong>当前签名边界透明</strong><p>当前 internal-free 模式不承诺 Windows 公共签名或 Apple Developer ID / 公证；不会关闭 Gatekeeper 或绕过系统安全确认。</p></div></div>
</div></section>
</main>
<footer class="footer"><div class="shell footer-inner"><div><a class="brand" href="${origin}/"><span class="brand-mark" aria-hidden="true"><span><i></i><i></i><i></i><i></i></span></span><span>Team DevSpace</span></a><p>让团队的开发环境安全地连接到网页 ChatGPT。</p></div><div><div class="release-links"><a href="${origin}/releases/">历史版本</a><a href="${prefix}/catalog.json">版本清单</a><a href="${prefix}/SHA256SUMS">完整性校验</a></div><p>作者：常二林 · 软件分发与远程访问授权相互独立。</p><code>${catalog.commit}</code></div></div></footer>
</body></html>\n`;
}
