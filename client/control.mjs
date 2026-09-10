import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open as openFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { control } from './http.mjs';
import { COMPONENTS, installServices, serviceAction, serviceLabel } from './platform.mjs';
import { deviceStatus } from './setup.mjs';
import { atomicJson, installRoot, loadState, stateHome } from './state.mjs';

const exec = promisify(execFile);
const REDACTED = '<REDACTED>';

async function launchDetached(command, args) {
  await new Promise((resolveLaunch, reject) => {
    const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
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

const deactivateRemoteStartup = (state, home) =>
  serviceAction(process.platform === 'linux' ? 'disable' : 'remove', state, home, COMPONENTS);

export async function suspendRemoteAccess(home = stateHome(), dependencies = {}) {
  const deactivate = dependencies.deactivateRemoteStartup ?? deactivateRemoteStartup;
  const sendControl = dependencies.control ?? control;
  let state = await loadState(home);
  // Persist the user's safety intent first. Even if the network disappears mid-operation,
  // a later runtime start must still observe that remote access is supposed to stay closed.
  state = await saveRemoteAccess(state, home, 'suspended');
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

export async function resumeRemoteAccess(home = stateHome()) {
  let state = await loadState(home);
  try {
    await installServices({ ...state, remoteAccess: 'active' }, home, undefined, COMPONENTS);
    await serviceAction('start', state, home, COMPONENTS);
    const deadline = Date.now() + 60000;
    let status;
    do {
      status = await deviceStatus(home);
      if (status.localReady && ['suspended', 'active'].includes(status.gateway)) break;
      await sleep(1000);
    } while (Date.now() < deadline);
    if (!status?.localReady) throw new Error('Local runtime, bridge or tunnel is not ready.');
    await control(state.gateway, '/v1/device/resume', state.deviceSecret, { body: identity(state), timeout: 15000 });
    state = await saveRemoteAccess(state, home, 'active');
  } catch (error) {
    await rollbackResumeFailure(error,
      () => control(state.gateway, '/v1/device/suspend', state.deviceSecret, { body: identity(state), timeout: 15000 }),
      () => deactivateRemoteStartup(state, home));
  }
  return deviceStatus(home);
}

export async function restartTeamDevSpace(home = stateHome()) {
  const state = await loadState(home);
  if (state.remoteAccess === 'suspended') throw new Error('Remote access is suspended; resume it before restarting connection services');
  await serviceAction('restart', state, home, COMPONENTS);
  return deviceStatus(home);
}

export async function stopTeamDevSpace(home = stateHome()) {
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

async function recentErrors(home, state = null) {
  const summaries = [];
  for (const component of ['runtime', 'tunnel', 'tray']) {
    let lines = [];
    if (process.platform === 'linux' && COMPONENTS.includes(component)) {
      try {
        const unit = `${serviceLabel(state ?? { deviceId: '' }, component)}.service`;
        const { stdout } = await exec('journalctl', ['--user', '--no-pager', '--output=cat', '-p', 'warning', '-n', '40', '-u', unit],
          { timeout: 5000, maxBuffer: 256 * 1024 });
        lines = redactDiagnostic(stdout).split(/\r?\n/).filter(Boolean).map(line => line.slice(0, 500)).slice(-8);
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
  } catch {
    return { release: null, manifest, devspace: null, platform: process.platform, architecture: process.arch,
      remoteAccess: 'not-enrolled', desiredRemoteAccess: 'not-enrolled', devspaceHealth: false,
      bridgeHealth: false, tunnelHealth: false, gatewayHealth: 'not-enrolled', recentErrors: await recentErrors(home, state) };
  }
  return {
    release: state.releaseVersion,
    manifest,
    devspace: state.devspaceVersion,
    platform: process.platform,
    architecture: process.arch,
    remoteAccess: status.remoteAccess,
    desiredRemoteAccess: status.desiredRemoteAccess,
    devspaceHealth: status.devspace,
    bridgeHealth: status.bridge,
    tunnelHealth: status.tunnel,
    gatewayHealth: status.gateway,
    recentErrors: await recentErrors(home, state),
  };
}

export async function copyDiagnosticReport(home = stateHome()) {
  const text = JSON.stringify(await diagnosticReport(home), null, 2);
  const command = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : process.platform === 'darwin' ? '/usr/bin/pbcopy' : 'xclip';
  const args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd() | Set-Clipboard']
    : process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
  await new Promise((resolveCopy, reject) => {
    const child = execFile(command, args, { windowsHide: true }, error => error ? reject(error) : resolveCopy());
    child.stdin.end(text, 'utf8');
  });
  return text;
}

export async function openLogs(home = stateHome(), { launch = launchDetached, follow = false } = {}) {
  if (process.platform === 'linux') {
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
  const command = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') : '/usr/bin/open';
  await launch(command, [directory]);
  return directory;
}
