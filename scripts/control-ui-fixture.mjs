import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { startLocalControl } from '../client/local-control.mjs';

// Production UI + controller, with isolated connection operations. No live keys,
// startup entries, Gateway writes or installed services are used by this fixture.
const marker = resolve('build/control-ui-fixture.json');
const command = process.argv[2] ?? 'start';
if (command === 'stop') {
  const info = JSON.parse(await readFile(marker, 'utf8')), url = new URL(info.url);
  const response = await fetch(`${url.origin}/api/diagnostics`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(2000) });
  if (!response.ok || (await response.json()).fixtureNonce !== info.nonce) throw new Error('Refused to stop an unrelated process');
  process.kill(info.pid); await rm(marker, { force: true }); console.log(JSON.stringify({ stopped: true }));
} else if (['start', 'serve'].includes(command)) {
  // This is a finite foreground fixture. Persistent Windows previews must be
  // launched by the OS-managed preview workflow, never detached from this shell.
  await mkdir(dirname(marker), { recursive: true });
  let configured = process.env.TEAM_DEVSPACE_UI_FIXTURE_CONFIGURED === '1';
  let root = configured ? 'C:\\fixture\\project-a' : undefined, desired = 'active';
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
  const updateCheck = async () => {
    calls['update-check'] = (calls['update-check'] ?? 0) + 1;
    if (calls['update-check'] > 1) return { available: false, required: false, checkedAt: new Date().toISOString(),
      automatic: true, policy: { stable: '0.2.5', auto: null, minimumSupported: null, enforceAfter: null } };
    return { available: true, required: false, checkedAt: new Date().toISOString(), automatic: true,
      policy: { stable: '0.2.6', auto: null, minimumSupported: null, enforceAfter: null },
      releaseNotes: { version: '0.2.6', summary: ['修复安装期间的自动重连', '保留设备身份、项目目录和暂停意图'],
        url: 'https://downloads.example.com/releases/0.2.6/release-notes.txt' } };
  };
  const controller = createDesktopController('unused', { refreshInterval: 500, operations: {
    status: async () => health(), localState: async () => ({ configured, accessKeyMode: configured ? 'replace-key' : 'setup', currentProjectRoot: root }),
    ...Object.fromEntries(['setup', 'switch-key', 'project-root', 'suspend', 'resume', 'restart', 'repair', 'logs'].map(name => [name, operation(name)])),
    'choose-folder': async () => {
      calls.picker = (calls.picker ?? 0) + 1;
      return calls.picker === 1 ? 'C:\\fixture\\project-selected' : calls.picker === 2 ? 'C:\\fixture\\project-picked' : null;
    },
    diagnostics: async () => ({ fixtureNonce: nonce, liveDevice: false, calls }),
    'update-check': updateCheck,
    'release-notes': async ({ version }) => ({ version,
      summary: ['修复安装期间的自动重连', '保留设备身份、项目目录和暂停意图'],
      url: `https://downloads.example.com/releases/${version}/release-notes.txt` }),
    'update-apply': async ({ confirmedVersion }) => {
      calls['update-apply'] = (calls['update-apply'] ?? 0) + 1;
      if (confirmedVersion !== '0.2.6') throw new Error('测试确认版本不匹配');
      return { cancelled: true, version: confirmedVersion };
    },
    'update-auto': async () => ({}),
  } });
  controller.start();
  const ui = await startLocalControl(controller, { openBrowser: async () => {}, home: resolve('build/control-ui-fixture-state'),
    port: Number(process.env.TEAM_DEVSPACE_CONTROL_TEST_PORT ?? 0) });
  await writeFile(marker, JSON.stringify({ url: ui.url, pid: process.pid, nonce }), { mode: 0o600 });
  const info = { url: ui.url, pid: process.pid, nonce };
  console.log(JSON.stringify(info));
  setTimeout(async () => { await ui.close(); await controller.dispose(); process.exit(0); }, 20 * 60 * 1000);
} else throw new Error('Use start or stop');
