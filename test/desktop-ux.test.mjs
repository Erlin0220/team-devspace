import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { startLocalControl } from '../client/local-control.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const healthy = { ready: true, devspace: true, bridge: true, tunnel: true,
  gateway: 'active', remoteAccess: 'active', desiredRemoteAccess: 'active', currentProjectRoot: '/project' };

test('completed lifecycle actions never leave future-tense progress above confirmed health', async t => {
  let state = healthy;
  const operations = { status: async () => state, localState: async () => ({ configured: true }) };
  for (const action of ['restart', 'resume', 'setup', 'project-root']) operations[action] = async ({ onProgress }) => {
    onProgress('正在检查状态'); return { changed: true };
  };
  const controller = createDesktopController('unused', { operations });
  t.after(() => controller.dispose());
  for (const action of ['restart', 'resume', 'setup', 'project-root']) {
    await controller.dispatch(action, { projectRoot: '/project' });
    let view = controller.snapshot();
    assert.equal(view.status, 'ready');
    assert.equal(view.activity, undefined);
    assert.equal(view.busy, false);
    assert.doesNotMatch(view.notice, /正在|连接中|检查状态/);
    assert.ok(view.checkedAt);
    state = { ...healthy, ready: false, tunnel: false };
    await controller.dispatch('check');
    view = controller.snapshot();
    assert.equal(view.status, 'partial');
    assert.equal(view.notice, '连接检查完成，请查看当前状态',
      'A fresh check replaces the preceding lifecycle notice with its actual outcome');
    assert.equal(view.activity, undefined);
    state = healthy;
  }
  await controller.dispatch('check');
  assert.equal(controller.snapshot().notice, '连接检查完成，一切正常');
});

test('manual check settling a stale startup probe cannot leave a permanent activity', async t => {
  let resolve;
  const probe = new Promise(done => { resolve = done; });
  const controller = createDesktopController('unused', { operations: {
    status: () => probe, restart: async () => healthy,
  } });
  t.after(() => controller.dispose());
  controller.start();
  await Promise.resolve();
  await controller.dispatch('restart');
  const check = controller.dispatch('check');
  resolve({ ...healthy, ready: false });
  await check;
  assert.equal(controller.snapshot().activity, undefined);
  assert.equal(controller.snapshot().status, 'ready', 'A pre-restart probe cannot overwrite post-restart health');
});

test('about and diagnostics use the same protected local surface and section navigation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-desktop-ux-'));
  const opened = [];
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const ui = await startLocalControl(controller, { openBrowser: async url => opened.push(new URL(url)), home, port: 0 });
  t.after(async () => { await ui.close(); await controller.dispose(); await rm(home, { recursive: true, force: true }); });
  await ui.open('about'); await ui.open('diagnostics');
  assert.equal(opened[0].pathname, '/about');
  assert.equal(opened[1].pathname, '/diagnostics');
  assert.equal(opened[0].hash, opened[1].hash);
  const response = await fetch(`${opened[0].origin}/about`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="about-title"/);
  assert.equal((await fetch(`${opened[0].origin}/api/state`)).status, 401);
});

test('operation notices expire during healthy polling while actionable failures persist', async t => {
  const controller = createDesktopController('unused', { refreshInterval: 5, noticeTtl: 20, operations: {
    status: async () => healthy, restart: async () => healthy,
    suspend: async () => { throw new Error('需要用户处理的暂停失败'); },
  } });
  t.after(() => controller.dispose()); controller.start();
  await controller.dispatch('restart'); assert.match(controller.snapshot().notice, /已完成/);
  await delay(50); assert.equal(controller.snapshot().notice, undefined);
  await assert.rejects(controller.dispatch('suspend'), /需要用户处理/);
  await delay(30); assert.match(controller.snapshot().alert, /需要用户处理/);
});

test('a slow stale probe cannot clear current operation progress', async t => {
  let resolveProbe, resolveOperation;
  const probe = new Promise(resolve => { resolveProbe = resolve; });
  const operation = new Promise(resolve => { resolveOperation = resolve; });
  const controller = createDesktopController('unused', { operations: {
    status: () => probe, restart: async ({ onProgress }) => { onProgress('正在执行当前重启…'); await operation; return healthy; },
  } });
  t.after(() => controller.dispose()); controller.start(); await Promise.resolve();
  const running = controller.dispatch('restart'); await Promise.resolve(); resolveProbe(healthy); await Promise.resolve();
  assert.equal(controller.snapshot().activity, '正在执行当前重启…');
  resolveOperation(); await running; assert.equal(controller.snapshot().activity, undefined);
});

test('manual update state stays tab-neutral and a verified latest notice is temporary', async t => {
  let available = true;
  const controller = createDesktopController('unused', { noticeTtl: 20, operations: {
    status: async () => healthy,
    'update-check': async () => available ? { available: true, required: true,
      policy: { stable: '0.2.6', minimumSupported: '0.2.6' },
      releaseNotes: { version: '0.2.6', summary: ['关键修复'], url: 'https://downloads.example/releases/0.2.6/release-notes.txt' } }
      : { available: false, checkedAt: new Date().toISOString(), policy: { stable: '0.2.5' } },
  } });
  t.after(() => controller.dispose());
  assert.equal(controller.snapshot().updates, null, 'Background health state cannot open an update confirmation');
  await controller.dispatch('update-check');
  assert.equal(controller.snapshot().updates.confirmationId, undefined, 'Shared snapshots never broadcast modal triggers');
  assert.deepEqual(controller.snapshot().updates.releaseNotes.summary, ['关键修复']);
  available = false; await controller.dispatch('update-check');
  assert.equal(controller.snapshot().updates.confirmationId, undefined);
  assert.equal(controller.snapshot().notice, '当前已是最新版本');
  await delay(40); assert.equal(controller.snapshot().notice, undefined);
});
