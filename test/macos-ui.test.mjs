import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runMacForm } from '../client/macos-ui.mjs';
import { desktopErrorText, macText, macProgress, macError } from '../client/desktop.mjs';

const home = join(tmpdir(), 'team-devspace-form-protocol-test');
const options = scenario => ({ home, helper: process.execPath,
  helperArgs: [resolve('test/fixtures/macos-form.mjs'), scenario] });

test('macOS form keeps validation, retry and success feedback on the same pipe', { timeout: 10000 }, async () => {
  let calls = 0;
  const result = await runMacForm({ ...options('retry'), submit: async ({ accessKey, currentProjectRoot }, progress) => {
    assert.equal(accessKey, `tds_${'a'.repeat(43)}`);
    assert.equal(currentProjectRoot, '/test/project');
    if (++calls === 1) throw new Error('invalid_access_key');
    progress('Contacting the Team Gateway and confirming Enrollment...');
    return { enrolled: true, connection: 'starting' };
  } });
  assert.equal(calls, 2);
  assert.equal(result.enrolled, true);
  assert.equal(result.connection, 'starting');
});

test('macOS form ignores duplicate submissions while the transaction is pending', { timeout: 10000 }, async () => {
  let calls = 0;
  await runMacForm({ ...options('duplicate-submit'), submit: async () => {
    calls++;
    await delay(100);
    return { enrolled: true };
  } });
  assert.equal(calls, 1);
});

test('closing an idle form or encountering another form never submits a credential', { timeout: 10000 }, async () => {
  for (const scenario of ['cancel', 'duplicate']) {
    const result = await runMacForm({ ...options(scenario), submit: () => assert.fail('must not submit') });
    assert.equal(result.cancelled, true);
  }
});

test('closing during enrollment waits for the transaction, not just the native process', { timeout: 10000 }, async () => {
  let committed = false;
  const result = await runMacForm({ ...options('cancel-busy'), submit: async () => {
    await delay(120);
    committed = true;
    return { enrolled: true };
  } });
  assert.equal(committed, true);
  assert.equal(result.enrolled, true);
});

test('tray exit aborts the prompt but does not abandon an already started binding transaction', { timeout: 10000 }, async () => {
  const abort = new AbortController();
  let committed = false;
  const result = await runMacForm({ ...options('external-abort'), signal: abort.signal, submit: async () => {
    abort.abort();
    await delay(120);
    committed = true;
    return { enrolled: true };
  } });
  assert.equal(committed, true);
  assert.equal(result.enrolled, true);
});

test('unexpected native exit settles the transaction before reporting failure', { timeout: 10000 }, async () => {
  let committed = false;
  await assert.rejects(runMacForm({ ...options('crash-busy'), submit: async () => {
    await delay(120);
    committed = true;
    return { enrolled: true };
  } }), /意外退出/);
  assert.equal(committed, true);
});

test('malformed/oversized native messages fail closed without echoing private input', { timeout: 10000 }, async () => {
  for (const scenario of ['invalid', 'bad-json', 'oversize']) {
    await assert.rejects(runMacForm({ ...options(scenario), submit: () => assert.fail('must not submit') }), error => {
      assert.match(error.message, /通信中断/);
      assert.doesNotMatch(error.message, /tds_/);
      return true;
    });
  }
});

test('a helper that never becomes ready has a bounded startup failure', { timeout: 10000 }, async () => {
  await assert.rejects(runMacForm({ ...options('no-ready'), startupTimeout: 1000,
    submit: () => assert.fail('must not submit') }), /未能启动/);
});

test('pre-cancelled setup creates no native process', async () => {
  const result = await runMacForm({ signal: AbortSignal.abort(), helper: '/does-not-exist', submit: () => assert.fail() });
  assert.deepEqual(result, { cancelled: true });
});

test('missing helper is actionable and never prints a child-process command dump', async () => {
  await assert.rejects(runMacForm({ home, helper: join(tmpdir(), 'nonexistent-team-devspace-native-helper'),
    submit: () => assert.fail() }), /无法启动 macOS 原生界面/);
});

test('macOS launcher surfaces the existing tray before bootstrap work', async () => {
  const launch = await readFile('platform/macos/launch-app.sh', 'utf8');
  const kickstart = launch.indexOf('com.teamdevspace.tray');
  const bootstrap = launch.indexOf('bootstrap.sh');
  assert.ok(kickstart >= 0, 'launcher should kickstart the existing tray');
  assert.ok(bootstrap > kickstart, 'tray kickstart must happen before bootstrap');
  assert.match(launch, /install-manifest\.json/);
  assert.match(launch, /release-manifest\.json/);
});

test('macOS packaging uses the Team DevSpace brand for app and menu bar icons', async () => {
  await access('platform/macos/devspace-logo-light.png');
  const [swift, packaging] = await Promise.all([
    readFile('native/macos/TeamDevSpaceUI.swift', 'utf8'),
    readFile('scripts/package.mjs', 'utf8'),
  ]);
  assert.match(swift, /TeamDevSpaceTemplate/);
  assert.doesNotMatch(swift, /systemSymbolName:\s*symbol/);
  assert.match(packaging, /CFBundleIconFile/);
  assert.match(packaging, /TeamDevSpace\.icns/);
  assert.match(packaging, /TeamDevSpaceTemplate\.png/);
});

test('macOS presentation reuses lifecycle facts and redacts credentials', () => {
  assert.equal(macText('Team DevSpace 正常'), '已连接');
  assert.equal(macText('Team DevSpace 本机已暂停，服务端状态未知'), '本机已暂停，服务端状态未知');
  assert.equal(macText('Team DevSpace 未完成 Enrollment'), '需要完成设置');
  assert.equal(macProgress('Installing current-user login startup entries...'), '正在配置登录启动…');
  assert.match(desktopErrorText(Object.assign(new Error('access_key_already_bound'), { code: 'access_key_already_bound' })), /重置设备绑定/);
  assert.match(desktopErrorText(Object.assign(new Error('project_root_unavailable'), { code: 'project_root_unavailable' })), /项目目录/);
  assert.doesNotMatch(macError(new Error(`rejected tds_${'a'.repeat(43)}`)), /tds_/);
});
