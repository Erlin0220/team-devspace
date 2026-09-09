import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { approvedRoots, atomicJson, DEVSPACE_VERSION, installRoot, loadState, normalizeGateway, randomSecret,
  readJson, secureStateDirectory, stateHome, writeUpstreamConfig } from './state.mjs';
import { control, loopbackRequest } from './http.mjs';
import { installServices, serviceAction, STARTUP_COMPONENTS } from './platform.mjs';

const exec = promisify(execFile);

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

export async function configureDevice(input, { home = stateHome(), startup = true, onProgress = () => {} } = {}) {
  onProgress('Preparing private device state...');
  await secureStateDirectory(home);
  const release = await readJson(join(installRoot, 'release.config.json'));
  const previous = await readJson(join(home, 'state.json'), null);
  const gateway = normalizeGateway(input.gateway ?? previous?.gateway ?? release.gateway);
  const accessKey = input.accessKey ?? previous?.accessKey;
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(accessKey ?? '')) throw new Error('Enter the Access Key assigned by your administrator');
  if (previous && (previous.gateway !== gateway || previous.accessKey !== accessKey)) {
    throw new Error('This installation already belongs to another Access Key or gateway. Reset the Device Binding with the administrator first; do not overwrite its state.');
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
  onProgress('Contacting the Team Gateway and confirming Enrollment...');
  const binding = await control(gateway, '/v1/enroll', accessKey, {
    body: { deviceId: state.deviceId, deviceSecret: state.deviceSecret, bridgePort: state.ports.bridge },
  });
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (binding.deviceId !== state.deviceId || !uuid.test(binding.bindingId ?? '') || !uuid.test(binding.keyId ?? '') ||
      typeof binding.tunnelToken !== 'string' || !binding.tunnelToken || binding.endpoint !== `${gateway}/mcp` ||
      binding.devspaceVersion !== DEVSPACE_VERSION) throw new Error('Gateway returned an incompatible Enrollment');
  onProgress('Enrollment confirmed. Preparing the local runtime...');
  if (previous?.bindingId && startup) await serviceAction('stop', previous, home);
  state = { ...state, keyId: binding.keyId, bindingId: binding.bindingId, hostname: binding.hostname,
    endpoint: binding.endpoint, releaseVersion: release.version, devspaceVersion: DEVSPACE_VERSION,
    remoteAccess: binding.state === 'suspended' ? 'suspended' : 'active' };
  const temporary = join(home, `tunnel.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, binding.tunnelToken, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(home, 'tunnel.token'));
  } finally { await rm(temporary, { force: true }); }
  await writeUpstreamConfig(state, home);
  await atomicJson(join(home, 'state.json'), state);
  if (startup) {
    onProgress('Installing current-user login startup entries...');
    await installServices(state, home);
    const startComponents = state.remoteAccess === 'suspended'
      ? STARTUP_COMPONENTS.filter(component => component === 'tray') : STARTUP_COMPONENTS;
    if (startComponents.length) await serviceAction('start', state, home, startComponents);
    if (state.remoteAccess === 'suspended') {
      onProgress('Upgrade complete. Remote access remains safely suspended.');
      return { enrolled: true, ready: false, remoteAccess: 'suspended', deviceId: state.deviceId,
        bindingId: state.bindingId, endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION,
        roots: state.roots, startup: 'installed' };
    }
    onProgress('Starting Team DevSpace and waiting for connection health...');
    let health;
    let lastProgress = 0;
    const deadline = Date.now() + 60000;
    do {
      health = await deviceStatus(home);
      if (health.ready) break;
      if (health.gateway === 'disabled') throw new Error('This Device Binding was disabled during startup');
      if (Date.now() - lastProgress >= 5000) {
        onProgress(`Still starting: DevSpace=${health.devspace}, Bridge=${health.bridge}, Tunnel=${health.tunnel}, Gateway=${health.gateway}`);
        lastProgress = Date.now();
      }
      await sleep(1000);
    } while (Date.now() < deadline);
    if (!health.ready) throw new Error(`Enrollment is saved, but runtime is not ready (DevSpace=${health.devspace}, Bridge=${health.bridge}, Tunnel=${health.tunnel}, Gateway=${health.gateway}). Use status and repair; do not reconnect with a different key.`);
    onProgress('Runtime, Tunnel and Gateway are ready.');
  }
  return { enrolled: true, ready: startup, remoteAccess: state.remoteAccess, deviceId: state.deviceId, bindingId: state.bindingId,
    endpoint: state.endpoint, devspaceVersion: DEVSPACE_VERSION, roots: state.roots,
    startup: startup ? 'installed' : 'not-installed' };
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
  return { deviceId: state.deviceId, devspaceVersion: DEVSPACE_VERSION, releaseVersion: state.releaseVersion,
    devspace, bridge, tunnel, gateway, endpoint: `${state.gateway}/mcp`, roots: state.roots,
    localReady: devspace && bridge && tunnel, remoteAccess: gateway === 'suspended' ? 'suspended' : 'active',
    ready: devspace && bridge && tunnel && gateway === 'active' };
}

export async function macSetupDialog(home = stateHome()) {
  if (process.platform !== 'darwin') throw new Error('The macOS setup dialog is only available on macOS');
  const previous = await readJson(join(home, 'state.json'), null);
  if (previous?.accessKey) return configureDevice({}, { home });
  // AppleScript supplies native protected input and a folder picker; no web UI or Electron shell.
  const key = await exec('/usr/bin/osascript', ['-e',
    'text returned of (display dialog "Enter your administrator-issued Team DevSpace Access Key. This key grants remote coding access as your user account." default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue" with title "Team DevSpace")']);
  const folder = await exec('/usr/bin/osascript', ['-e',
    'POSIX path of (choose folder with prompt "Choose your project directory. File tools are restricted to it; shell commands still run with your user permissions.")']);
  return configureDevice({ accessKey: key.stdout.trim(), roots: [folder.stdout.trim()] }, { home });
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
