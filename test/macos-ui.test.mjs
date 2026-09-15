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

test('closing an idle form cancels, while a duplicate form reports an actionable visible error', { timeout: 10000 }, async () => {
  const cancelled = await runMacForm({ ...options('cancel'), submit: () => assert.fail('must not submit') });
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(
    runMacForm({ ...options('duplicate'), submit: () => assert.fail('must not submit') }),
    error => error.code === 'ui_already_open' && /已经打开/.test(error.message));
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

test('a helper must become visibly presented, not merely process-ready', { timeout: 10000 }, async () => {
  for (const scenario of ['no-ready', 'ready-no-visible']) {
    await assert.rejects(runMacForm({ ...options(scenario), startupTimeout: 1000,
      submit: () => assert.fail('must not submit') }), /未能显示/);
  }
});

test('pre-cancelled setup creates no native process', async () => {
  const result = await runMacForm({ signal: AbortSignal.abort(), helper: '/does-not-exist', submit: () => assert.fail() });
  assert.deepEqual(result, { cancelled: true });
});

test('missing helper is actionable and never prints a child-process command dump', async () => {
  await assert.rejects(runMacForm({ home, helper: join(tmpdir(), 'nonexistent-team-devspace-native-helper'),
    submit: () => assert.fail() }), /无法启动 macOS 原生界面/);
});

test('macOS launcher surfaces the existing tray before bootstrap work and rejects duplicate wrappers', async () => {
  const launch = await readFile('platform/macos/launch-app.sh', 'utf8');
  const kickstart = launch.indexOf('com.teamdevspace.tray');
  const bootstrap = launch.indexOf('bootstrap.sh');
  assert.ok(kickstart >= 0, 'launcher should kickstart the existing tray');
  assert.ok(bootstrap > kickstart, 'tray kickstart must happen before bootstrap');
  assert.match(launch, /app-launch\.lock/);
  assert.match(launch, /acquire_launch_lock/);
  assert.match(launch, /TEAM_DEVSPACE_UI_READY_MARKER/);
  assert.match(launch, /install-manifest\.json/);
  assert.match(launch, /release-manifest\.json/);
  // Re-acknowledge visibility without reinstalling or stopping healthy jobs.
  assert.ok(launch.includes('"$current/client/cli.mjs" start'));
  assert.ok(!launch.includes('startup install --runtime-root'));
  const swift = await readFile('native/macos/TeamDevSpaceUI.swift', 'utf8');
  assert.ok(swift.includes('if item.isVisible { markUIVisible() }'));

});

test('macOS packaging uses separate Team DevSpace assets for app and menu bar icons', async () => {
  await access('platform/macos/devspace-logo-light.png');
  await access('platform/macos/team-devspace-template.png');
  const packaging = await readFile('scripts/package.mjs', 'utf8');
  assert.match(packaging, /CFBundleIconFile/);
  assert.match(packaging, /TeamDevSpace\.icns/);
  assert.match(packaging, /team-devspace-template\.png/);
  assert.match(packaging, /TeamDevSpaceTemplate\.png/);
  assert.match(packaging, /LSMultipleInstancesProhibited/);
});

test('macOS native pipe consumes short input and packaging runs real GUI smoke', async () => {
  const [swift, packaging, smoke] = await Promise.all([
    readFile('native/macos/TeamDevSpaceUI.swift', 'utf8'),
    readFile('scripts/package.mjs', 'utf8'),
    readFile('scripts/tray-smoke.mjs', 'utf8'),
  ]);
  assert.match(swift, /Darwin\.read\(STDIN_FILENO/);
  assert.doesNotMatch(swift, /FileHandle\.standardInput\.read\(upToCount:/);
  assert.match(swift, /errno == EINTR/);
  assert.match(packaging, /scripts\/tray-smoke\.mjs/);
  assert.match(smoke, /shortMessagesBeforeEOF: true/);
  assert.ok(smoke.indexOf('await waitFor(() => applied.length === expected') < smoke.indexOf('child.stdin.end()'));
});

test('macOS native UI reports actual visibility and checks activation policy', async () => {
  const swift = await readFile('native/macos/TeamDevSpaceUI.swift', 'utf8');
  assert.match(swift, /activationPolicy\(\) != \.accessory && !app\.setActivationPolicy\(\.accessory\)/);
  assert.match(swift, /activationPolicy\(\) != \.regular && !app\.setActivationPolicy\(\.regular\)/);
  assert.match(swift, /panel\.isVisible/);
  assert.match(swift, /item\.isVisible/);
  assert.match(swift, /emit\("form-visible"\)/);
  assert.match(swift, /emit\("tray-visible"\)/);
  assert.match(swift, /TEAM_DEVSPACE_UI_READY_MARKER/);
});

test('macOS menu bar keeps lifecycle feedback visible after the menu closes', async () => {
  const swift = await readFile('native/macos/TeamDevSpaceUI.swift', 'utf8');
  assert.match(swift, /NSStatusItem\.variableLength/);
  assert.match(swift, /button(?:\?)?\.title\s*=/);
  assert.match(swift, /setIcon\(state\.iconStatus, summary: String\(state\.tooltip/);
  assert.doesNotMatch(swift, /state\.activity|state\.notice|state\.remoteAction/);
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
