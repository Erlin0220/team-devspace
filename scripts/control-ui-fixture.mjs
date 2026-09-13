import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { startLocalControl } from '../client/local-control.mjs';

// Production UI + controller, with isolated connection operations. No live keys,
// startup entries, Gateway writes or installed services are used by this fixture.
const marker = resolve('build/control-ui-fixture.json');
const command = process.argv[2] ?? 'start';
if (command === 'start') {
  await mkdir(dirname(marker), { recursive: true });
  try {
    const old = JSON.parse(await readFile(marker, 'utf8')), url = new URL(old.url);
    const result = await fetch(`${url.origin}/api/diagnostics`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(1000) });
    if ((await result.json()).fixtureNonce === old.nonce) { console.log(JSON.stringify({ url: old.url, reused: true })); process.exit(0); }
  } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'],
    { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const info = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Control UI fixture did not start')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
    child.once('message', value => { clearTimeout(timer); resolveReady(value); });
  });
  child.disconnect(); child.unref(); console.log(JSON.stringify(info));
} else if (command === 'stop') {
  const info = JSON.parse(await readFile(marker, 'utf8')), url = new URL(info.url);
  const response = await fetch(`${url.origin}/api/diagnostics`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(2000) });
  if (!response.ok || (await response.json()).fixtureNonce !== info.nonce) throw new Error('Refused to stop an unrelated process');
  process.kill(info.pid); await rm(marker, { force: true }); console.log(JSON.stringify({ stopped: true }));
} else if (command === 'serve') {
  let configured = false, root, desired = 'active';
  const nonce = randomUUID(), calls = {};
  const health = () => configured ? { ready: desired === 'active', devspace: desired === 'active',
    bridge: desired === 'active', tunnel: desired === 'active', gateway: desired,
    remoteAccess: desired, desiredRemoteAccess: desired, currentProjectRoot: root, currentProjectRootAvailable: true } : null;
  const operation = name => async ({ accessKey, projectRoot, onProgress } = {}) => {
    calls[name] = (calls[name] ?? 0) + 1; onProgress?.('正在处理本机设置…');
    // Keep first-run pending across a real browser polling cycle so the smoke
    // detects regressions that hide controller progress during a submission.
    await delay(name === 'setup' ? 2500 : 450);
    if (name === 'switch-key' && accessKey === `tds_${'b'.repeat(43)}`) throw new Error(`测试绑定失败 ${accessKey}`);
    if (name === 'setup') { configured = true; root = projectRoot; }
    if (name === 'project-root') root = projectRoot;
    if (name === 'suspend') desired = 'suspended';
    if (name === 'resume') desired = 'active';
    return health();
  };
  const controller = createDesktopController('unused', { refreshInterval: 500, operations: {
    status: async () => health(), localState: async () => ({ configured, accessKeyMode: configured ? 'replace-key' : 'setup', currentProjectRoot: root }),
    ...Object.fromEntries(['setup', 'switch-key', 'project-root', 'suspend', 'resume', 'restart', 'repair', 'logs'].map(name => [name, operation(name)])),
    'choose-folder': async () => 'C:\\fixture\\project-selected',
    diagnostics: async () => ({ fixtureNonce: nonce, liveDevice: false, calls }),
  } });
  controller.start();
  const ui = await startLocalControl(controller, { openBrowser: async () => {} });
  await writeFile(marker, JSON.stringify({ url: ui.url, pid: process.pid, nonce }), { mode: 0o600 });
  process.send?.({ url: ui.url });
  setTimeout(async () => { await ui.close(); await controller.dispose(); process.exit(0); }, 20 * 60 * 1000);
} else throw new Error('Use start or stop');
