import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactDiagnostic } from '../client/control.mjs';
import { launchAgentXml, serviceLabel, windowsTaskXml } from '../client/platform.mjs';
import { runTray, trayState } from '../client/tray.mjs';

test('tray presentation derives menu capabilities from the existing health result', () => {
  const ready = trayState({ ready: true, devspace: true, bridge: true, tunnel: true, remoteAccess: 'active' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.remoteText, '暂停远程访问');
  assert.equal(ready.remoteAction, 'suspend');
  assert.equal(ready.restartEnabled, true);
  assert.equal(ready.repairEnabled, true);

  const partial = trayState({ ready: false, devspace: true, bridge: false, tunnel: true, remoteAccess: 'active' });
  assert.equal(partial.status, 'partial');

  const stopped = trayState({ ready: false, devspace: false, bridge: false, tunnel: false, remoteAccess: 'active' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.restartEnabled, true);

  const suspended = trayState({ ready: false, devspace: false, bridge: false, tunnel: false, remoteAccess: 'suspended' });
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.remoteText, '恢复远程访问');
  assert.equal(suspended.remoteAction, 'resume');
  assert.equal(suspended.restartEnabled, false);
  assert.equal(suspended.repairEnabled, false);

  const unconfirmed = trayState({ ready: false, devspace: false, bridge: false, tunnel: false,
    gateway: 'unreachable', remoteAccess: 'suspended', desiredRemoteAccess: 'suspended' });
  assert.equal(unconfirmed.status, 'stopped');
  assert.equal(unconfirmed.remoteText, '重试暂停远程访问');
  assert.equal(unconfirmed.remoteAction, 'suspend');
  assert.equal(unconfirmed.restartEnabled, false);

  const conflict = trayState({ ready: false, devspace: false, bridge: false, tunnel: false,
    gateway: 'active', remoteAccess: 'active', desiredRemoteAccess: 'suspended' });
  assert.equal(conflict.status, 'stopped');
  assert.equal(conflict.remoteText, '暂停远程访问');
  assert.equal(conflict.restartEnabled, false);

  const gatewaySuspended = trayState({ ready: false, devspace: true, bridge: true, tunnel: true,
    gateway: 'suspended', remoteAccess: 'suspended', desiredRemoteAccess: 'active' });
  assert.equal(gatewaySuspended.remoteAction, 'resume');
  assert.equal(gatewaySuspended.restartEnabled, false);
  assert.equal(gatewaySuspended.repairEnabled, false);

  const missing = trayState(null);
  assert.equal(missing.remoteEnabled, false);
  assert.equal(missing.restartEnabled, false);
  assert.equal(missing.exitEnabled, true);

  const busy = trayState({ ready: true, devspace: true, bridge: true, tunnel: true, remoteAccess: 'active' }, { busy: true });
  assert.equal(busy.remoteEnabled, false);
  assert.equal(busy.checkEnabled, false);
  assert.equal(busy.exitEnabled, false);
});

test('tray controller delegates fixed menu actions and exits only after services stop', async () => {
  const calls = [];
  let remoteAccess = 'active';
  let stopped = false;
  const actions = ['suspend', 'resume', 'restart', 'repair', 'logs', 'diagnostics', 'exit'];
  const fake = `
    const actions=${JSON.stringify(actions)};
    console.log(JSON.stringify({event:'ready'}));
    let index=0;
    const timer=setInterval(()=>{
      const action=actions[index++];
      if(action) console.log(JSON.stringify({event:'menu',action}));
      else clearInterval(timer);
    },30);
    process.stdin.resume();
    process.stdin.on('end',()=>process.exit(0));
  `;
  const status = () => ({ ready: remoteAccess === 'active', devspace: true, bridge: true,
    tunnel: true, gateway: remoteAccess, remoteAccess });
  await runTray('unused', { helper: process.execPath, helperArgs: ['--input-type=module', '-e', fake],
    refreshInterval: 60000, operations: {
      status: async () => status(),
      suspend: async () => { calls.push('suspend'); remoteAccess = 'suspended'; },
      resume: async () => { calls.push('resume'); remoteAccess = 'active'; },
      restart: async () => { calls.push('restart'); },
      repair: async () => { calls.push('repair'); },
      logs: async () => { calls.push('logs'); },
      diagnostics: async () => { calls.push('diagnostics'); },
      exit: async () => { calls.push('exit'); await new Promise(resolve => setTimeout(resolve, 10)); stopped = true; },
    } });
  assert.equal(stopped, true);
  assert.deepEqual(calls, actions);
});

test('failed exit keeps the tray controller alive instead of pretending shutdown succeeded', async () => {
  let exitCalls = 0;
  const fake = `
    console.log(JSON.stringify({event:'ready'}));
    let input=''; let sent=false;
    process.stdin.on('end',()=>process.exit(2));
    process.stdin.on('data',chunk=>{input+=chunk; while(input.includes('\\n')){
      const index=input.indexOf('\\n'); const line=input.slice(0,index); input=input.slice(index+1);
      if(!line)continue; const state=JSON.parse(line);
      if(!sent){ sent=true; console.log(JSON.stringify({event:'menu',action:'exit'})); }
      if(String(state.notice||'').startsWith('操作失败：')) setTimeout(()=>process.exit(0),10);
    }});
  `;
  const status = { ready: false, devspace: false, bridge: false, tunnel: false,
    gateway: 'active', remoteAccess: 'active', desiredRemoteAccess: 'suspended' };
  await runTray('unused', { helper: process.execPath,
    helperArgs: ['--input-type=module', '-e', fake], refreshInterval: 60000,
    operations: {
      status: async () => status,
      exit: async () => { exitCalls++; throw new Error('Gateway suspension could not be confirmed'); },
    } });
  assert.equal(exitCalls, 1);
});

test('health refreshes coalesce without blocking utility menu actions', async () => {
  let statusCalls = 0;
  let logCalls = 0;
  let releaseStatus;
  const fake = `
    console.log(JSON.stringify({event:'ready'}));
    setTimeout(()=>{
      for(let i=0;i<20;i++) console.log(JSON.stringify({event:'menu',action:'check'}));
      console.log(JSON.stringify({event:'menu',action:'logs'}));
    },15);
    let input='';
    process.stdin.on('data',chunk=>{input+=chunk; while(input.includes('\\n')){
      const index=input.indexOf('\\n'); const line=input.slice(0,index); input=input.slice(index+1);
      if(!line)continue; JSON.parse(line); setTimeout(()=>process.exit(0),25);
    }});
  `;
  const status = { ready: true, devspace: true, bridge: true, tunnel: true,
    gateway: 'active', remoteAccess: 'active' };
  await runTray('unused', { helper: process.execPath,
    helperArgs: ['--input-type=module', '-e', fake], refreshInterval: 60000,
    operations: {
      status: async () => {
        statusCalls++;
        return new Promise(resolve => { releaseStatus = () => resolve(status); });
      },
      logs: async () => { logCalls++; releaseStatus?.(); },
    } });
  assert.equal(logCalls, 1);
  assert.equal(statusCalls, 1);
});

test('native startup keeps tray separate from runtime and does not expose credentials',
  { skip: !['win32', 'darwin'].includes(process.platform) }, () => {
  const state = { deviceId: randomUUID(), deviceSecret: 'secret', accessKey: 'tds_secret',
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  const home = join(homedir(), 'TeamDevSpace');
  const root = join(homedir(), 'TDS');
  const task = windowsTaskXml(state, 'tray', home, 'S-1-5-21-123', root);
  assert.ok(task.includes('InteractiveToken') && task.includes('tds-launcher.exe'));
  assert.ok(task.includes('<Count>10</Count>') && !task.includes('<Count>999</Count>'));
  assert.ok(task.includes('run&quot; &quot;tray') && !task.includes(state.deviceSecret) && !task.includes(state.accessKey));
  const launch = launchAgentXml(state, 'tray', home, { node: '/app/node', cloudflared: '/app/cloudflared' }, root);
  assert.ok(launch.includes('<key>SuccessfulExit</key><false/>'));
  assert.ok(!launch.includes('<key>KeepAlive</key><true/>'));
  assert.equal(serviceLabel(state, 'tray').endsWith('.tray'), true);
});

test('diagnostic redaction removes employee and bearer credentials', () => {
  const report = redactDiagnostic('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 tds_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq');
  assert.ok(!report.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(!report.includes('tds_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'));
  assert.ok(report.includes('<REDACTED>'));
});
