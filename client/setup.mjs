import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { approvedProjectRoot, atomicJson, atomicText, DEVSPACE_VERSION, installRoot, loadState, normalizeGateway,
  projectRootAvailable, projectRootFromState, randomSecret, readJson, secureStateDirectory, stateHome, writeUpstreamConfig } from './state.mjs';
import { control, loopbackRequest } from './http.mjs';
import { readGatewayStatus } from './gateway-status.mjs';
import { COMPONENTS, enabledStartupComponents, installServices, serviceAction } from './platform.mjs';

import { chooseWindowsProject } from './windows-desktop.mjs';
import { withDeviceOperation, notifyObserver } from './operation.mjs';
import { runMacForm } from './macos-ui.mjs';
import { trayExecutable, trayInstanceId } from './desktop.mjs';

async function hasTunnelCredential(home) {
  try { return Boolean((await readFile(join(home, 'tunnel.token'), 'utf8')).trim()); }
  catch { return false; }
}

function sameProjectRoot(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
    const server = net.createServer();
    const free = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free loopback port available for Team DevSpace');
}

export function configureDevice(input, options = {}) {
  const home = options.home ?? stateHome();
  return withDeviceOperation(home, () => configureDeviceUnlocked(input, { ...options, home }));
}

async function configureDeviceUnlocked(input, { home = stateHome(), startup = true, onProgress = () => {} } = {}) {
  notifyObserver(onProgress, 'Preparing private device state...');
  await secureStateDirectory(home);
  const release = await readJson(join(installRoot, 'release.config.json'));
  const previous = await readJson(join(home, 'state.json'), null);
  const gateway = normalizeGateway(input.gateway ?? previous?.gateway ?? release.gateway);
  const accessKey = input.accessKey ?? previous?.accessKey;
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(accessKey ?? '')) throw new Error('Enter the Access Key assigned by your administrator');
  if (previous?.gateway !== undefined && previous.gateway !== gateway) {
    throw new Error('This installation already belongs to another gateway. Reset the Device Binding with the administrator first; do not overwrite its state.');
  }
  if (previous?.bindingId && previous.accessKey !== accessKey) {
    throw new Error('This installation already belongs to another Access Key. Use the tray Access Key action so the current Device Binding is released safely first.');
  }
  if (input.roots !== undefined && (!Array.isArray(input.roots) || input.roots.length !== 1)) {
    throw Object.assign(new Error('Team DevSpace 当前只支持一个项目目录，请只选择一个项目'), { code: 'multiple_project_roots_unsupported' });
  }
  const requestedProjectRoot = input.currentProjectRoot ?? input.roots?.[0];
  const previousProjectRoot = projectRootFromState(previous);
  const currentProjectRoot = requestedProjectRoot === undefined
    ? previousProjectRoot
    : await approvedProjectRoot(requestedProjectRoot);
  if (!currentProjectRoot) {
    throw Object.assign(new Error('请选择要让 Team DevSpace 操作的项目目录'), { code: 'project_root_required' });
  }
  if (previous?.bindingId && requestedProjectRoot !== undefined &&
      !sameProjectRoot(previousProjectRoot, currentProjectRoot)) {
    throw Object.assign(new Error('已绑定设备请使用“项目目录…”或 project-root set 修改项目目录'),
      { code: 'project_root_change_requires_command' });
  }
  let state = previous ? await loadState(home) : {
    schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
    ports: { devspace: await availablePort(47670), bridge: await availablePort(47770), metrics: await availablePort(47870) },
  };
  state = { ...state, gateway, accessKey, currentProjectRoot };
  delete state.roots;
  // Publish the first identity without replacement. Concurrent installers must share one binding.
  const published = await atomicJson(join(home, 'state.json'), state, { createOnly: !previous });
  if (!published) {
    state = await loadState(home);
    if (state.gateway !== gateway || state.accessKey !== accessKey) throw new Error('Another setup already enrolled this installation with different credentials');
    if (!sameProjectRoot(state.currentProjectRoot, currentProjectRoot)) {
      throw Object.assign(new Error('另一个安装流程已经为此设备选择了不同的项目目录，请重新检查当前项目目录'),
        { code: 'project_root_conflict' });
    }
  }
  if (previous?.bindingId && previous?.keyId && previous?.hostname && await hasTunnelCredential(home)) {
    notifyObserver(onProgress, 'Existing Enrollment found. Reusing the current Device Binding...');
    const remoteAccess = previous.remoteAccess === 'suspended' ? 'suspended' : 'active';
    state = { ...state, keyId: previous.keyId, bindingId: previous.bindingId, hostname: previous.hostname,
      endpoint: previous.endpoint ?? `${gateway}/mcp`, releaseVersion: release.version, devspaceVersion: DEVSPACE_VERSION,
      remoteAccess };
    await writeUpstreamConfig(state, home);
    await atomicJson(join(home, 'state.json'), state);
    if (startup) {
      await serviceAction('stop', previous, home);
      notifyObserver(onProgress, 'Refreshing current-user login startup entries...');
      await installServices(state, home);
      const startComponents = enabledStartupComponents(state);
      if (startComponents.length) await serviceAction('start', state, home, startComponents);
    }
    return { enrolled: true, reusedEnrollment: true, ready: false, connection: startup ? 'starting' : 'not-started',
      remoteAccess: state.remoteAccess, deviceId: state.deviceId, bindingId: state.bindingId,
      endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION, currentProjectRoot: state.currentProjectRoot,
      startup: startup ? 'installed' : 'not-installed' };
  }

  notifyObserver(onProgress, 'Contacting the Team Gateway and confirming Enrollment...');
  const binding = await control(gateway, '/v1/enroll', accessKey, {
    body: { deviceId: state.deviceId, deviceSecret: state.deviceSecret, bridgePort: state.ports.bridge,
      version: release.version, platform: `${process.platform}-${process.arch}` },
  });
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (binding.deviceId !== state.deviceId || !uuid.test(binding.bindingId ?? '') || !uuid.test(binding.keyId ?? '') ||
      typeof binding.tunnelToken !== 'string' || !binding.tunnelToken || binding.endpoint !== `${gateway}/mcp` ||
      binding.devspaceVersion !== DEVSPACE_VERSION || binding.controlApiVersion !== release.controlApiVersion) {
    throw new Error('Gateway returned an incompatible Enrollment');
  }
  notifyObserver(onProgress, 'Enrollment confirmed. Preparing the local runtime...');
  state = { ...state, keyId: binding.keyId, bindingId: binding.bindingId, hostname: binding.hostname,
    endpoint: binding.endpoint, releaseVersion: release.version, devspaceVersion: DEVSPACE_VERSION,
    // Recovering credentials is not consent to resume. Only the explicit resume
    // operation may release a locally persisted pause.
    remoteAccess: state.remoteAccess === 'suspended' || binding.state === 'suspended' ? 'suspended' : 'active' };
  await atomicText(join(home, 'tunnel.token'), binding.tunnelToken);
  await writeUpstreamConfig(state, home);
  await atomicJson(join(home, 'state.json'), state);
  if (startup) {
    notifyObserver(onProgress, 'Installing current-user login startup entries...');
    await installServices(state, home);
    const startComponents = enabledStartupComponents(state);
    if (startComponents.length) await serviceAction('start', state, home, startComponents);
    notifyObserver(onProgress, state.remoteAccess === 'suspended'
      ? 'Enrollment is complete. Remote access remains safely suspended.'
      : 'Enrollment is complete. Team DevSpace is connecting in the background.');
  }
  return { enrolled: true, ready: false, connection: startup ? 'starting' : 'not-started',
    remoteAccess: state.remoteAccess, deviceId: state.deviceId, bindingId: state.bindingId,
    endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION, currentProjectRoot: state.currentProjectRoot,
    startup: startup ? 'installed' : 'not-installed' };
}

export async function promptProjectRoot(currentProjectRoot, { signal, home = stateHome() } = {}) {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)(trayExecutable(), ['choose-folder'],
        { signal, timeout: 300000, maxBuffer: 16384, env: { ...process.env,
          TEAM_DEVSPACE_TRAY_INSTANCE_ID: await trayInstanceId(home),
          TEAM_DEVSPACE_CURRENT_PROJECT_ROOT: currentProjectRoot ?? '' } });
      const result = JSON.parse(stdout);
      if (result.event === 'duplicate') throw new Error('本机设置窗口已经打开，请先完成或关闭该窗口');
      if (result.event !== 'folder-result' || (result.projectRoot !== null && typeof result.projectRoot !== 'string')) {
        throw new Error('目录选择器未返回有效结果');
      }
      return result.projectRoot;
    } catch (error) {
      if (error.name === 'AbortError') return null;
      throw new Error('无法完成目录选择，请关闭其他设置窗口后重试，或直接输入目录路径');
    }
  }
  if (process.platform !== 'win32') throw new Error('Use an absolute project directory on this platform');
  return chooseWindowsProject(currentProjectRoot, { signal });
}

async function waitForRuntimeReady(state, home, { request = loopbackRequest, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const [devspace, bridge] = await Promise.all([
      request(state.ports.devspace, '/healthz', { timeout: 1000 }).then(result => result.status === 200, () => false),
      request(state.ports.bridge, '/healthz', { timeout: 1000, headers: {
        Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId,
      } }).then(result => result.status === 200, () => false),
    ]);
    if (devspace && bridge) return;
    await sleep(250);
  } while (Date.now() < deadline);
  throw Object.assign(new Error('新的项目目录已写入，但本机运行时未能恢复就绪'), { code: 'project_root_runtime_not_ready' });
}

export function changeProjectRoot(projectRoot, home = stateHome(), options = {}) {
  return withDeviceOperation(home, () => changeProjectRootUnlocked(projectRoot, home, options));
}

async function changeProjectRootUnlocked(projectRoot, home, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const service = options.serviceAction ?? ((action, state) => serviceAction(action, state, home, ['runtime']));
  const writeConfig = options.writeUpstreamConfig ?? (state => writeUpstreamConfig(state, home));
  const saveState = options.saveState ?? (state => atomicJson(join(home, 'state.json'), state));
  const verifyRuntime = options.verifyRuntime ?? (state => waitForRuntimeReady(state, home));
  const state = await loadState(home);
  const nextRoot = await approvedProjectRoot(projectRoot);
  const same = sameProjectRoot(state.currentProjectRoot, nextRoot);
  if (same) return { changed: false, currentProjectRoot: state.currentProjectRoot };

  const next = { ...state, currentProjectRoot: nextRoot };
  const shouldRun = Boolean(state.bindingId) && state.remoteAccess !== 'suspended';
  let stopAttempted = false;
  try {
    notifyObserver(onProgress, '正在切换项目目录…');
    if (shouldRun) {
      notifyObserver(onProgress, '正在停止当前项目连接…');
      stopAttempted = true;
      await service('stop', state);
    }
    notifyObserver(onProgress, '正在保存新的项目目录…');
    await writeConfig(next);
    await saveState(next);
    if (shouldRun) {
      notifyObserver(onProgress, '正在启动新的项目连接…');
      await service('start', next);
      notifyObserver(onProgress, '正在确认新的项目连接…');
      await verifyRuntime(next);
    }
    return { changed: true, currentProjectRoot: nextRoot, previousProjectRoot: state.currentProjectRoot,
      reconnectRequired: shouldRun,
      note: shouldRun ? '项目目录已更改，请在 ChatGPT 中重新连接。' : '项目目录已更改。' };
  } catch (error) {
    const rollbackFailures = [];
    if (shouldRun && stopAttempted) {
      try { await service('stop', next); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    // A failed stop leaves ownership unresolved. Do not change the running
    // owner's configuration or start another owner until cleanup is confirmed.
    if (!rollbackFailures.length) {
      try { await writeConfig(state); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
      try { await saveState(state); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (shouldRun && stopAttempted && !rollbackFailures.length) {
      try { await service('start', state); await verifyRuntime(state); }
      catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (rollbackFailures.length) {
      throw Object.assign(new Error(`项目目录切换失败，且原目录恢复未完成：${error.message}`,
        { cause: new AggregateError([error, ...rollbackFailures], 'Project rollback could not safely restore the runtime') }),
      { code: 'project_root_rollback_failed' });
    }
    throw Object.assign(new Error(`项目目录切换失败，已恢复原目录：${error.message}`), { code: 'project_root_change_failed' });
  }
}

export function configureFromDesktop(home, options) {
  return withDeviceOperation(home, () => configureFromDesktopUnlocked(home, options));
}

async function configureFromDesktopUnlocked(home, { onProgress, startup, input = {},
  installServices: install = installServices, serviceAction: service = serviceAction }) {
  const enrolled = await configureDevice(input, { home, startup: false, onProgress });
  if (!startup) return { ...enrolled, startup: 'not-installed' };
  const state = await loadState(home);
  await install(state, home, undefined, COMPONENTS);
  const startComponents = enabledStartupComponents(state).filter(component => COMPONENTS.includes(component));
  if (startComponents.length) await service('start', state, home, startComponents);
  let warning;
  if (process.platform === 'win32') {
    // First-run Windows desktop can exist before Enrollment. Register its login
    // entry without making that optional presentation entry block core startup.
    // Its failure must not undo Enrollment or stop the currently visible tray.
    try {
      try { await readFile(join(home, 'startup', 'tray.xml')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await install(state, home, undefined, ['tray']);
      }
    } catch {
      warning = '设备绑定已保留，托盘登录启动项暂不可用；当前连接不受影响，可通过安装器修复。';
      notifyObserver(onProgress, warning);
    }
  }
  return { ...enrolled, startup: warning ? 'partial' : 'installed', ...(warning ? { warning } : {}) };
}

export function replaceAccessKey(accessKey, home = stateHome(), options = {}) {
  return withDeviceOperation(home, () => replaceAccessKeyUnlocked(accessKey, home, options));
}

async function replaceAccessKeyUnlocked(accessKey, home = stateHome(), { onProgress = () => {}, startup = true } = {}) {
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(accessKey ?? '')) throw new Error('请输入完整的 Access Key');
  let state = await loadState(home);
  const sameAccessKey = !state.pendingAccessKey && state.accessKey === accessKey;
  const preservePause = state.remoteAccess === 'suspended';
  if (sameAccessKey && !state.bindingId) {
    // Enrollment may have committed remotely before its response was lost.
    // Retry with the retained identity, not a preflight that rejects bound keys.
    notifyObserver(onProgress, '正在继续未完成的设备绑定…');
    return { ...await configureFromDesktop(home, { onProgress, startup }), recoveredEnrollment: true };
  }

  notifyObserver(onProgress, sameAccessKey ? '正在确认管理员重置后的设备绑定状态…' : '正在验证新的 Access Key…');
  const preflight = await control(state.gateway, '/v1/enrollment/preflight', accessKey, { body: {}, timeout: 15000 })
    .catch(error => {
      if (error.status === 404) throw Object.assign(new Error('网关尚未部署更换 Access Key 所需接口，请先更新网关；当前 Key 和连接未更改'), { code: 'gateway_update_required' });
      throw error;
    });
  if (!preflight.available) {
    if (sameAccessKey) {
      throw Object.assign(new Error('当前 Access Key 仍处于设备绑定状态；如需重新绑定，请联系管理员执行“重置设备绑定”后再试'),
        { code: 'access_key_still_bound' });
    }
    throw Object.assign(new Error('这个 Access Key 已绑定到其他设备，请联系管理员执行“重置设备绑定”后再试'),
      { code: 'access_key_already_bound' });
  }

  state = { ...state, pendingAccessKey: accessKey, remoteAccess: 'suspended' };
  await atomicJson(join(home, 'state.json'), state);

  notifyObserver(onProgress, '正在释放当前设备绑定…');
  const localStop = serviceAction('remove', state, home, COMPONENTS);
  const remoteRelease = state.keyId && state.bindingId
    ? control(state.gateway, '/v1/device/release', state.deviceSecret, {
      body: { keyId: state.keyId, bindingId: state.bindingId }, timeout: 30000,
    }).catch(error => {
      // A previously completed release no longer has a device identity to authenticate with.
      if (error.status === 403) return { released: true, alreadyReleased: true };
      throw error;
    })
    : Promise.resolve({ released: true, alreadyReleased: true });
  const [localResult, remoteResult] = await Promise.allSettled([localStop, remoteRelease]);
  if (remoteResult.status === 'rejected') {
    throw new Error(`旧设备绑定尚未释放：${remoteResult.reason?.message ?? remoteResult.reason}`);
  }
  if (localResult.status === 'rejected') {
    throw new Error(`旧连接已禁用，但本机服务尚未完全停止：${localResult.reason?.message ?? localResult.reason}`);
  }

  await rm(join(home, 'tunnel.token'), { force: true });
  const next = { ...state, accessKey, remoteAccess: preservePause ? 'suspended' : 'active' };
  delete next.pendingAccessKey;
  delete next.keyId;
  delete next.bindingId;
  delete next.hostname;
  delete next.endpoint;
  await atomicJson(join(home, 'state.json'), next);

  notifyObserver(onProgress, '正在使用新的 Access Key 重新绑定…');
  return { ...await configureFromDesktop(home, { onProgress, startup }), replacedAccessKey: true };
}

export function repairDevice(home = stateHome(), options = {}) {
  return withDeviceOperation(home, () => repairDeviceUnlocked(home, options));
}

async function repairDeviceUnlocked(home = stateHome(), { preserveTray = false, onProgress = () => {} } = {}) {
  const previous = await readJson(join(home, 'state.json'), null);
  if (!previous) throw new Error('Team DevSpace is installed but has not been configured yet; run setup with the administrator-issued Access Key and project directory');
  if (previous.pendingAccessKey) {
    notifyObserver(onProgress, '正在继续未完成的 Access Key 设置…');
    const replaced = await replaceAccessKey(previous.pendingAccessKey, home, { onProgress });
    return { ...replaced, repaired: true, recoveredEnrollment: true };
  }
  const recoveredEnrollment = !previous.bindingId || !await hasTunnelCredential(home);
  if (recoveredEnrollment) {
    notifyObserver(onProgress, '正在恢复设备绑定…');
    await configureDevice({}, { home, startup: false, onProgress });
  }
  const state = await loadState(home);
  const scope = preserveTray ? COMPONENTS : undefined;
  notifyObserver(onProgress, '正在重建本机连接服务…');
  await serviceAction('remove', state, home, scope);
  await writeUpstreamConfig(state, home);
  await installServices(state, home, undefined, scope);
  const startComponents = enabledStartupComponents(state).filter(component => !preserveTray || component !== 'tray');
  if (startComponents.length) {
    notifyObserver(onProgress, '正在启动本机连接…');
    await serviceAction('start', state, home, startComponents);
  }
  return { repaired: true, enrolled: true, recoveredEnrollment,
    connection: state.remoteAccess === 'suspended' ? 'suspended' : 'starting',
    deviceId: state.deviceId, bindingId: state.bindingId, startup: 'installed' };
}

export async function deviceStatus(home = stateHome(), { gatewayStatus = readGatewayStatus, forceGateway = false } = {}) {
  const state = await loadState(home);
  const local = async (port, path, headers = {}) => {
    try { return (await loopbackRequest(port, path, { headers, timeout: 3000 })).status === 200; }
    catch { return false; }
  };
  const [devspace, bridge, tunnel, remote, currentProjectRootAvailable] = await Promise.all([
    local(state.ports.devspace, '/healthz'),
    local(state.ports.bridge, '/healthz', { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId }),
    local(state.ports.metrics, '/ready'),
    gatewayStatus(state, { force: forceGateway }),
    projectRootAvailable(state.currentProjectRoot),
  ]);
  const gateway = remote.state;
  const desiredRemoteAccess = state.remoteAccess === 'suspended' ? 'suspended' : 'active';
  const remoteAccess = !state.bindingId ? 'not-enrolled'
    : ['active', 'suspended'].includes(gateway) ? gateway : desiredRemoteAccess;
  return { deviceId: state.deviceId, devspaceVersion: DEVSPACE_VERSION, releaseVersion: state.releaseVersion,
    devspace, bridge, tunnel, gateway, gatewayCheckedAt: remote.checkedAt,
    endpoint: `${state.gateway}/mcp`, currentProjectRoot: state.currentProjectRoot,
    currentProjectRootAvailable, localReady: devspace && bridge && tunnel, desiredRemoteAccess, remoteAccess,
    enrollmentPending: !state.bindingId || Boolean(state.pendingAccessKey),
    ready: Boolean(state.bindingId) && currentProjectRootAvailable && devspace && bridge && tunnel &&
      gateway === 'active' && desiredRemoteAccess === 'active' };
}

export async function desktopLocalState(home = stateHome()) {
  const previous = await readJson(join(home, 'state.json'), null);
  return { configured: Boolean(previous), accessKeyMode: previous?.bindingId || previous?.pendingAccessKey ? 'replace-key' : 'setup',
    currentProjectRoot: projectRootFromState(previous) };
}

export async function macSetupDialog(home = stateHome(), { preserveTray = false, signal } = {}) {
  if (process.platform !== 'darwin') throw new Error('The macOS setup dialog is only available on macOS');
  const previous = await readJson(join(home, 'state.json'), null);
  if (previous?.pendingAccessKey) return macReplaceAccessKey(home, { signal });
  if (previous?.bindingId) return preserveTray
    ? configureFromDesktop(home, { startup: true })
    : configureDevice({}, { home });
  return runMacForm({ home, mode: 'setup', projectRoot: projectRootFromState(previous), signal,
    submit: async (input, onProgress) => {
      try {
        // The UI owns no state or network logic. Existing operations still own
        // validation, enrollment, pause preservation and startup transactions.
        if (preserveTray) return await configureFromDesktop(home, { input, onProgress, startup: true });
        return await configureDevice(input, { home, onProgress });
      } catch (error) {
        const pending = await readJson(join(home, 'state.json'), null);
        if (!preserveTray && pending && !pending.bindingId) {
          try {
            await installServices(pending, home, undefined, ['tray']);
            await serviceAction('start', pending, home, ['tray']);
          } catch {}
        }
        // The same form remains visible for correction/retry. Closing it is
        // cancellation, not an installer failure; pending state is retained.
        throw error;
      }
    },
  });
}

export function macReplaceAccessKey(home = stateHome(), { signal, onProgress } = {}) {
  return runMacForm({ home, mode: 'replace-key', signal, onProgress,
    submit: ({ accessKey }, progress) => replaceAccessKey(accessKey, home, { onProgress: progress }),
  });
}

export async function requestFromFile(path, remove = false) {
  try {
    const bytes = await readFile(path);
    const data = bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    const value = JSON.parse(data.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid setup request');
    return value;
  } finally { if (remove) await rm(path, { force: true }); }
}
