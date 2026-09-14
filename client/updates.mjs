import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import http from 'node:http';
import lockfile from 'proper-lockfile';
import { atomicJson, installRoot, loadState, privateDirectory, readJson, RELEASE_VERSION, stateHome } from './state.mjs';
import { withDeviceOperation } from './operation.mjs';
import { runWindowsDesktop } from './windows-desktop.mjs';
import { boundedJson, compareVersions, validateUpdatePolicy, verifySignedCatalog, versionUnsupported } from './update-policy.mjs';
import { DOWNLOAD_TARGETS, packageUrls } from './release-catalog.mjs';
import release from '../release.config.json' with { type: 'json' };

const exec = promisify(execFile);
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const request = (url, options = {}) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options });
const updateDirectory = home => join(home, 'updates');

export async function updateStatus(home = stateHome()) {
  const directory = updateDirectory(home);
  const [cache, settings, lastInstall, automaticResult] = await Promise.all([
    readJson(join(directory, 'check.json'), {}), readJson(join(directory, 'settings.json'), { automatic: true }),
    readJson(join(directory, 'result.json'), null), readJson(join(directory, 'automatic-result.json'), null),
  ]);
  return { ...cache, currentVersion: RELEASE_VERSION, automatic: settings.automatic === true, lastInstall, automaticResult,
    available: Boolean(cache.policy && compareVersions(cache.policy.stable, RELEASE_VERSION) > 0),
    required: Boolean(cache.policy && versionUnsupported(RELEASE_VERSION, cache.policy)),
    requiresAuthorization: process.platform === 'darwin' };
}

export async function setAutomaticUpdates(enabled, home = stateHome()) {
  if (typeof enabled !== 'boolean') throw new Error('Automatic update setting must be boolean');
  await withDeviceOperation(home, () => atomicJson(join(updateDirectory(home), 'settings.json'), { automatic: enabled }));
  return updateStatus(home);
}

export async function checkForUpdates(home = stateHome(), { force = false, fetcher = request, now = Date.now() } = {}) {
  const directory = updateDirectory(home);
  await privateDirectory(directory);
  let unlock;
  try { unlock = await lockfile.lock(directory, { lockfilePath: join(directory, '.check.lock'), stale: 30000, update: 5000 }); }
  catch (error) { if (error.code === 'ELOCKED') return updateStatus(home); throw error; }
  try {
    const previous = await readJson(join(directory, 'check.json'), {});
    if (!force && previous.currentVersion === RELEASE_VERSION && previous.nextCheckAt > now) return updateStatus(home);
    // Repeated button clicks are bounded, but a restart cannot postpone a due check.
    if (force && previous.checkedAt && now - Date.parse(previous.checkedAt) < 5000) return updateStatus(home);
    const nextCheckAt = now + CHECK_INTERVAL + Math.floor(Math.random() * 60 * 60 * 1000);
    try {
      const policy = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
      let inventoryReported = false;
      const state = await loadState(home).catch(() => null);
      if (state?.bindingId) {
        try {
          const response = await fetcher(`${state.gateway}/v1/device/version`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.deviceSecret}` },
            body: JSON.stringify({ keyId: state.keyId, bindingId: state.bindingId, version: RELEASE_VERSION, platform: `${process.platform}-${process.arch}` }) });
          inventoryReported = response.ok; await response.body?.cancel();
        } catch { /* Version inventory never gates local recovery or update discovery. */ }
      }
      await atomicJson(join(directory, 'check.json'), { currentVersion: RELEASE_VERSION, checkedAt: new Date(now).toISOString(), nextCheckAt,
        policy, available: compareVersions(policy.stable, RELEASE_VERSION) > 0,
        required: versionUnsupported(RELEASE_VERSION, policy, now), inventoryReported, error: null });
    } catch (error) {
      // No silent execution from stale policy; failed checks are visible and retryable.
      await atomicJson(join(directory, 'check.json'), { ...previous, checkedAt: new Date(now).toISOString(),
        nextCheckAt: now + 60 * 60 * 1000, error: '无法检查更新；已安装版本和用户状态未更改。' });
      if (force) throw error;
    }
    return updateStatus(home);
  } finally { await unlock(); }
}

export async function downloadVerifiedPackage(url, item, destination, { fetcher = request, onProgress = () => {} } = {}) {
  const hashFile = async path => {
    const handle = await open(path, 'r'); const hash = createHash('sha256');
    try { for await (const chunk of handle.createReadStream()) hash.update(chunk); return hash.digest('hex'); }
    finally { await handle.close().catch(() => {}); }
  };
  if ((await stat(destination).catch(() => null))?.size === item.size && await hashFile(destination) === item.sha256) return destination;
  await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.part`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30 * 60 * 1000), headers: { 'Accept-Encoding': 'identity' } });
    if (response.status !== 200 || !response.body ||
        (response.headers.has('Content-Length') && Number(response.headers.get('Content-Length')) !== item.size)) {
      await response.body?.cancel(); throw new Error('Update package download failed');
    }
    const hash = createHash('sha256'); let size = 0, lastProgress = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > item.size) throw new Error('Update package exceeds its signed size');
      hash.update(chunk); await file.writeFile(chunk);
      if (Date.now() - lastProgress > 1000) { onProgress(`正在下载更新… ${Math.floor(size * 100 / item.size)}%`); lastProgress = Date.now(); }
    }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error('Update package checksum verification failed');
    await file.sync(); await file.close();
    await rm(destination, { force: true }); await rename(temporary, destination);
    return destination;
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}

export function updateBridge(state, method, automatic = false) {
  return new Promise((resolve_, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: state.ports.bridge, path: '/update-drain', method,
      headers: { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId,
        'X-Team-Update-Mode': automatic ? 'automatic' : 'manual' } }, response => {
      response.resume(); response.once('end', () => response.statusCode === 200 ? resolve_() :
        reject(new Error(response.statusCode === 409 ? '远程工作仍在进行，稍后再更新。' : '无法确认连接已空闲，请暂停远程访问后再更新。')));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Update readiness check timed out')));
    req.on('error', reject); req.end();
  });
}

export async function updateTarget() {
  if (process.platform === 'darwin') {
    // Rosetta reports the process architecture; select the package for the hardware.
    const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
    return stdout.trim() === '1' ? 'darwin-arm64' : `darwin-${process.arch}`;
  }
  return `${process.platform}-${process.arch}`;
}

export async function installedDistributionRoot() {
  const root = resolve(installRoot, '..', '..');
  const active = process.platform === 'win32' ? (await readJson(join(root, 'active.json'))).path
    : (await readFile(join(root, 'active-path'), 'utf8')).trim();
  if (await realpath(active) !== await realpath(installRoot)) throw new Error('请从当前已安装的 Team DevSpace 执行更新。');
  return root;
}

async function detached(executable, args, options = {}) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
  await new Promise((resolve_, reject) => { child.once('spawn', resolve_); child.once('error', reject); });
  child.unref();
}

export async function handoffInstaller(file, version, home, root, {
  launcher = join(installRoot, 'platform', 'windows', 'tds-launcher.exe'),
} = {}) {
  const directory = updateDirectory(home);
  if (process.platform === 'darwin') {
    // PKG authorization/Gatekeeper stay native. No privileged helper or bypass.
    await exec('/usr/bin/open', [file], { timeout: 10000 });
    return { handedOff: true, requiresAuthorization: true, version };
  }
  await rm(join(directory, 'result.json'), { force: true });
  if (process.platform === 'win32') {
    const taskName = `TeamDevSpace-Update-${randomUUID()}`;
    const helper = join(directory, 'apply-update.ps1'), requestFile = join(directory, 'install-request.json');
    const updateLauncher = join(directory, 'update-launcher.exe');
    await cp(launcher, updateLauncher);
    await cp(join(installRoot, 'platform', 'windows', 'apply-update.ps1'), helper);
    await atomicJson(requestFile, { installer: file, installRoot: root, home, version, taskName,
      requestedAt: Date.now(), resultFile: join(directory, 'result.json') });
    await runWindowsDesktop(`
$arguments = '--cwd "' + $env:TDS_UPDATE_DIR + '" --stdout "' + (Join-Path $env:TDS_UPDATE_DIR 'installer.log') + '" --stderr "' + (Join-Path $env:TDS_UPDATE_DIR 'installer.error.log') + '" -- "' + (Join-Path $PSHOME 'powershell.exe') + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $env:TDS_UPDATE_HELPER + '" -RequestFile "' + $env:TDS_UPDATE_REQUEST + '"'
$action = New-ScheduledTaskAction -Execute $env:TDS_UPDATE_LAUNCHER -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $env:TDS_UPDATE_TASK -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $env:TDS_UPDATE_TASK
`, { env: { TDS_UPDATE_HELPER: helper, TDS_UPDATE_REQUEST: requestFile, TDS_UPDATE_TASK: taskName,
      TDS_UPDATE_LAUNCHER: updateLauncher, TDS_UPDATE_DIR: directory } });
  } else {
    const helper = join(directory, 'apply-update.sh');
    await cp(join(installRoot, 'platform', 'unix', 'apply-update.sh'), helper);
    const args = [helper, file, root, home, join(directory, `stage-${randomUUID()}`), version, join(directory, 'result.json')];
    // A systemd service child would otherwise die with the runtime's cgroup.
    const systemd = await exec('systemctl', ['--user', 'show-environment'], { timeout: 5000 }).then(() => true, () => false);
    if (systemd) {
      await exec('systemd-run', ['--user', '--collect', '--quiet', `--unit=team-devspace-update-${randomUUID()}`, '/bin/sh', ...args], { timeout: 15000 });
    } else {
      if (process.env.INVOCATION_ID) throw new Error('The user service manager is unavailable; retry after it recovers.');
      await detached('/bin/sh', args, { env: { ...process.env, TEAM_DEVSPACE_HOME: home } });
    }
  }
  return { handedOff: true, version };
}

export async function applyUpdate(home = stateHome(), { automatic = false, fetcher = request, onProgress = () => {},
  handoff = handoffInstaller, distributionRoot = installedDistributionRoot, publicKey = release.distribution.updatePublicKey,
  signal, canApply = () => true } = {}) {
  const baseFetcher = fetcher;
  if (signal) fetcher = (url, options = {}) => baseFetcher(url, { ...options,
    signal: AbortSignal.any([signal, options.signal ?? AbortSignal.timeout(20000)]) });
  const directory = updateDirectory(home);
  await privateDirectory(directory);
  const unlock = await lockfile.lock(directory, { lockfilePath: join(directory, '.apply.lock'), stale: 30000, update: 5000 });
  try {
    // Always re-read authoritative policy before execution, even after a cached notification.
    const policy = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
    const version = automatic ? policy.auto : policy.stable;
    if (!version || compareVersions(version, RELEASE_VERSION) <= 0) return { changed: false };
    const target = await updateTarget();
    if (!DOWNLOAD_TARGETS.includes(target)) throw new Error('No update package for this platform');
    const catalog = await verifySignedCatalog(await boundedJson(await fetcher(`${release.distribution.origin}/releases/${version}/update.json`)), publicKey, version);
    const root = await distributionRoot();
    onProgress('正在校验并准备更新…');
    const file = await downloadVerifiedPackage(packageUrls(catalog, release.distribution.origin)[target], catalog.targets[target],
      join(directory, version, catalog.targets[target].file), { fetcher, onProgress });
    if (automatic && process.platform === 'darwin') return { ready: true, version, requiresAuthorization: true };
    // Downloads may take a while. Re-check withdrawal and local opt-out before applying.
    const latest = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
    if ((automatic ? latest.auto : latest.stable) !== version) throw new Error('管理员已调整推广版本，请重新检查更新。');
    if (automatic && !(await updateStatus(home)).automatic) return { changed: false };
    signal?.throwIfAborted();
    if (!canApply()) return { changed: false, deferred: true };
    return withDeviceOperation(home, async () => {
      signal?.throwIfAborted();
      if (!canApply()) return { changed: false, deferred: true };
      const previous = await readJson(join(directory, 'attempt.json'), null);
      const completed = await readJson(join(directory, 'result.json'), null);
      if (previous && !completed && Date.now() - previous.startedAt < 60 * 60 * 1000) {
        throw new Error('安装器已启动，请完成系统安装操作；未启动时可在一小时后重试。');
      }
      const stored = await readJson(join(home, 'state.json'), null);
      const state = stored ? await loadState(home) : null;
      let drained = false;
      if (state?.bindingId && state.remoteAccess !== 'suspended') { await updateBridge(state, 'POST', automatic); drained = true; }
      try {
        onProgress('已验证更新，正在交给安装器；连接将短暂重启…');
        await rm(join(directory, 'result.json'), { force: true });
        await atomicJson(join(directory, 'attempt.json'), { version, startedAt: Date.now() });
        const result = await handoff(file, version, home, root);
        // A cancelled macOS authorization window must not pause remote access.
        // macOS is user-confirmed installation, never unattended activation.
        if (process.platform === 'darwin') {
          if (drained) await updateBridge(state, 'DELETE').catch(() => {});
          await rm(join(directory, 'attempt.json'), { force: true });
        }
        return result;
      } catch (error) {
        if (drained) await updateBridge(state, 'DELETE').catch(() => {});
        // Ambiguous task-start failures keep the short-lived attempt guard; inspect
        // the system task/result before retrying instead of launching a duplicate.
        throw error;
      }
    });
  } finally { await unlock(); }
}

export function startUpdateChecks(home, onChange = () => {}, canApply = () => true) {
  let timer, stopped = false;
  const controller = new AbortController();
  const tick = async () => {
    try {
      const status = await checkForUpdates(home);
      if (!stopped && canApply() && !status.error && status.automatic && status.policy?.auto && compareVersions(status.policy.auto, RELEASE_VERSION) > 0) {
        await applyUpdate(home, { automatic: true, signal: controller.signal, canApply: () => !stopped && canApply() });
      }
      await rm(join(updateDirectory(home), 'automatic-result.json'), { force: true });
    } catch {
      await atomicJson(join(updateDirectory(home), 'automatic-result.json'), {
        checkedAt: new Date().toISOString(), deferred: true,
        message: '自动更新暂未执行。远程工作进行中、安装器等待完成或网络不可用时会保留当前版本；可手动检查并更新。',
      }).catch(() => {});
    }
    finally {
      onChange();
      if (!stopped) { timer = setTimeout(tick, CHECK_INTERVAL + Math.random() * 60 * 60 * 1000); timer.unref(); }
    }
  };
  timer = setTimeout(tick, 15000 + Math.random() * 15000); timer.unref();
  return () => { stopped = true; controller.abort(); clearTimeout(timer); };
}
