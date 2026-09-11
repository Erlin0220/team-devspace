import { randomUUID } from 'node:crypto';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { approvedRoots, atomicJson, atomicText, DEVSPACE_VERSION, installRoot, loadState, normalizeGateway, randomSecret,
  readJson, secureStateDirectory, stateHome, writeUpstreamConfig } from './state.mjs';
import { control, loopbackRequest } from './http.mjs';
import { COMPONENTS, enabledStartupComponents, installServices, serviceAction } from './platform.mjs';

import { runWindowsDesktop } from './windows-desktop.mjs';
import { withDeviceOperation } from './operation.mjs';
import { runMacForm } from './macos-ui.mjs';

async function hasTunnelCredential(home) {
  try { return Boolean((await readFile(join(home, 'tunnel.token'), 'utf8')).trim()); }
  catch { return false; }
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
  onProgress('Preparing private device state...');
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
  const roots = await approvedRoots(input.roots ?? previous?.roots);
  let state = previous ? await loadState(home) : {
    schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
    ports: { devspace: await availablePort(47670), bridge: await availablePort(47770), metrics: await availablePort(47870) },
  };
  state = { ...state, gateway, accessKey, roots };
  // Publish the first identity without replacement. Concurrent installers must share one binding.
  const published = await atomicJson(join(home, 'state.json'), state, { createOnly: !previous });
  if (!published) {
    state = await loadState(home);
    if (state.gateway !== gateway || state.accessKey !== accessKey) throw new Error('Another setup already enrolled this installation with different credentials');
  }
  if (previous?.bindingId && previous?.keyId && previous?.hostname && await hasTunnelCredential(home)) {
    onProgress('Existing Enrollment found. Reusing the current Device Binding...');
    const remoteAccess = previous.remoteAccess === 'suspended' ? 'suspended' : 'active';
    state = { ...state, keyId: previous.keyId, bindingId: previous.bindingId, hostname: previous.hostname,
      endpoint: previous.endpoint ?? `${gateway}/mcp`, releaseVersion: release.version, devspaceVersion: DEVSPACE_VERSION,
      remoteAccess };
    await writeUpstreamConfig(state, home);
    await atomicJson(join(home, 'state.json'), state);
    if (startup) {
      await serviceAction('stop', previous, home);
      onProgress('Refreshing current-user login startup entries...');
      await installServices(state, home);
      const startComponents = enabledStartupComponents(state);
      if (startComponents.length) await serviceAction('start', state, home, startComponents);
    }
    return { enrolled: true, reusedEnrollment: true, ready: false, connection: startup ? 'starting' : 'not-started',
      remoteAccess: state.remoteAccess, deviceId: state.deviceId, bindingId: state.bindingId,
      endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION, roots: state.roots,
      startup: startup ? 'installed' : 'not-installed' };
  }

  onProgress('Contacting the Team Gateway and confirming Enrollment...');
  const binding = await control(gateway, '/v1/enroll', accessKey, {
    body: { deviceId: state.deviceId, deviceSecret: state.deviceSecret, bridgePort: state.ports.bridge },
  });
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (binding.deviceId !== state.deviceId || !uuid.test(binding.bindingId ?? '') || !uuid.test(binding.keyId ?? '') ||
      typeof binding.tunnelToken !== 'string' || !binding.tunnelToken || binding.endpoint !== `${gateway}/mcp` ||
      binding.devspaceVersion !== DEVSPACE_VERSION || binding.controlApiVersion !== release.controlApiVersion) {
    throw new Error('Gateway returned an incompatible Enrollment');
  }
  onProgress('Enrollment confirmed. Preparing the local runtime...');
  state = { ...state, keyId: binding.keyId, bindingId: binding.bindingId, hostname: binding.hostname,
    endpoint: binding.endpoint, releaseVersion: release.version, devspaceVersion: DEVSPACE_VERSION,
    // Recovering credentials is not consent to resume. Only the explicit resume
    // operation may release a locally persisted pause.
    remoteAccess: state.remoteAccess === 'suspended' || binding.state === 'suspended' ? 'suspended' : 'active' };
  await atomicText(join(home, 'tunnel.token'), binding.tunnelToken);
  await writeUpstreamConfig(state, home);
  await atomicJson(join(home, 'state.json'), state);
  if (startup) {
    onProgress('Installing current-user login startup entries...');
    await installServices(state, home);
    const startComponents = enabledStartupComponents(state);
    if (startComponents.length) await serviceAction('start', state, home, startComponents);
    onProgress(state.remoteAccess === 'suspended'
      ? 'Enrollment is complete. Remote access remains safely suspended.'
      : 'Enrollment is complete. Team DevSpace is connecting in the background.');
  }
  return { enrolled: true, ready: false, connection: startup ? 'starting' : 'not-started',
    remoteAccess: state.remoteAccess, deviceId: state.deviceId, bindingId: state.bindingId,
    endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION, roots: state.roots,
    startup: startup ? 'installed' : 'not-installed' };
}

export async function promptReplacementAccessKey({ signal } = {}) {
  if (process.platform === 'win32') {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KeyDialogWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$form = New-Object System.Windows.Forms.Form
$form.Text = '更换 Access Key'
$form.Width = 520
$form.Height = 230
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Left = 20; $label.Top = 20; $label.Width = 460; $label.Text = '新的 Access Key'
$keyInput = New-Object System.Windows.Forms.TextBox
$keyInput.Left = 20; $keyInput.Top = 45; $keyInput.Width = 460; $keyInput.UseSystemPasswordChar = $true
$hint = New-Object System.Windows.Forms.Label
$hint.Left = 20; $hint.Top = 78; $hint.Width = 460; $hint.Height = 42
$hint.Text = '更换后，当前远程连接会断开，并使用新的 Access Key 重新绑定此电脑。项目目录设置不会改变。'
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'; $cancel.Left = 310; $cancel.Top = 135; $cancel.Width = 80; $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$ok = New-Object System.Windows.Forms.Button
$ok.Text = '更换'; $ok.Left = 400; $ok.Top = 135; $ok.Width = 80; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.AddRange(@($label, $keyInput, $hint, $cancel, $ok))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Add_Shown({ [void][KeyDialogWindow]::ShowWindow($form.Handle, 5); [void][KeyDialogWindow]::SetForegroundWindow($form.Handle); $form.Activate(); [void]$keyInput.Focus() })
try {
  $result = $form.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($keyInput.Text) }
} finally { $form.Dispose() }
`;
    try {
      return (await runWindowsDesktop(script, { signal, timeout: 300000 })).trim() || null;
    } catch (error) { if (error.name === 'AbortError') return null; throw error; }
  }
  throw new Error('Use the native macOS form for Access Key replacement');
}

async function enrollWithoutReplacingTray(home, { onProgress, startup, input = {} }) {
  const enrolled = await configureDevice(input, { home, startup: false, onProgress });
  if (!startup) return { ...enrolled, startup: 'not-installed' };
  const state = await loadState(home);
  await installServices(state, home, undefined, COMPONENTS);
  const startComponents = enabledStartupComponents(state).filter(component => COMPONENTS.includes(component));
  if (startComponents.length) await serviceAction('start', state, home, startComponents);
  return { ...enrolled, startup: 'installed' };
}

export function replaceAccessKey(accessKey, home = stateHome(), options = {}) {
  return withDeviceOperation(home, () => replaceAccessKeyUnlocked(accessKey, home, options));
}

async function replaceAccessKeyUnlocked(accessKey, home = stateHome(), { onProgress = () => {}, startup = true } = {}) {
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(accessKey ?? '')) throw new Error('请输入完整的 Access Key');
  let state = await loadState(home);
  if (!state.pendingAccessKey && state.accessKey === accessKey) {
    if (state.bindingId) throw new Error('新的 Access Key 与当前 Access Key 相同');
    // Enrollment may have committed remotely before its response was lost.
    // Retry with the retained identity, not a preflight that rejects bound keys.
    onProgress('正在继续未完成的设备绑定…');
    return { ...await enrollWithoutReplacingTray(home, { onProgress, startup }), recoveredEnrollment: true };
  }

  onProgress('正在验证新的 Access Key…');
  const preflight = await control(state.gateway, '/v1/enrollment/preflight', accessKey, { body: {}, timeout: 15000 })
    .catch(error => {
      if (error.status === 404) throw Object.assign(new Error('网关尚未部署更换 Access Key 所需接口，请先更新网关；当前 Key 和连接未更改'), { code: 'gateway_update_required' });
      throw error;
    });
  if (!preflight.available) throw new Error('这个 Access Key 已绑定到其他设备，请使用未绑定的 Access Key');

  state = { ...state, pendingAccessKey: accessKey, remoteAccess: 'suspended' };
  await atomicJson(join(home, 'state.json'), state);

  onProgress('正在释放当前设备绑定…');
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
  const next = { ...state, accessKey, remoteAccess: 'active' };
  delete next.pendingAccessKey;
  delete next.keyId;
  delete next.bindingId;
  delete next.hostname;
  delete next.endpoint;
  await atomicJson(join(home, 'state.json'), next);

  onProgress('正在使用新的 Access Key 重新绑定…');
  return { ...await enrollWithoutReplacingTray(home, { onProgress, startup }), replacedAccessKey: true };
}

export function repairDevice(home = stateHome(), options = {}) {
  return withDeviceOperation(home, () => repairDeviceUnlocked(home, options));
}

async function repairDeviceUnlocked(home = stateHome(), { preserveTray = false } = {}) {
  const previous = await readJson(join(home, 'state.json'), null);
  if (!previous) throw new Error('Team DevSpace is installed but has not been configured yet; run setup with the administrator-issued Access Key and project directory');
  if (previous.pendingAccessKey) {
    const replaced = await replaceAccessKey(previous.pendingAccessKey, home);
    return { ...replaced, repaired: true, recoveredEnrollment: true };
  }
  const recoveredEnrollment = !previous.bindingId || !await hasTunnelCredential(home);
  if (recoveredEnrollment) await configureDevice({}, { home, startup: false });
  const state = await loadState(home);
  const scope = preserveTray ? COMPONENTS : undefined;
  await serviceAction('remove', state, home, scope);
  await writeUpstreamConfig(state, home);
  await installServices(state, home, undefined, scope);
  const startComponents = enabledStartupComponents(state).filter(component => !preserveTray || component !== 'tray');
  if (startComponents.length) await serviceAction('start', state, home, startComponents);
  return { repaired: true, enrolled: true, recoveredEnrollment,
    connection: state.remoteAccess === 'suspended' ? 'suspended' : 'starting',
    deviceId: state.deviceId, bindingId: state.bindingId, startup: 'installed' };
}

export async function deviceStatus(home = stateHome()) {
  const state = await loadState(home);
  const local = async (port, path, headers = {}) => {
    try { return (await loopbackRequest(port, path, { headers, timeout: 3000 })).status === 200; }
    catch { return false; }
  };
  const [devspace, bridge, tunnel, gateway] = await Promise.all([
    local(state.ports.devspace, '/healthz'),
    local(state.ports.bridge, '/healthz', { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId }),
    local(state.ports.metrics, '/ready'),
    state.bindingId ? control(state.gateway, '/v1/device/status', state.deviceSecret, {
      body: { keyId: state.keyId, bindingId: state.bindingId }, timeout: 5000,
    }).then(result => ['active', 'suspended'].includes(result.state) && result.bindingId === state.bindingId
      ? result.state : 'invalid-response',
      error => error.status === 403 ? 'disabled' : 'unreachable') : Promise.resolve('not-enrolled'),
  ]);
  const desiredRemoteAccess = state.remoteAccess === 'suspended' ? 'suspended' : 'active';
  const remoteAccess = !state.bindingId ? 'not-enrolled'
    : ['active', 'suspended'].includes(gateway) ? gateway : desiredRemoteAccess;
  return { deviceId: state.deviceId, devspaceVersion: DEVSPACE_VERSION, releaseVersion: state.releaseVersion,
    devspace, bridge, tunnel, gateway, endpoint: `${state.gateway}/mcp`, roots: state.roots,
    localReady: devspace && bridge && tunnel, desiredRemoteAccess, remoteAccess,
    enrollmentPending: !state.bindingId || Boolean(state.pendingAccessKey),
    ready: Boolean(state.bindingId) && devspace && bridge && tunnel && gateway === 'active' && desiredRemoteAccess === 'active' };
}

export async function macSetupDialog(home = stateHome(), { preserveTray = false, signal } = {}) {
  if (process.platform !== 'darwin') throw new Error('The macOS setup dialog is only available on macOS');
  const previous = await readJson(join(home, 'state.json'), null);
  if (previous?.pendingAccessKey) return macReplaceAccessKey(home, { signal });
  if (previous?.bindingId) return preserveTray
    ? enrollWithoutReplacingTray(home, { startup: true })
    : configureDevice({}, { home });
  return runMacForm({ home, mode: 'setup', roots: previous?.roots ?? [], signal,
    submit: async (input, onProgress) => {
      try {
        // The UI owns no state or network logic. Existing operations still own
        // validation, enrollment, pause preservation and startup transactions.
        if (preserveTray) return await enrollWithoutReplacingTray(home, { input, onProgress, startup: true });
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
