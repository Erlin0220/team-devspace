// Browser hints are advisory, never an installer or authorization boundary.
// Chromium's Mac UA says Intel even on Apple Silicon; only UA-CH may select a Mac chip.
function resolveDownloadTarget(browser, hints = {}) {
  const ua = String(browser.userAgent ?? '');
  const platform = String(hints.platform || browser.userAgentData?.platform || '');
  if (browser.userAgentData?.mobile || hints.mobile || /Android|iPhone|iPad|iPod|CrOS/i.test(ua) ||
      /Android|iOS|Chrome OS/i.test(platform) ||
      (/Mac/.test(browser.platform ?? '') && browser.maxTouchPoints > 1)) return { platform: 'unsupported' };
  const os = platform ? ({ Windows: 'win32', macOS: 'darwin', Linux: 'linux' }[platform] ?? 'unsupported')
    : /Windows NT/.test(ua) ? 'win32' : /Macintosh|Mac OS X/.test(ua) ? 'darwin' : /Linux/.test(ua) ? 'linux' : 'unknown';
  let arch = null;
  if (hints.architecture || hints.bitness) {
    if (hints.bitness === '64') arch = hints.architecture === 'x86' ? 'x64' : hints.architecture === 'arm' ? 'arm64' : null;
  } else if (os !== 'darwin' && !/(?:Chrome|Chromium|Edg|OPR)\//.test(ua) &&
      !/aarch64|arm64|ARM/.test(`${ua} ${browser.platform ?? ''}`) && /Win64; x64|WOW64|x86_64|amd64/.test(ua)) {
    // Unreduced non-Chromium desktop UA. Frozen Chromium x64 strings are not evidence.
    arch = 'x64';
  }
  const target = os === 'darwin' && arch ? `${os}-${arch}`
    : ['win32', 'linux'].includes(os) && arch === 'x64' ? `${os}-x64` : null;
  return { platform: os, target };
}

(() => {
  const primary = document.querySelector('[data-primary-download]');
  const guidance = document.getElementById('platform-guidance');
  let interacted = false;
  const applyPlatform = hints => {
    if (!primary || !guidance || interacted) return;
    const choice = resolveDownloadTarget(navigator, hints);
    const asset = choice.target && document.querySelector(`.package-button[data-download-target="${choice.target}"]`);
    primary.href = '#download';
    const title = primary.querySelector('[data-download-title]');
    if (asset) {
      primary.href = asset.href;
      title.textContent = `下载 ${asset.dataset.downloadLabel}`;
      guidance.textContent = `已识别 ${asset.dataset.downloadLabel}；其他设备可在下方选择完整平台列表。`;
    } else if (choice.platform === 'darwin') {
      title.textContent = '选择 Mac 芯片';
      guidance.replaceChildren(document.createTextNode('请选择 Mac 芯片：'));
      for (const [index, target] of ['darwin-arm64', 'darwin-x64'].entries()) {
        const source = document.querySelector(`.package-button[data-download-target="${target}"]`);
        if (!source) continue;
        const link = document.createElement('a');
        link.href = source.href;
        link.textContent = index ? 'Intel' : 'Apple Silicon';
        link.setAttribute('data-download-target', target);
        if (index) guidance.append(document.createTextNode(' / '));
        guidance.append(link);
      }
      guidance.append(document.createTextNode('。可在 Apple 菜单的“关于本机”中查看。'));
    } else {
      title.textContent = '选择平台下载';
      guidance.textContent = choice.platform === 'unsupported'
        ? '当前环境没有自动匹配的安装包，请在开发机上下载或查看下方支持的平台。'
        : '浏览器未提供足够的架构信息，请在下方确认系统与芯片。';
    }
  };
  document.addEventListener('click', event => {
    if (event.target.closest('[data-primary-download], [data-download-target]')) interacted = true;
  });
  applyPlatform({});
  if (primary && navigator.userAgentData?.getHighEntropyValues) {
    let timer;
    Promise.race([
      Promise.resolve().then(() => navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness'])),
      new Promise(resolve => { timer = setTimeout(() => resolve({}), 1200); }),
    ]).then(applyPlatform, () => {}).finally(() => clearTimeout(timer));
  }

  const fallbackCopy = text => {
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  };

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-command]');
    if (!button) return;
    const command = button.closest('.command-card')?.querySelector('code')?.textContent?.trim();
    if (!command) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      copied = fallbackCopy(command);
    }
    if (!copied) return;
    const label = button.querySelector('.copy-label');
    if (!label) return;
    label.textContent = '已复制';
    button.dataset.state = 'copied';
    window.setTimeout(() => {
      label.textContent = '复制脚本';
      delete button.dataset.state;
    }, 1600);
  });
})();
