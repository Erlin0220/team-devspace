import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactDiagnostic } from '../client/control.mjs';
import { launchAgentXml, serviceLabel, windowsTaskXml } from '../client/platform.mjs';
import { runTray, trayState } from '../client/tray.mjs';

test('tray presentation derives every state from the existing health result', () => {
  assert.equal(trayState({ ready: true, devspace: true, bridge: true, tunnel: true,
    remoteAccess: 'active' }).status, 'ready');
  assert.equal(trayState({ ready: false, devspace: true, bridge: false, tunnel: true,
    remoteAccess: 'active' }).status, 'partial');
  assert.equal(trayState({ ready: false, devspace: false, bridge: false, tunnel: false,
    remoteAccess: 'active' }).status, 'stopped');
  assert.equal(trayState({ ready: false, devspace: false, bridge: false, tunnel: false,
    remoteAccess: 'suspended' }).status, 'suspended');
  assert.equal(trayState(null).remoteAccess, 'not-enrolled');
});

test('tray JSON-lines controller delegates actions without becoming a supervisor', async () => {
  const calls = [];
  let remoteAccess = 'active';
  const actions = ['suspend', 'resume', 'restart', 'logs', 'diagnostics'];
  const fake = `
    const actions=${JSON.stringify(actions)}; let input='';
    console.log(JSON.stringify({event:'ready'}));
    process.stdin.on('data',chunk=>{input+=chunk; while(input.includes('\\n')){
      const index=input.indexOf('\\n'); const line=input.slice(0,index); input=input.slice(index+1);
      if(!line)continue; JSON.parse(line);
      const action=actions.shift();
      if(action) console.log(JSON.stringify({event:'menu',action}));
      else setTimeout(()=>process.exit(0),25);
    }});
  `;
  const status = () => ({ ready: remoteAccess === 'active', devspace: true, bridge: true,
    tunnel: true, gateway: remoteAccess, remoteAccess });
  await runTray('unused', { helper: process.execPath, helperArgs: ['--input-type=module', '-e', fake],
    refreshInterval: 60000, operations: {
      status: async () => status(),
      suspend: async () => { calls.push('suspend'); remoteAccess = 'suspended'; return status(); },
      resume: async () => { calls.push('resume'); remoteAccess = 'active'; return status(); },
      restart: async () => { calls.push('restart'); return status(); },
      logs: async () => { calls.push('logs'); },
      diagnostics: async () => { calls.push('diagnostics'); },
    } });
  assert.deepEqual(calls, actions);
});

test('native startup keeps tray separate from runtime and does not expose credentials', () => {
  const state = { deviceId: randomUUID(), deviceSecret: 'secret', accessKey: 'tds_secret',
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  const home = join(homedir(), 'TeamDevSpace');
  const root = join(homedir(), 'TDS');
  const task = windowsTaskXml(state, 'tray', home, 'S-1-5-21-123', root);
  assert.ok(task.includes('InteractiveToken') && task.includes('tds-launcher.exe'));
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
