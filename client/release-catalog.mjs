// Shared by the employee updater and the publisher. No runtime or Node dependencies.
export const DOWNLOAD_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
export const SHA256 = /^[a-f0-9]{64}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
