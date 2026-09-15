import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactDiagnostic } from '../client/control.mjs';
import { launchAgentXml, serviceLabel, windowsTaskXml } from '../client/platform.mjs';
import { runTray, trayInstanceId, trayState } from '../client/tray.mjs';
import { findMenuAction } from '../client/desktop-state.mjs';

const healthy = { ready: true, devspace: true, bridge: true, tunnel: true, gateway: 'active',
  remoteAccess: 'active', desiredRemoteAccess: 'active', currentProjectRoot: join(homedir(), 'project-a'), currentProjectRootAvailable: true };
const stopped = { ...healthy, ready: false, devspace: false, bridge: false, tunnel: false };

test('tray ownership is stable per state directory and independent of key changes', async () => {
  const home = join(homedir(), 'team-devspace-instance-test');
  const identity = await trayInstanceId(home);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(await trayInstanceId(join(home, '..', 'team-devspace-instance-test')), identity);
  assert.notEqual(await trayInstanceId(`${home}-isolated`), identity);
  if (process.platform === 'win32') assert.equal(await trayInstanceId(home.toUpperCase()), identity);
});

test('shared presentation distinguishes intent, observed health and partial pause failures', () => {
  for (const [status, visual, summary, action] of [
    [healthy, 'ready', '已连接', 'suspend'],
    [{ ...healthy, ready: false, bridge: false }, 'partial', '本机服务异常', 'suspend'],
    [stopped, 'stopped', '本机服务已停止', 'suspend'],
    [{ ...stopped, gateway: 'suspended', remoteAccess: 'suspended', desiredRemoteAccess: 'suspended' }, 'suspended', '远程访问已暂停', 'resume'],
    [{ ...healthy, ready: false, gateway: 'unreachable', desiredRemoteAccess: 'suspended' }, 'partial', '暂停未完成', 'suspend'],
    [{ ...stopped, gateway: 'unreachable', desiredRemoteAccess: 'suspended' }, 'suspended', '本机已暂停，服务端状态未知', 'suspend'],
    [{ ...stopped, desiredRemoteAccess: 'suspended' }, 'suspended', '本机已暂停，服务端待确认', 'suspend'],
    [{ ...healthy, ready: false, gateway: 'suspended' }, 'suspended', '服务端仍处于暂停状态', 'resume'],
    [{ ...healthy, ready: false, currentProjectRootAvailable: false }, 'partial', '项目目录不可用', 'suspend'],
    [{ ...healthy, ready: false, gateway: 'disabled' }, 'partial', '授权已失效', 'suspend'],
    [{ ...stopped, remoteAccess: 'not-enrolled', gateway: 'not-enrolled' }, 'stopped', '未完成 Enrollment', 'suspend'],
  ]) {
    const view = trayState(status);
    assert.equal(view.status, visual); assert.equal(view.summary, `Team DevSpace ${summary}`); assert.equal(view.remoteAction, action);
    if (visual === 'suspended') assert.equal(view.restartEnabled, false);
  }
  const pending = trayState({ ...stopped, desiredRemoteAccess: 'suspended' });
  assert.equal(pending.remoteText, '重试暂停远程访问');
  const disabled = trayState({ ...healthy, gateway: 'disabled' });
  assert.equal(disabled.remoteEnabled, false); assert.equal(disabled.switchKeyEnabled, true);
  assert.equal(trayState({ ...stopped, enrollmentPending: true, remoteAccess: 'not-enrolled' }).repairEnabled, true);
  const busy = trayState(healthy, { busy: true, activity: '处理中' });
  assert.equal(busy.summary, 'Team DevSpace 已连接'); assert.equal(busy.remoteEnabled, false);
  assert.equal(busy.checkEnabled, false); assert.equal(busy.switchKeyEnabled, false); assert.equal(busy.exitEnabled, true);
  assert.equal(busy.menu.find(item => item.id === 'settings').enabled, true);
  assert.equal(trayState(null, { accessKeyMode: 'replace-key' }).switchKeyText, '更换 Access Key…');
  const recovery = trayState({ ...stopped, remoteAccess: 'not-enrolled', gateway: 'not-enrolled', enrollmentPending: true }, { accessKeyMode: 'replace-key' });
  assert.equal(recovery.accessKeyMode, 'replace-key');
  assert.equal(recovery.remoteEnabled, false);
  assert.equal(recovery.repairEnabled, true);
  const notice = trayState(healthy, { notice: '旧操作已完成' });
  assert.equal(notice.menu[0].text, 'Team DevSpace 已连接');
  assert.equal(notice.iconStatus, 'ready');
});

test('the shared native menu contains only status, common actions and Control Center entry', () => {
  const view = trayState(healthy);
  assert.deepEqual(view.menu.filter(item => item.action).map(item => item.action), ['suspend', 'settings', 'updates', 'about', 'exit']);
  const diagnostics = view.menu.find(item => item.id === 'troubleshoot');
  assert.deepEqual(diagnostics.children.filter(item => item.action).map(item => item.action),
    ['check', 'restart', 'repair', 'logs', 'troubleshoot']);
  assert.equal(findMenuAction(view.menu, 'repair').id, 'repair');
  diagnostics.enabled = false;
  assert.equal(findMenuAction(view.menu, 'repair'), undefined, 'Disabled parents cannot dispatch child actions');
  const paused = trayState({ ...stopped, gateway: 'suspended', desiredRemoteAccess: 'suspended' });
  assert.equal(findMenuAction(paused.menu, 'restart'), undefined);
  assert.equal(findMenuAction(paused.menu, 'repair'), undefined);
  assert.ok(findMenuAction(paused.menu, 'logs'));
  assert.equal(view.menu.find(item => item.id === 'project').text, '项目：project-a');
  assert.equal(view.menu.find(item => item.id === 'exit').text, '退出 Team DevSpace');
  assert.match(view.tooltip, /已连接.*project-a/);
  assert.ok(!view.menu.some(item => ['restart', 'logs'].includes(item.action)));
  assert.ok(view.menu.find(item => item.id === 'device').text.startsWith('此设备：'));
  assert.ok(!view.menu.some(item => ['switch-key', 'project-root', 'repair'].includes(item.action)));
});

test('native adapter coalesces opening settings, ignores removed actions and stops only on explicit exit', { timeout: 5000 }, async () => {
  const calls = [];
  const fake = `
    console.log(JSON.stringify({event:'ready'}));
    let first=true;
    process.stdin.on('data',()=>{if(!first)return;first=false;
      for(const action of ['settings','settings','switch-key','logs'])console.log(JSON.stringify({event:'menu',action}));
      setTimeout(()=>console.log(JSON.stringify({event:'menu',action:'troubleshoot'})),60);
      setTimeout(()=>console.log(JSON.stringify({event:'menu',action:'exit'})),130);
    });
    process.stdin.on('end',()=>process.exit(0));
  `;
  await runTray('unused', { helper: process.execPath, helperArgs: ['--input-type=module', '-e', fake],
    operations: { status: async () => healthy, localState: async () => ({ accessKeyMode: 'replace-key' }),
      logs: async () => { calls.push('logs'); }, exit: async () => { calls.push('exit'); } },
    startLocalControl: async () => ({ open: async section => { calls.push(section ?? 'settings'); await new Promise(r => setTimeout(r, 30)); },
      close: async () => { calls.push('close'); } }),
  });
  assert.equal(calls.filter(value => value === 'settings').length, 1);
  assert.deepEqual(calls.filter(value => value !== 'settings'), ['logs', 'diagnostics', 'exit', 'close']);
});

test('Control Center failures stay isolated from the native tray and a later menu action can retry', { timeout: 5000 }, async () => {
  const calls = []; let starts = 0;
  const fake = `
    console.log(JSON.stringify({event:'ready'}));
    let sent=false;
    process.stdin.on('data',()=>{if(sent)return;sent=true;
      setTimeout(()=>console.log(JSON.stringify({event:'menu',action:'settings'})),50);
      setTimeout(()=>console.log(JSON.stringify({event:'menu',action:'exit'})),150);
    });
    process.stdin.on('end',()=>process.exit(0));
  `;
  await runTray('unused', { helper: process.execPath, helperArgs: ['--input-type=module', '-e', fake],
    operations: { status: async () => healthy, localState: async () => ({ accessKeyMode: 'replace-key' }),
      exit: async () => { calls.push('exit'); } },
    startLocalControl: async () => {
      starts++; if (starts === 1) throw new Error('synthetic auxiliary WebUI failure');
      return { open: async () => { calls.push('open'); }, close: async () => { calls.push('close'); throw new Error('synthetic close failure'); } };
    },
  });
  assert.equal(starts, 2, 'A menu action retries the auxiliary WebUI after eager startup failed');
  assert.deepEqual(calls, ['open', 'exit', 'close']);
});

test('native startup keeps tray separate from runtime and never embeds credentials', { skip: !['win32', 'darwin'].includes(process.platform) }, () => {
  const state = { deviceId: randomUUID(), deviceSecret: 'secret', ownerToken: 'x'.repeat(43), accessKey: 'tds_secret',
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  const home = join(homedir(), 'TeamDevSpace'), root = join(homedir(), 'TDS');
  const task = windowsTaskXml(state, 'tray', home, 'S-1-5-21-123', root);
  assert.ok(task.includes('InteractiveToken') && task.includes('tds-launcher.exe'));
  assert.ok(task.includes('<Count>10</Count>') && !task.includes('<Count>999</Count>'));
  assert.ok(!task.includes(state.deviceSecret) && !task.includes(state.accessKey));
  const launch = launchAgentXml(state, 'tray', home, { node: '/app/node', cloudflared: '/app/cloudflared' }, root);
  for (const text of ['<key>SuccessfulExit</key><false/>', '<key>LimitLoadToSessionType</key><string>Aqua</string>',
    '<key>ProcessType</key><string>Interactive</string>', '<key>TEAM_DEVSPACE_UI_READY_MARKER</key>']) assert.ok(launch.includes(text));
  assert.ok(!launch.includes('<key>KeepAlive</key><true/>'));
  assert.equal(serviceLabel(state, 'tray', 'darwin'), 'com.teamdevspace.tray');
});

test('macOS tray startup requires actual visibility, not merely process readiness', { timeout: 3000 }, async () => {
  await assert.rejects(runTray('unused', { helper: process.execPath,
    helperArgs: ['-e', "console.log(JSON.stringify({event:'ready'}));process.stdin.resume()"], requireVisible: true,
    startupTimeout: 150, operations: { status: async () => null },
    startLocalControl: async () => ({ open: async () => {}, close: async () => {} }) }), /became visible/);
});

test('diagnostic redaction removes employee and bearer credentials', () => {
  const report = redactDiagnostic('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 tds_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq');
  assert.ok(!report.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(!report.includes('tds_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'));
  assert.ok(report.includes('<REDACTED>'));
});
