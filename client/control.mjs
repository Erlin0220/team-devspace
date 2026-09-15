import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open as openFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { control } from './http.mjs';
import { COMPONENTS, installServices, linuxJournalInvocation, serviceAction, serviceLabel } from './platform.mjs';
import { deviceStatus } from './setup.mjs';
import { atomicJson, installRoot, loadState, privateDirectory, readJson, stateHome, RELEASE_VERSION } from './state.mjs';
import { openWindowsDirectory } from './windows-desktop.mjs';
import { withDeviceOperation, notifyObserver } from './operation.mjs';
import { linuxServiceManager } from './linux-lifecycle.mjs';

const exec = promisify(execFile);
const REDACTED = '<REDACTED>';

async function launchDetached(command, args) {
  await new Promise((resolveLaunch, reject) => {
    const child = spawn(command, args, { windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

function identity(state) {
  return { keyId: state.keyId, bindingId: state.bindingId };
}

async function saveRemoteAccess(state, home, remoteAccess) {
  const next = { ...state, remoteAccess };
  await atomicJson(join(home, 'state.json'), next);
  return next;
}

export function localPauseServiceAction(platform = process.platform) {
  if (platform === 'win32' || platform === 'linux') return 'disable';
  return 'stop';
}

const deactivateRemoteStartup = (state, home) =>
  serviceAction(localPauseServiceAction(), state, home, COMPONENTS);

export function suspendRemoteAccess(home = stateHome(), dependencies = {}) {
  return withDeviceOperation(home, () => suspendRemoteAccessUnlocked(home, dependencies));
}

async function suspendRemoteAccessUnlocked(home = stateHome(), dependencies = {}) {
  const deactivate = dependencies.deactivateRemoteStartup ?? deactivateRemoteStartup;
  const sendControl = dependencies.control ?? control;
  const onProgress = dependencies.onProgress ?? (() => {});
  let state = await loadState(home);
  // Persist the user's safety intent first. Even if the network disappears mid-operation,
  // a later runtime start must still observe that remote access is supposed to stay closed.
  notifyObserver(onProgress, '正在保存暂停状态…');
  state = await saveRemoteAccess(state, home, 'suspended');
  notifyObserver(onProgress, '正在停止本机连接并同步服务端…');
  const [local, gateway] = await Promise.allSettled([
    deactivate(state, home),
    sendControl(state.gateway, '/v1/device/suspend', state.deviceSecret, { body: identity(state), timeout: 15000 }),
  ]);
  if (local.status === 'rejected' && gateway.status === 'rejected') {
    throw new Error(`暂停意图已保存，但本机服务停止和 Gateway 暂停都未能确认：${gateway.reason?.message ?? gateway.reason}`);
  }
  if (local.status === 'rejected') {
    throw new Error(`Gateway 已暂停远程访问，但本机服务尚未完全停止：${local.reason?.message ?? local.reason}`);
  }
  if (gateway.status === 'rejected') {
    throw new Error(`本机已暂停，Gateway 状态暂未确认：${gateway.reason?.message ?? gateway.reason}`);
  }
  notifyObserver(onProgress, '正在确认暂停状态…');
  return deviceStatus(home);
}

export async function rollbackResumeFailure(error, suspendGateway, cleanupLocal) {
  let gatewayRollbackFailed = false;
  let localCleanupFailed = false;
  try { await suspendGateway(); } catch { gatewayRollbackFailed = true; }
  try { await cleanupLocal(); } catch { localCleanupFailed = true; }
  if (gatewayRollbackFailed && localCleanupFailed) {
    throw new Error(`Resume failed and neither Gateway suspension nor local service shutdown could be confirmed: ${error.message}`);
  }
  if (gatewayRollbackFailed) {
    throw new Error(`Local services were stopped, but Gateway suspension could not be confirmed after resume failed: ${error.message}`);
  }
  if (localCleanupFailed) {
    throw new Error(`Gateway is suspended, but local services could not be fully stopped after resume failed: ${error.message}`);
  }
  throw new Error(`Remote access remains suspended: ${error.message}`);
}

export function resumeRemoteAccess(home = stateHome(), dependencies = {}) {
  return withDeviceOperation(home, () => resumeRemoteAccessUnlocked(home, dependencies));
}

async function resumeRemoteAccessUnlocked(home = stateHome(), dependencies = {}) {
  const sendControl = dependencies.control ?? control;
  const install = dependencies.installServices ?? installServices;
  const service = dependencies.serviceAction ?? serviceAction;
  const statusOf = dependencies.deviceStatus ?? deviceStatus;
  const onProgress = dependencies.onProgress ?? (() => {});
  let state = await loadState(home);
  try {
    // The runtime enforces the persisted pause. Start it only after confirming
    // Gateway denial, then lift the local pause before spawning the process.
    notifyObserver(onProgress, '正在准备恢复远程访问…');
    await sendControl(state.gateway, '/v1/device/suspend', state.deviceSecret, { body: identity(state), timeout: 15000 });
    state = await saveRemoteAccess(state, home, 'active');
    notifyObserver(onProgress, '正在启动本机连接…');
    if (process.platform === 'linux') {
      await install(state, home, undefined, COMPONENTS);
      await service('start', state, home, COMPONENTS);
    } else {
      // Windows keeps stable Task Scheduler entries and disables them while paused.
      // macOS keeps its LaunchAgent files and boots jobs out of the user domain.
      // Older suspended installs may have removed entries; repair them only when
      // normal reactivation proves they are missing or unusable.
      try {
        if (process.platform === 'win32') await service('enable', state, home, COMPONENTS);
        await service('start', state, home, COMPONENTS);
      } catch {
        await install(state, home, undefined, COMPONENTS);
        await service('start', state, home, COMPONENTS);
      }
    }
    notifyObserver(onProgress, '正在等待本机与连接通道就绪…');
    const deadline = Date.now() + 60000;
    let resumed = false;
    let readinessError;
    do {
      const status = await statusOf(home);
      if (status.localReady && ['suspended', 'active'].includes(status.gateway)) {
        notifyObserver(onProgress, '正在确认远程访问…');
        try {
          // cloudflared /ready means an edge connection, not that the Gateway
          // can already reach this device. Keep denial until its probe succeeds.
          await sendControl(state.gateway, '/v1/device/resume', state.deviceSecret, { body: {
            ...identity(state), version: RELEASE_VERSION, platform: `${process.platform}-${process.arch}` }, timeout: 15000 });
          resumed = true;
          break;
        } catch (error) {
          if (!['device_not_ready', 'device_offline'].includes(error.code)) throw error;
          readinessError = error;
        }
      }
      await sleep(1000);
    } while (Date.now() < deadline);
    if (!resumed) throw readinessError ?? new Error('Local runtime, bridge or tunnel is not ready.');
    notifyObserver(onProgress, '正在确认恢复状态…');
  } catch (error) {
    try { state = await saveRemoteAccess(state, home, 'suspended'); }
    catch { error = new Error(`${error.message}; could not persist the local pause; startup cleanup is required`); }
    await rollbackResumeFailure(error,
      () => sendControl(state.gateway, '/v1/device/suspend', state.deviceSecret, { body: identity(state), timeout: 15000 }),
      () => service(localPauseServiceAction(), state, home, COMPONENTS));
  }
  return statusOf(home);
}

export function restartTeamDevSpace(home = stateHome(), dependencies = {}) {
  return withDeviceOperation(home, () => restartTeamDevSpaceUnlocked(home, dependencies));
}

async function restartTeamDevSpaceUnlocked(home = stateHome(), dependencies = {}) {
  const onProgress = dependencies.onProgress ?? (() => {});
  const service = dependencies.serviceAction ?? serviceAction;
  const statusOf = dependencies.deviceStatus ?? deviceStatus;
  const state = await loadState(home);
  if (state.remoteAccess === 'suspended') throw new Error('Remote access is suspended; resume it before restarting connection services');
  notifyObserver(onProgress, '正在重启本机连接…');
  await service('restart', state, home, COMPONENTS);
  notifyObserver(onProgress, '正在确认连接状态…');
  return statusOf(home);
}

export function stopTeamDevSpace(home = stateHome()) {
  return withDeviceOperation(home, () => stopTeamDevSpaceUnlocked(home));
}

async function stopTeamDevSpaceUnlocked(home = stateHome()) {
  // A first-run tray has no connection services yet. It must still be closable.
  // Corrupt/unreadable state is not treated as an unconfigured installation.
  if (!await readJson(join(home, 'state.json'), null)) return { stopped: true, configured: false, startupRetained: true };
  const state = await loadState(home);
  await serviceAction('stop', state, home, COMPONENTS);
  return { stopped: true, deviceId: state.deviceId,
    remoteAccess: state.remoteAccess === 'suspended' ? 'suspended' : 'active', startupRetained: true };
}

export function redactDiagnostic(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s]+/gi, `Bearer ${REDACTED}`)
    .replace(/\btds_[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
}

async function readTail(path, maxBytes = 64 * 1024) {
  const file = await openFile(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (size > maxBytes) {
      const newline = text.indexOf('\n');
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text;
  } finally { await file.close(); }
}

async function manifestIdentity() {
  try {
    const value = await readFile(join(installRoot, 'install-manifest.json'));
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  } catch { return null; }
}

async function recentErrors(home) {
  const summaries = [];
  const journal = process.platform === 'linux' && await linuxServiceManager().catch(() => 'unavailable') === 'systemd-user';
  for (const component of ['runtime', 'tunnel', 'tray']) {
    let lines = [];
    if (journal && COMPONENTS.includes(component)) {
      try {
        const invocation = await linuxJournalInvocation(home, component);
        if (invocation) {
          const { stdout } = await exec('journalctl', ['--user', '--no-pager', '--output=cat', '-p', 'warning', '-n', '40',
            `_SYSTEMD_INVOCATION_ID=${invocation}`, '+', `USER_INVOCATION_ID=${invocation}`],
            { timeout: 5000, maxBuffer: 256 * 1024 });
          lines = redactDiagnostic(stdout).split(/\r?\n/).filter(Boolean).map(line => line.slice(0, 500)).slice(-8);
        }
      } catch {}
    }
    if (!lines.length) {
      try {
        lines = redactDiagnostic(await readTail(join(home, 'logs', `${component}.error.log`)))
          .split(/\r?\n/).filter(line => line && !/UNDICI-EHPA|node --trace-warnings/i.test(line))
          .map(line => line.slice(0, 500)).slice(-8);
      } catch {}
    }
    if (lines.length) summaries.push({ component, lines });
  }
  return summaries;
}

export async function diagnosticReport(home = stateHome()) {
  let state;
  let status;
  const manifest = await manifestIdentity();
  try {
    state = await loadState(home);
    status = await deviceStatus(home);
  } catch (error) {
    const missing = await readJson(join(home, 'state.json'), null).then(value => value === null, () => false);
    const unavailable = missing ? 'not-enrolled' : 'unknown';
    return { release: state?.releaseVersion ?? null, manifest, devspace: null, platform: process.platform, architecture: process.arch,
      remoteAccess: unavailable, desiredRemoteAccess: state?.remoteAccess ?? unavailable,
      stateHealth: missing ? 'not-configured' : state ? 'readable' : 'unreadable',
      ...(!missing ? { error: redactDiagnostic(error.message) } : {}), devspaceHealth: false,
      bridgeHealth: false, tunnelHealth: false, gatewayHealth: unavailable, recentErrors: await recentErrors(home) };
  }
  return {
    release: state.releaseVersion,
    manifest,
    devspace: state.devspaceVersion,
    platform: process.platform,
    architecture: process.arch,
    ...(process.platform === 'linux' ? { lifecycle: await linuxServiceManager().catch(() => 'unavailable') } : {}),
    remoteAccess: status.remoteAccess,
    desiredRemoteAccess: status.desiredRemoteAccess,
    devspaceHealth: status.devspace,
    bridgeHealth: status.bridge,
    tunnelHealth: status.tunnel,
    gatewayHealth: status.gateway,
    projectRootAvailable: status.currentProjectRootAvailable,
    recentErrors: await recentErrors(home),
  };
}

export async function openLogs(home = stateHome(), { launch, follow = false } = {}) {
  if (process.platform === 'linux') {
    const manager = await linuxServiceManager().catch(() => 'unavailable');
    if (manager !== 'systemd-user') {
      const paths = COMPONENTS.flatMap(component => ['.log', '.error.log'].map(suffix => join(home, 'logs', `${component}${suffix}`)));
      if (!follow) {
        for (const path of paths) {
          const text = await readTail(path).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          if (text) process.stdout.write(`=== ${path} ===\n${redactDiagnostic(text)}\n`);
        }
      } else {
        // Reuse the host's standard tail utility; no log service or new IPC.
        await new Promise((resolveLogs, reject) => {
          const child = spawn('tail', ['-n', '200', '-F', ...paths], { stdio: ['ignore', 'pipe', 'inherit'] });
          child.stdout.setEncoding('utf8');
          let pending = '';
          child.stdout.on('data', chunk => {
            pending += chunk;
            const end = pending.lastIndexOf('\n');
            if (end >= 0) { process.stdout.write(redactDiagnostic(pending.slice(0, end + 1))); pending = pending.slice(end + 1); }
            if (pending.length > 65536) pending = '<truncated log line>';
          });
          const stop = () => child.kill('SIGTERM');
          process.once('SIGTERM', stop); process.once('SIGINT', stop);
          const cleanup = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); };
          child.once('error', error => { cleanup(); reject(error); });
          child.once('exit', (code, signal) => { cleanup(); code === 0 || signal ? resolveLogs() : reject(new Error(`tail exited with code ${code}`)); });
        });
      }
      return { source: 'files', paths, lifecycle: manager };
    }
    const state = await loadState(home);
    const units = COMPONENTS.map(component => `${serviceLabel(state, component)}.service`);
    const args = ['--user', '--no-pager', '--output=short-iso', ...(follow ? ['--follow'] : ['-n', '200']),
      ...units.flatMap(unit => ['-u', unit])];
    if (follow) {
      await new Promise((resolveLogs, reject) => {
        const child = spawn('journalctl', args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolveLogs() : reject(new Error(`journalctl exited with code ${code}`)));
      });
    } else {
      const { stdout } = await exec('journalctl', args, { timeout: 10000, maxBuffer: 1024 * 1024 });
      process.stdout.write(stdout);
    }
    return { source: 'journalctl', units };
  }
  const directory = join(home, 'logs');
  await privateDirectory(directory);
  if (process.platform === 'win32' && !launch) await openWindowsDirectory(directory);
  else {
    const command = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') : '/usr/bin/open';
    await (launch ?? launchDetached)(command, [directory]);
  }
  return directory;
}
