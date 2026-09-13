import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { startLocalControl } from '../client/local-control.mjs';

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
    assert.equal(view.notice, undefined, 'An explicit new check retires the preceding completion notice');
    assert.equal(view.activity, undefined);
    state = healthy;
  }
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
  const opened = [];
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const ui = await startLocalControl(controller, { openBrowser: async url => opened.push(new URL(url)) });
  t.after(async () => { await ui.close(); await controller.dispose(); });
  await ui.open('about'); await ui.open('diagnostics');
  assert.equal(opened[0].pathname, '/about');
  assert.equal(opened[1].pathname, '/diagnostics');
  assert.equal(opened[0].hash, opened[1].hash);
  const response = await fetch(`${opened[0].origin}/about`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="about-title"/);
  assert.equal((await fetch(`${opened[0].origin}/api/state`)).status, 401);
});
