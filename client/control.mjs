import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { control } from './http.mjs';
import { COMPONENTS, installServices, serviceAction } from './platform.mjs';
import { deviceStatus } from './setup.mjs';
import { atomicJson, loadState, stateHome } from './state.mjs';

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

export async function suspendRemoteAccess(home = stateHome()) {
  let state = await loadState(home);
  await control(state.gateway, '/v1/device/suspend', state.deviceSecret, { body: identity(state), timeout: 15000 });
  state = await saveRemoteAccess(state, home, 'suspended');
  try { await serviceAction('remove', state, home, COMPONENTS); }
  catch (error) {
    throw new Error(`Remote access is suspended at the Gateway, but local services or login startup were not fully removed: ${error.message}`);
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
      () => serviceAction('remove', state, home, COMPONENTS));
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
  let state = await loadState(home);
  state = await saveRemoteAccess(state, home, 'suspended');
  const gatewaySuspend = control(state.gateway, '/v1/device/suspend', state.deviceSecret, {
    body: identity(state), timeout: 3000,
  }).then(() => true, () => false);
  await serviceAction('remove', state, home, COMPONENTS);
  if (!await gatewaySuspend) {
    throw new Error('Local services are stopped, but Gateway suspension could not be confirmed. Retry closing Team DevSpace.');
  }
  return { stopped: true, deviceId: state.deviceId, remoteAccess: 'suspended' };
}

export function redactDiagnostic(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s]+/gi, `Bearer ${REDACTED}`)
    .replace(/\btds_[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
}

async function recentErrors(home) {
  const summaries = [];
  for (const component of ['runtime', 'tunnel', 'tray']) {
    try {
      const value = await readFile(join(home, 'logs', `${component}.error.log`), 'utf8');
      const lines = redactDiagnostic(value).split(/\r?\n/).filter(Boolean).slice(-8);
      if (lines.length) summaries.push({ component, lines });
    } catch {}
  }
  return summaries;
}

export async function diagnosticReport(home = stateHome()) {
  let state;
  let status;
  try {
    state = await loadState(home);
    status = await deviceStatus(home);
  } catch {
    return { release: null, devspace: null, platform: process.platform, architecture: process.arch,
      remoteAccess: 'not-enrolled', devspaceHealth: false, bridgeHealth: false, tunnelHealth: false,
      gatewayHealth: 'not-enrolled', bindingState: 'not-enrolled', recentErrors: await recentErrors(home) };
  }
  return {
    release: state.releaseVersion,
    devspace: state.devspaceVersion,
    platform: process.platform,
    architecture: process.arch,
    remoteAccess: status.remoteAccess,
    devspaceHealth: status.devspace,
    bridgeHealth: status.bridge,
    tunnelHealth: status.tunnel,
    gatewayHealth: status.gateway,
    bindingState: status.gateway,
    recentErrors: await recentErrors(home),
  };
}

export async function copyDiagnosticReport(home = stateHome()) {
  const text = JSON.stringify(await diagnosticReport(home), null, 2);
  const command = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'clip.exe')
    : process.platform === 'darwin' ? '/usr/bin/pbcopy' : 'xclip';
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
  await new Promise((resolveCopy, reject) => {
    const child = execFile(command, args, { windowsHide: true }, error => error ? reject(error) : resolveCopy());
    child.stdin.end(text);
  });
  return text;
}

export async function openLogs(home = stateHome(), { launch = launchDetached } = {}) {
  const directory = join(home, 'logs');
  const command = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
    : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  await launch(command, [directory]);
  return directory;
}
