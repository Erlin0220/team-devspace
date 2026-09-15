import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import http from 'node:http';
import lockfile from 'proper-lockfile';
import { atomicJson, installRoot, loadState, privateDirectory, readJson, RELEASE_VERSION, stateHome } from './state.mjs';
import { withDeviceOperation, notifyObserver } from './operation.mjs';
import { runWindowsDesktop } from './windows-desktop.mjs';
import { boundedJson, compareVersions, UPDATE_VERSION, validateUpdatePolicy, verifySignedCatalog, versionUnsupported } from './update-policy.mjs';
import { DOWNLOAD_TARGETS, packageUrls } from './release-catalog.mjs';
import { pruneUpdateCache } from './update-cache.mjs';
import { buildUpdateReport } from './update-report.mjs';
import release from '../release.config.json' with { type: 'json' };

const exec = promisify(execFile);
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FAILURE_INTERVAL = 60 * 60 * 1000;
const BUSY_INTERVAL = 10 * 60 * 1000;
const request = (url, options = {}) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), ...options });
const updateDirectory = home => join(home, 'updates');
const NOTES_LIMIT = 16 * 1024;

export function releaseNotesUrl(version) {
  if (!UPDATE_VERSION.test(version ?? '')) throw new Error('Invalid release notes version');
  return `${release.distribution.origin}/releases/${version}/release-notes.txt`;
}

export async function fetchReleaseNotes(version, { fetcher = request, signal, limit = NOTES_LIMIT } = {}) {
  const url = releaseNotesUrl(version);
  const deadline = AbortSignal.timeout(5000);
  const response = await fetcher(url, { headers: { Accept: 'text/plain', 'Accept-Encoding': 'identity' },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('Release notes unavailable'); }
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body.cancel(); throw new Error('Release notes exceed size limit'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Release notes exceed size limit');
    chunks.push(chunk);
  }
  const lines = textLines(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const meaningful = line => line && !/^(?:changes?|release notes?|更新说明|更新日志|版本\s*)[:：]?\s*v?\d*(?:\.\d+)*$/i.test(line) &&
    !/^v?\d+\.\d+\.\d+$/.test(line);
  const bullets = lines.filter(line => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line))
    .map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim()).filter(meaningful);
  const fallback = lines.map(line => line.trim()).filter(line => line && !/^#{1,6}\s/.test(line) &&
    meaningful(line));
  const summary = (bullets.length ? bullets : fallback).filter(Boolean).slice(0, 4).map(line => line.slice(0, 180));
  return { version, summary, url };
}

function textLines(text) { return text.split(/\r?\n/); }

export async function updateStatus(home = stateHome()) {
  const directory = updateDirectory(home);
  const [cache, settings, lastInstall, automaticResult, attempt] = await Promise.all([
    readJson(join(directory, 'check.json'), {}), readJson(join(directory, 'settings.json'), { automatic: true }),
    readJson(join(directory, 'result.json'), null), readJson(join(directory, 'automatic-result.json'), null),
    readJson(join(directory, 'attempt.json'), null),
  ]);
  const matchingResult = attempt && lastInstall?.version === attempt.version &&
    (!attempt.attemptId || lastInstall.attemptId === attempt.attemptId);
  const currentAttemptResult = matchingResult ? lastInstall : null;
  const expired = attempt && (!Number.isFinite(attempt.startedAt) || Date.now() - attempt.startedAt >= FAILURE_INTERVAL);
  // This is a pure projection. Only an actual matching result or a different
  // sourceVersion now running at the attempted target can prove completion.
  const runningTarget = attempt?.version === RELEASE_VERSION && attempt.sourceVersion &&
    attempt.sourceVersion !== RELEASE_VERSION;
  const installation = !attempt ? null
    : currentAttemptResult?.exitCode !== undefined && currentAttemptResult.exitCode !== 0
      ? { status: 'failed', version: attempt.version, startedAt: attempt.startedAt }
    : runningTarget || (currentAttemptResult?.exitCode === 0 && attempt.version === RELEASE_VERSION)
      ? { status: 'installed', version: attempt.version, startedAt: attempt.startedAt }
    : expired
      ? { status: 'expired', version: attempt.version, startedAt: attempt.startedAt,
        message: '上次安装等待已结束；请确认系统安装器已关闭，再重新检查并确认更新。' }
    : currentAttemptResult?.exitCode === 0
      ? { status: 'waiting-restart', version: attempt.version, startedAt: attempt.startedAt }
      : { status: attempt.phase === 'awaiting-authorization' ? 'awaiting-authorization' : 'installing',
        version: attempt.version, startedAt: attempt.startedAt };
  return { ...cache, currentVersion: RELEASE_VERSION, automatic: settings.automatic === true, lastInstall, automaticResult,
    available: Boolean(cache.policy && compareVersions(cache.policy.stable, RELEASE_VERSION) > 0),
    required: Boolean(cache.policy && versionUnsupported(RELEASE_VERSION, cache.policy)),
    requiresAuthorization: process.platform === 'darwin', installation };
}

export async function setAutomaticUpdates(enabled, home = stateHome()) {
  if (typeof enabled !== 'boolean') throw new Error('Automatic update setting must be boolean');
  await withDeviceOperation(home, () => atomicJson(join(updateDirectory(home), 'settings.json'), { automatic: enabled }));
  return updateStatus(home);
}

export async function checkForUpdates(home = stateHome(), { force = false, fetcher = request, now = Date.now(), signal } = {}) {
  const baseFetcher = fetcher;
  if (signal) fetcher = (url, options = {}) => baseFetcher(url, { ...options,
    signal: AbortSignal.any([signal, options.signal ?? AbortSignal.timeout(20000)]) });
  const directory = updateDirectory(home);
  await privateDirectory(directory);
  let unlock;
  try { unlock = await lockfile.lock(join(directory, '.check'), { realpath: false, lockfilePath: join(directory, '.check.lock'), stale: 30000, update: 5000 }); }
  catch (error) { if (error.code === 'ELOCKED') return updateStatus(home); throw error; }
  try {
    // This is a discovery cache, not an installation guard or authorization setting.
    const previous = await readJson(join(directory, 'check.json'), {}).catch(() => ({}));
    const clockMovedBack = previous.checkedAt && Date.parse(previous.checkedAt) > now;
    if (!force && !clockMovedBack && previous.currentVersion === RELEASE_VERSION && previous.nextCheckAt > now) return updateStatus(home);
    // Repeated button clicks are bounded, but a restart cannot postpone a due check.
    if (force && !clockMovedBack && previous.checkedAt && now - Date.parse(previous.checkedAt) < 5000) return updateStatus(home);
    const nextCheckAt = now + CHECK_INTERVAL + Math.floor(Math.random() * 60 * 60 * 1000);
    try {
      const policy = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
      let inventoryReported = false;
      const state = await loadState(home).catch(() => null);
      if (state?.bindingId) {
        try {
          const [attempt, result, automatic] = await Promise.all(['attempt.json', 'result.json', 'automatic-result.json']
            .map(name => readJson(join(directory, name), null).catch(() => null)));
          const response = await fetcher(`${state.gateway}/v1/device/version`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.deviceSecret}` },
            body: JSON.stringify({ keyId: state.keyId, bindingId: state.bindingId, version: RELEASE_VERSION, platform: `${process.platform}-${process.arch}`,
              updateReport: buildUpdateReport(RELEASE_VERSION, policy, { attempt, result, automatic }) }) });
          inventoryReported = response.ok; await response.body?.cancel();
        } catch { /* Version inventory never gates local recovery or update discovery. */ }
      }
      signal?.throwIfAborted();
      await atomicJson(join(directory, 'check.json'), { currentVersion: RELEASE_VERSION, checkedAt: new Date(now).toISOString(), nextCheckAt,
        policy, available: compareVersions(policy.stable, RELEASE_VERSION) > 0,
        required: versionUnsupported(RELEASE_VERSION, policy, now), inventoryReported, error: null });
      // Cleanup is local and best-effort; it must not turn a successful policy
      // check into a failure or touch a concurrent apply operation.
      await pruneUpdateCache(home, policy, now).catch(() => {});
    } catch (error) {
      if (signal?.aborted) throw error;
      // No silent execution from stale policy; failed checks are visible and retryable.
      await atomicJson(join(directory, 'check.json'), { ...previous, currentVersion: RELEASE_VERSION, checkedAt: new Date(now).toISOString(),
        nextCheckAt: now + Math.max(FAILURE_INTERVAL, error.retryAfterMs ?? 0), error: '无法检查更新；已安装版本和用户状态未更改。' });
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
      if (Date.now() - lastProgress > 1000) { notifyObserver(onProgress, `正在下载更新… ${Math.floor(size * 100 / item.size)}%`); lastProgress = Date.now(); }
    }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error('Update package checksum verification failed');
    await file.sync(); await file.close();
    await rm(destination, { force: true }); await rename(temporary, destination);
    return destination;
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

export function updateBridge(state, method, automatic = false) {
  return new Promise((resolve_, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: state.ports.bridge, path: '/update-drain', method,
      headers: { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId,
        'X-Team-Update-Mode': automatic ? 'automatic' : 'manual' } }, response => {
      response.resume(); response.once('end', () => response.statusCode === 200 ? resolve_() :
        reject(Object.assign(new Error(response.statusCode === 409 ? '远程工作仍在进行，稍后再更新。' : '无法确认连接已空闲，请暂停远程访问后再更新。'),
          { code: response.statusCode === 409 ? 'remote_work_active' : 'update_readiness_unavailable' })));
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

async function automaticReadiness(home) {
  const state = await loadState(home).catch(() => null);
  if (state?.bindingId && state.remoteAccess !== 'suspended') await updateBridge(state, 'GET', true);
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
  attemptId = randomUUID(),
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
    await atomicJson(requestFile, { installer: file, installRoot: root, home, version, taskName, attemptId,
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
    const args = [helper, file, root, home, join(directory, `stage-${randomUUID()}`), version, join(directory, 'result.json'), attemptId];
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

export async function applyUpdate(home = stateHome(), { automatic = false, repair = false, fetcher = request, onProgress = () => {},
  handoff = handoffInstaller, distributionRoot = installedDistributionRoot, publicKey = release.distribution.updatePublicKey,
  signal, canApply = () => true, confirmedVersion, persistAttempt = atomicJson } = {}) {
  if (repair && automatic) throw new Error('Software repair requires an explicit user request');
  if (confirmedVersion !== undefined && (automatic || repair || !UPDATE_VERSION.test(confirmedVersion))) {
    throw new Error('Invalid confirmed update version');
  }
  const baseFetcher = fetcher;
  if (signal) fetcher = (url, options = {}) => baseFetcher(url, { ...options,
    signal: AbortSignal.any([signal, options.signal ?? AbortSignal.timeout(20000)]) });
  const directory = updateDirectory(home);
  await privateDirectory(directory);
  const unlock = await lockfile.lock(join(directory, '.apply'), { realpath: false, lockfilePath: join(directory, '.apply.lock'), stale: 30000, update: 5000 });
  let version;
  try {
    // An unresolved handoff is a local fact. Reject duplicate preparation before
    // network requests or a full cached-package hash, including after restart.
    const previous = await readJson(join(directory, 'attempt.json'), null);
    const completed = await readJson(join(directory, 'result.json'), null);
    const matchingResult = completed && completed.version === previous?.version &&
      (!previous?.attemptId || completed.attemptId === previous.attemptId);
    const alreadyInstalled = previous?.version === RELEASE_VERSION && previous.sourceVersion &&
      previous.sourceVersion !== RELEASE_VERSION;
    if (previous && !matchingResult && !alreadyInstalled && Date.now() - previous.startedAt < FAILURE_INTERVAL) {
      throw Object.assign(new Error('安装器已启动，请完成系统安装操作；未启动时可在一小时后重试。'),
        { code: 'installer_pending', version: previous.version });
    }
    // Always re-read authoritative policy before execution, even after a cached notification.
    const policy = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
    if (confirmedVersion && compareVersions(confirmedVersion, RELEASE_VERSION) <= 0) return { changed: false, version: confirmedVersion };
    if (confirmedVersion && policy.stable !== confirmedVersion) throw new Error('可用版本已变化，请重新检查并确认更新。');
    version = repair ? RELEASE_VERSION : automatic ? policy.auto : confirmedVersion ?? policy.stable;
    if (!version || (!repair && compareVersions(version, RELEASE_VERSION) <= 0)) return { changed: false };
    if (automatic && !(await updateStatus(home)).automatic) return { changed: false };
    const target = await updateTarget();
    if (!DOWNLOAD_TARGETS.includes(target)) throw new Error('No update package for this platform');
    const catalog = await verifySignedCatalog(await boundedJson(await fetcher(`${release.distribution.origin}/releases/${version}/update.json`)), publicKey, version);
    const root = await distributionRoot();
    notifyObserver(onProgress, '正在校验并准备更新…');
    const file = await downloadVerifiedPackage(packageUrls(catalog, release.distribution.origin)[target], catalog.targets[target],
      join(directory, version, catalog.targets[target].file), { fetcher, onProgress });
    // Downloads may take a while. Re-check withdrawal and local opt-out before applying.
    const latest = validateUpdatePolicy(await boundedJson(await fetcher(`${release.gateway}/v1/update-policy`)));
    if (!repair && (automatic ? latest.auto : latest.stable) !== version) throw new Error('管理员已调整推广版本，请重新检查更新。');
    if (automatic && !(await updateStatus(home)).automatic) return { changed: false };
    signal?.throwIfAborted();
    if (automatic && process.platform === 'darwin') return { ready: true, version, requiresAuthorization: true };
    const busy = () => ({ changed: false, deferred: true, version, code: 'local_operation_active',
      message: '更新已下载并校验；本机操作完成后会再次尝试安装。' });
    if (!canApply()) return busy();
    // Await here is essential: finally must retain the apply lock throughout
    // the device operation and OS handoff, not only until its Promise exists.
    return await withDeviceOperation(home, async () => {
      signal?.throwIfAborted();
      if (!canApply()) return busy();
      if (await distributionRoot() !== root) throw new Error('Installed application changed while preparing the update');
      const stored = await readJson(join(home, 'state.json'), null);
      const state = stored ? await loadState(home) : null;
      let drained = false;
      if (state?.bindingId && state.remoteAccess !== 'suspended') { await updateBridge(state, 'POST', automatic); drained = true; }
      try {
        notifyObserver(onProgress, '已验证更新，正在交给安装器；连接将短暂重启…');
        await rm(join(directory, 'result.json'), { force: true });
        const attemptId = randomUUID();
        const attempt = { version, sourceVersion: RELEASE_VERSION, repair, startedAt: Date.now(), attemptId, phase: 'starting' };
        await persistAttempt(join(directory, 'attempt.json'), attempt);
        const result = await handoff(file, version, home, root, { attemptId });
        if (result?.cancelled) {
          if (drained) await updateBridge(state, 'DELETE').catch(() => {});
          await rm(join(directory, 'attempt.json'), { force: true });
          return { ...result, version };
        }
        await persistAttempt(join(directory, 'attempt.json'), { ...attempt,
          phase: result?.requiresAuthorization ? 'awaiting-authorization' : 'installing' }).catch(() => {});
        // The durable starting guard already exists. A cosmetic phase write may
        // not undo a successful handoff, release its drain, or invite a duplicate installer.
        // Native macOS authorization happens after open(1) returns. Do not keep
        // remote admission paused while the user reads or cancels Installer UI.
        if (process.platform === 'darwin' && drained) await updateBridge(state, 'DELETE').catch(() => {});
        return { ...result, version };
      } catch (error) {
        if (drained) await updateBridge(state, 'DELETE').catch(() => {});
        // Ambiguous task-start failures keep the short-lived attempt guard; inspect
        // the system task/result before retrying instead of launching a duplicate.
        throw error;
      }
    });
  } catch (error) {
    if (version && error && typeof error === 'object' && !error.version) error.version = version;
    throw error;
  } finally { await unlock(); }
}

export function startUpdateChecks(home, onChange = () => {}, canApply = () => true, {
  check = checkForUpdates, apply = applyUpdate, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, readiness = automaticReadiness,
} = {}) {
  let timer, stopped = false;
  const controller = new AbortController();
  const tick = async () => {
    let status, outcome;
    try {
      status = await check(home, { signal: controller.signal });
      if (stopped) return;
      const approved = !status.error && status.automatic && status.policy?.auto && compareVersions(status.policy.auto, RELEASE_VERSION) > 0;
      outcome = status.automaticResult?.version === status.policy?.auto ? status.automaticResult : null;
      if (approved && !(outcome?.ready && outcome.requiresAuthorization) && !(outcome?.nextAttemptAt > now())) {
        // Reconsider a busy device locally; do not re-fetch policy or re-hash a
        // large cached package on every retry while the same work is active.
        if (outcome?.code === 'remote_work_active') await readiness(home);
        if (outcome?.code === 'local_operation_active' && !canApply()) {
          outcome = { ...outcome, nextAttemptAt: now() + BUSY_INTERVAL };
          await atomicJson(join(updateDirectory(home), 'automatic-result.json'), outcome);
          return;
        }
        // A local settings operation can defer activation, not safe preparation.
        // Remote work admission remains the Bridge's responsibility.
        const result = await apply(home, { automatic: true, signal: controller.signal, canApply: () => !stopped && canApply() });
        if (stopped) return;
        if (result.deferred || result.requiresAuthorization || result.handedOff) {
          outcome = { ...result, version: result.version ?? status.policy.auto, checkedAt: new Date(now()).toISOString(),
            ...(result.deferred ? { nextAttemptAt: now() + BUSY_INTERVAL } : {}) };
          await atomicJson(join(updateDirectory(home), 'automatic-result.json'), outcome);
        } else {
          outcome = null;
          await rm(join(updateDirectory(home), 'automatic-result.json'), { force: true });
        }
      } else if (!approved && !status.error) {
        outcome = null;
        await rm(join(updateDirectory(home), 'automatic-result.json'), { force: true });
      }
    } catch (error) {
      if (stopped) return;
      const busy = error.code === 'remote_work_active';
      outcome = { version: error.version ?? status?.policy?.auto, checkedAt: new Date(now()).toISOString(), deferred: true,
        code: busy ? 'remote_work_active' : error.code === 'installer_pending' ? 'installer_pending' : 'update_failed',
        nextAttemptAt: now() + (busy ? BUSY_INTERVAL : Math.max(FAILURE_INTERVAL, error.retryAfterMs ?? 0)),
        message: busy ? '更新已准备；远程工作结束后会再次尝试安装。'
          : '自动更新暂未完成；已保留当前版本，将稍后重试。可查看安装结果或手动检查更新。' };
      await atomicJson(join(updateDirectory(home), 'automatic-result.json'), outcome).catch(() => {});
    }
    finally {
      if (!stopped) {
        // There is one persisted check deadline; do not add another 6-hour delay
        // after a cache hit, restart, manual check or failed hourly retry.
        const deadlines = [Number.isFinite(status?.nextCheckAt) ? status.nextCheckAt : now() + FAILURE_INTERVAL];
        if (Number.isFinite(outcome?.nextAttemptAt) && status?.automatic && !status.error) deadlines.push(outcome.nextAttemptAt);
        timer = schedule(tick, Math.max(1000, Math.min(...deadlines) - now())); timer.unref?.();
        notifyObserver(onChange);
      }
    }
  };
  timer = schedule(tick, 15000 + Math.random() * 15000); timer.unref?.();
  return () => { stopped = true; controller.abort(); cancel(timer); };
}
