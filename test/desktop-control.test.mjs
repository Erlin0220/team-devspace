import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest, createServer } from 'node:http';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { CONTROL_UI_PREFERRED_PORT, startLocalControl, listenOnBrowserPort } from '../client/local-control.mjs';
import { diagnosticReport, stopTeamDevSpace } from '../client/control.mjs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

const healthy = { ready: true, devspace: true, bridge: true, tunnel: true, gateway: 'active', remoteAccess: 'active', desiredRemoteAccess: 'active' };
const paused = { ready: false, devspace: false, bridge: false, tunnel: false, gateway: 'suspended', remoteAccess: 'suspended', desiredRemoteAccess: 'suspended' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('Condition did not settle'); }

async function freeFallbackPort() {
  // Linux listen(0) may choose a port below the production fallback range.
  // Exercise the same high-port contract instead of relying on OS defaults.
  for (let attempt = 0; attempt < 64; attempt++) {
    const server = createServer();
    const port = randomInt(49152, 65536);
    try {
      await listenOnBrowserPort(server, port);
      await new Promise(resolve => server.close(resolve));
      return port;
    } catch (error) {
      server.close();
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Test could not reserve a browser-safe fallback port');
}

test('a successful setup keeps its auxiliary startup warning visible without marking the connection failed', async t => {
  const warning = '托盘登录启动项暂不可用';
  const controller = createDesktopController('unused', { operations: {
    status: async () => healthy, setup: async () => ({ startup: 'partial', warning }),
  } });
  t.after(() => controller.dispose());
  await controller.dispatch('setup');
  assert.equal(controller.snapshot().notice, warning);
  assert.equal(controller.snapshot().alert, undefined);
});

test('Control Center persists its chosen loopback port, retries brief ownership, and migrates a real collision', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-port-'));
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const servers = [], surfaces = [];
  t.after(async () => {
    await Promise.all(surfaces.map(surface => surface.close().catch(() => {})));
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    await controller.dispose(); await rm(home, { recursive: true, force: true });
  });
  assert.equal(CONTROL_UI_PREFERRED_PORT, 53682);
  const blocker = createServer(); servers.push(blocker); await listenOnBrowserPort(blocker, 0);
  const preferred = blocker.address().port, fallback = await freeFallbackPort();
  const first = await startLocalControl(controller, { home, preferredPort: preferred, portRetryAttempts: 1,
    portRetryDelayMs: 1, chooseFallbackPort: () => fallback, openBrowser: async () => {} });
  surfaces.push(first);
  assert.equal(first.port, fallback); assert.equal(first.migratedFrom, null); assert.equal(first.endpointPersisted, true);
  const firstToken = new URL(first.url).hash;
  assert.equal(JSON.parse(await readFile(join(home, 'control-endpoint.json'), 'utf8')).port, fallback);
  await first.close(); surfaces.splice(surfaces.indexOf(first), 1);

  const second = await startLocalControl(controller, { home, preferredPort: preferred, portRetryAttempts: 1,
    portRetryDelayMs: 1, chooseFallbackPort: () => { throw new Error('persisted port should be reused'); }, openBrowser: async () => {} });
  surfaces.push(second); assert.equal(second.port, fallback); assert.equal(new URL(second.url).hash, firstToken);
  await second.close(); surfaces.splice(surfaces.indexOf(second), 1);

  const persistedBlocker = createServer(); servers.push(persistedBlocker); await listenOnBrowserPort(persistedBlocker, fallback);
  const next = await freeFallbackPort();
  const third = await startLocalControl(controller, { home, preferredPort: preferred, portRetryAttempts: 1,
    portRetryDelayMs: 1, chooseFallbackPort: () => next, openBrowser: async () => {} });
  surfaces.push(third);
  assert.equal(third.port, next); assert.equal(third.migratedFrom, fallback);
  assert.notEqual(new URL(third.url).hash, firstToken, 'Persistent port migration rotates the local capability');
  assert.equal(JSON.parse(await readFile(join(home, 'control-endpoint.json'), 'utf8')).port, next);
});

test('legacy fixed-port capability migrates safely when the old 53682 origin cannot be reclaimed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-legacy-port-'));
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const blocker = createServer(); let surface;
  t.after(async () => { await surface?.close().catch(() => {}); blocker.close(); blocker.closeAllConnections();
    await controller.dispose(); await rm(home, { recursive: true, force: true }); });
  await writeFile(join(home, 'control-capability.json'), JSON.stringify({ schema: 1, token: 'a'.repeat(43) }));
  await listenOnBrowserPort(blocker, 0); const preferred = blocker.address().port;
  const fallback = await freeFallbackPort();
  surface = await startLocalControl(controller, { home, preferredPort: preferred, portRetryAttempts: 1,
    portRetryDelayMs: 1, chooseFallbackPort: () => fallback, openBrowser: async () => {} });
  assert.equal(surface.migratedFrom, preferred);
  assert.equal(surface.port, fallback);
  assert.notEqual(new URL(surface.url).hash, '#'+ 'a'.repeat(43), 'The abandoned fixed origin cannot reuse the migrated endpoint credential');
  const migrated = new URL(surface.url);
  assert.equal((await fetch(migrated.origin + '/api/state', { headers: { Authorization: 'Bearer ' + migrated.hash.slice(1) } })).status, 200);
  assert.equal((await fetch(migrated.origin + '/api/state', { headers: { Authorization: 'Bearer ' + 'a'.repeat(43) } })).status, 401,
    'The abandoned origin credential is rejected by the migrated endpoint');
});

test('the exact bind primitive reports a collision without leaking listeners', async t => {
  const blocker = createServer(), server = createServer();
  t.after(() => { blocker.close(); blocker.closeAllConnections(); server.close(); server.closeAllConnections(); });
  await listenOnBrowserPort(blocker, 0); const occupied = blocker.address().port;
  const handlers = server.listenerCount('listening');
  await assert.rejects(listenOnBrowserPort(server, occupied), { code: 'EADDRINUSE' });
  assert.equal(server.listening, false); assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), handlers);
});

test('Control Center bounds stalled requests without retrying an uncertain mutation', async t => {
  const source = await readFile(new URL('../client/control.js', import.meta.url), 'utf8');
  const requestSource = source.slice(source.indexOf('async function request('), source.indexOf('\nfunction render('));
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  for (const body of [undefined, { action: 'restart' }]) {
    let calls = 0, deadline;
    const request = runInNewContext(`${requestSource}\nrequest`, {
      token: 'test-only-capability',
      AbortController,
      setTimeout: (callback, milliseconds) => { deadline = milliseconds; return setTimeout(callback, 20); },
      clearTimeout,
      fetch: async (_path, options) => {
        calls++;
        assert.ok(options.signal, 'A local HTTP request must have a finite deadline');
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(options.signal.reason), { once: true }));
      },
    });
    await assert.rejects(request(body ? '/api/action' : '/api/state', body),
      body ? /操作结果尚未确认/ : /读取状态超时/);
    assert.equal(calls, 1, 'Never retry a mutation automatically after an uncertain response');
    assert.equal(deadline, body ? 180000 : 10000);
  }
});

test('Control Center works without AbortSignal.timeout and releases completed request timers', async () => {
  const source = await readFile(new URL('../client/control.js', import.meta.url), 'utf8');
  const requestSource = source.slice(source.indexOf('async function request('), source.indexOf('\nfunction render('));
  const timers = new Set(); let calls = 0;
  const request = runInNewContext(`${requestSource}\nrequest`, {
    token: 'test-only-capability', AbortController, AbortSignal: {},
    setTimeout: (_callback, milliseconds) => { const timer = { milliseconds }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    fetch: async (_path, options) => {
      calls++; assert.equal(options.signal.aborted, false);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal((await request('/api/state')).ok, true);
  assert.equal((await request('/api/action', { action: 'check' })).ok, true);
  assert.equal(calls, 2);
  assert.equal(timers.size, 0, 'Completed requests must not retain their timeout callbacks');
});

test('local settings become available without waiting for a slow gateway probe', async t => {
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ({ accessKeyMode: 'replace-key', currentProjectRoot: '/project' }),
    status: async () => new Promise(() => {}),
  } });
  t.after(() => controller.dispose()); controller.start();
  await until(() => controller.snapshot().projectRoot === '/project');
  assert.equal(controller.snapshot().switchKeyText, '更换 Access Key…');
  assert.equal(controller.snapshot().menu.find(item => item.action === 'settings').enabled, true);
});

test('a delayed startup read cannot overwrite settings changed by a completed operation', async t => {
  const first = deferred(); let reads = 0;
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ++reads === 1 ? first.promise : { configured: true, accessKeyMode: 'replace-key', currentProjectRoot: '/new-project' },
    status: async () => null,
    setup: async () => ({ enrolled: true }),
  } });
  t.after(() => controller.dispose()); controller.start(); await delay(5);
  await controller.dispatch('setup');
  first.resolve({ configured: false, accessKeyMode: 'setup', currentProjectRoot: '/old-project' });
  await delay(5);
  assert.equal(controller.snapshot().projectRoot, '/new-project');
  assert.equal(controller.snapshot().accessKeyMode, 'replace-key');
});

test('stale health cannot overwrite a completed pause and duplicate mutations are rejected', async t => {
  const probe = deferred(), mutation = deferred(); let pausedCalls = 0;
  const controller = createDesktopController('unused', { operations: {
    status: () => probe.promise,
    suspend: async ({ onProgress }) => { pausedCalls++; onProgress('暂停进行中'); await mutation.promise; return paused; },
  } });
  t.after(() => controller.dispose()); controller.start(); await delay(5);
  const pending = controller.dispatch('suspend');
  assert.equal(controller.snapshot().busy, true); assert.equal(controller.snapshot().remoteEnabled, false);
  await assert.rejects(controller.dispatch('restart'), /未知控制操作/);
  await assert.rejects(controller.dispatch('suspend'), /已有操作/);
  mutation.resolve(); await pending; probe.resolve(healthy); await delay(5);
  assert.equal(pausedCalls, 1); assert.equal(controller.snapshot().status, 'suspended');
  assert.equal(controller.snapshot().remoteAction, 'resume');
});

test('Enrollment acknowledgements never replace real health and pending key recovery remains reachable', async t => {
  const controller = createDesktopController('unused', { operations: {
    setup: async () => ({ enrolled: true, ready: false, startup: 'installed' }),
    status: async () => healthy, localState: async () => ({ configured: true, accessKeyMode: 'replace-key' }),
  } });
  t.after(() => controller.dispose());
  await controller.dispatch('setup');
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.snapshot().health.devspace, true);
});

test('manual checks share an in-flight probe while logs remain available', async t => {
  const probe = deferred(); let count = 0, logs = 0;
  const controller = createDesktopController('unused', { operations: {
    status: async () => { count++; return probe.promise; }, logs: async () => { logs++; },
  } });
  t.after(() => controller.dispose()); controller.start();
  const checks = Array.from({ length: 20 }, () => controller.dispatch('check'));
  await controller.dispatch('logs'); probe.resolve(healthy); await Promise.all(checks);
  assert.equal(count, 1); assert.equal(logs, 1);
});

test('exit cancels only a folder prompt and waits for an already-started binding transaction', async t => {
  const mutation = deferred(); const order = []; let promptAborted = false;
  const controller = createDesktopController('unused', { operations: {
    status: async () => healthy,
    'switch-key': async () => { order.push('binding-start'); await mutation.promise; order.push('binding-commit'); return healthy; },
    'choose-folder': ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { promptAborted = true; resolve(null); }, { once: true })),
    exit: async () => { order.push('stop'); },
  } });
  t.after(() => controller.dispose());
  const work = controller.dispatch('switch-key'); const prompt = controller.dispatch('choose-folder'); await delay(5);
  const exiting = controller.dispatch('exit'); await delay(5);
  assert.equal(promptAborted, true); assert.deepEqual(order, ['binding-start']);
  mutation.resolve(); await Promise.all([prompt, work, exiting]);
  assert.deepEqual(order, ['binding-start', 'binding-commit', 'stop']);
});

test('one project action selects and commits once; cancelled or exit-cancelled selection never mutates', async t => {
  let selection = '/new-project', commits = 0, probes = 0;
  const prompt = deferred(); let waiting = false;
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ({ currentProjectRoot: '/old-project', accessKeyMode: 'replace-key' }),
    status: async () => { probes++; return healthy; },
    'choose-folder': async ({ signal }) => {
      if (!waiting) return selection;
      signal.addEventListener('abort', () => prompt.resolve(null), { once: true });
      return prompt.promise;
    },
    'project-root': async ({ projectRoot }) => { assert.equal(projectRoot, '/new-project'); commits++; return healthy; },
    exit: async () => {},
  } });
  t.after(() => controller.dispose());
  await controller.dispatch('project-root');
  assert.equal(commits, 1);
  selection = null;
  const probesBeforeCancel = probes;
  assert.equal((await controller.dispatch('project-root')).cancelled, true);
  assert.equal(commits, 1);
  assert.equal(probes, probesBeforeCancel, 'Cancelling a native picker must not wait for a network health probe');
  assert.match(controller.snapshot().notice, /已取消/);
  waiting = true;
  const pending = controller.dispatch('project-root');
  await delay(5);
  assert.equal(controller.snapshot().busy, true);
  await assert.rejects(controller.dispatch('project-root'), { status: 409 });
  await controller.dispatch('exit');
  assert.equal((await pending).cancelled, true);
  assert.equal(commits, 1, 'Exiting while the picker is open must not commit a returned path');
});

test('failure retains actionable feedback and re-reads the persisted pause', async t => {
  const controller = createDesktopController('unused', { operations: {
    status: async () => ({ ...paused, gateway: 'unreachable' }),
    suspend: async () => { throw new Error('本机已暂停，服务端状态未确认'); },
    exit: async () => { throw new Error('Local service shutdown failed'); },
  } });
  t.after(() => controller.dispose());
  await assert.rejects(controller.dispatch('suspend'), /本机已暂停/);
  assert.equal(controller.snapshot().status, 'suspended'); assert.equal(controller.snapshot().remoteAction, 'suspend');
  assert.match(controller.snapshot().alert, /本机已暂停/);
  await controller.dispatch('check'); assert.match(controller.snapshot().alert, /本机已暂停/);
  await assert.rejects(controller.dispatch('exit'), /shutdown/);
  assert.equal(controller.snapshot().exitEnabled, true); assert.equal(controller.snapshot().exiting, false);
  assert.match(controller.snapshot().alert, /关闭 Team DevSpace失败/);
});

test('unconfigured desktop can exit but corrupt state is not silently accepted', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-empty-desktop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await stopTeamDevSpace(home)).configured, false);
  assert.equal((await diagnosticReport(home)).gatewayHealth, 'not-enrolled');
  await writeFile(join(home, 'state.json'), '{broken');
  await assert.rejects(stopTeamDevSpace(home), /Cannot read/);
  const report = await diagnosticReport(home);
  assert.equal(report.gatewayHealth, 'unknown');
  assert.equal(report.stateHealth, 'unreadable');
  assert.match(report.error, /Cannot read/);
});

test('loopback Control Center protects reads and writes against cross-origin, rebinding and missing capability', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-security-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = []; let notesReads = 0;
  const controller = createDesktopController('unused', { operations: { status: async () => healthy,
    diagnostics: async () => ({ remoteAccess: 'active' }), logs: async () => calls.push('logs'),
    'update-check': async () => ({ available: true, required: false, error: null, policy: { stable: '0.2.6' } }),
    'release-notes': async ({ version }) => { notesReads++; return { version, summary: ['安全文本'], url: `https://downloads.test/releases/${version}/release-notes.txt` }; },
    'choose-folder': async () => '/selected-project',
    'project-root': async ({ projectRoot }) => { calls.push(projectRoot); return healthy; } } });
  const ui = await startLocalControl(controller, { openBrowser: async () => {}, home, port: 0 });
  t.after(async () => { await ui.close(); await controller.dispose(); });
  const url = new URL(ui.url), base = url.origin, authorization = `Bearer ${url.hash.slice(1)}`;
  const api = (path, options = {}) => fetch(base + path, { ...options, headers: { Authorization: authorization, ...options.headers } });
  const html = await fetch(base);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.ok(!(await html.text()).includes(url.hash.slice(1)));
  const logo = await fetch(base + '/devspace-logo-light.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.ok((await logo.arrayBuffer()).byteLength > 0, 'The shared Control Center product logo is bundled with the client');
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/token')).status, 401, 'There is no unauthenticated capability endpoint');
  assert.equal((await api('/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  // Fetch normalizes Host; use a real raw HTTP request to exercise rebinding.
  const forgedHost = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/state', { headers: { Host: 'evil.example', Authorization: authorization } },
      response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end();
  });
  assert.equal(forgedHost, 403);
  assert.equal((await api('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api('/api/state')).status, 200);
  assert.equal((await fetch(base + '/api/release-notes?version=0.2.6')).status, 401);
  assert.equal((await api('/api/release-notes?version=../latest')).status, 400);
  const notes = await (await api('/api/release-notes?version=0.2.6')).json();
  assert.deepEqual(notes.summary, ['安全文本']); assert.equal(notes.version, '0.2.6');
  await api('/api/release-notes?version=0.2.6'); assert.equal(notesReads, 1, 'Immutable notes are cached by version');
  const post = (body, headers = {}) => api('/api/action', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'logs' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ action: 'exit' })).status, 400);
  assert.equal((await post({ action: 'logs', arbitraryCommand: 'bad' })).status, 400);
  assert.equal((await post({ action: 'logs', projectRoot: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post({ action: 'switch-key', accessKey: 'tds_short' })).status, 400);
  assert.equal((await post({ action: 'logs' })).status, 200);
  const checked = await (await post({ action: 'update-check' })).json();
  assert.deepEqual(checked.updateCheck, { available: true, required: false, targetVersion: '0.2.6', error: null });
  assert.deepEqual(calls, ['logs']);
  assert.equal((await api('/api/diagnostics')).status, 200);
  assert.equal((await fetch(base + '/diagnostics')).status, 200);
  assert.equal((await post({ action: 'project-root', projectRoot: '' })).status, 400);
  assert.equal((await post({ action: 'project-root' })).status, 200);
  assert.deepEqual(calls, ['logs', '/selected-project'], 'A pathless authorized request performs selection and one actual change');
});

test('private Control Center capability survives restart while the instance identity changes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-restart-'));
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  t.after(async () => { await controller.dispose(); await rm(home, { recursive: true, force: true }); });
  const first = await startLocalControl(controller, { openBrowser: async () => {}, home, port: 0 });
  const firstUrl = new URL(first.url), authorization = { Authorization: `Bearer ${firstUrl.hash.slice(1)}` };
  const firstState = await (await fetch(`${firstUrl.origin}/api/state`, { headers: authorization })).json();
  const port = Number(firstUrl.port); await first.close();
  const second = await startLocalControl(controller, { openBrowser: async () => {}, home, port });
  t.after(() => second.close());
  const secondUrl = new URL(second.url);
  assert.equal(secondUrl.hash, firstUrl.hash, 'An already-open page keeps its private capability across normal restart');
  assert.equal(secondUrl.origin, firstUrl.origin, 'The fixed origin is reusable after the old server closes');
  const secondState = await (await fetch(`${secondUrl.origin}/api/state`, { headers: authorization })).json();
  assert.notEqual(secondState.controlInstance, firstState.controlInstance, 'A restarted app forces stale assets to reload');
  assert.equal((await fetch(`${secondUrl.origin}/api/state`)).status, 401);
});

test('concurrent explicit ephemeral Control Centers never share a capability across origins', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-capability-race-'));
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const surfaces = [];
  t.after(async () => { await Promise.all(surfaces.map(surface => surface.close())); await controller.dispose();
    await rm(home, { recursive: true, force: true }); });
  surfaces.push(...await Promise.all([startLocalControl(controller, { openBrowser: async () => {}, home, port: 0 }),
    startLocalControl(controller, { openBrowser: async () => {}, home, port: 0 })]));
  const urls = surfaces.map(surface => new URL(surface.url));
  assert.notEqual(urls[0].hash, urls[1].hash);
  for (let index = 0; index < urls.length; index++) {
    assert.equal((await fetch(urls[index].origin + '/api/state', {
      headers: { Authorization: 'Bearer ' + urls[index].hash.slice(1) } })).status, 200);
    assert.equal((await fetch(urls[index].origin + '/api/state', {
      headers: { Authorization: 'Bearer ' + urls[1 - index].hash.slice(1) } })).status, 401);
  }
  assert.match((await readFile(join(home, 'control-capability.json'), 'utf8')), /"schema": 1/);
});


test('broken subscribers cannot abort core operations or starve healthy subscribers', async t => {
  let calls = 0, seen = 0;
  const controller = createDesktopController('unused', { operations: {
    status: async () => healthy,
    resume: async ({ onProgress }) => { calls++; onProgress('working'); return healthy; },
  } });
  t.after(() => controller.dispose());
  assert.doesNotThrow(() => controller.subscribe(() => { throw new Error('render failed'); }));
  controller.subscribe(async () => { throw new Error('async rendering failed'); });
  controller.subscribe(() => { seen++; });
  await controller.dispatch('resume'); await controller.dispatch('check'); await delay(5);
  assert.equal(calls, 1); assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.snapshot().busy, false); assert.ok(seen > 2);
});
test('post-commit settings projection errors cannot turn successful mutations into failures', async t => {
  let calls = 0;
  const controller = createDesktopController('unused', { operations: {
    status: async () => healthy,
    localState: async () => { throw new Error('settings projection unavailable'); },
    resume: async () => { calls++; return healthy; },
  } });
  t.after(() => controller.dispose());
  await assert.doesNotReject(controller.dispatch('resume'));
  assert.equal(calls, 1); assert.equal(controller.snapshot().status, 'ready'); assert.equal(controller.snapshot().busy, false);
});

test('endpoint cache failure cannot reuse a control capability across origins after restart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-affinity-'));
  const controller = createDesktopController('unused', { operations: { status: async () => healthy } });
  const servers = [], surfaces = [];
  const reserve = async () => { const server = createServer(); servers.push(server); await listenOnBrowserPort(server, 0); return server; };
  t.after(async () => {
    await Promise.all(surfaces.map(surface => surface.close().catch(() => {})));
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    await controller.dispose(); await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, 'control-endpoint.json'));
  const blocker = await reserve(), preferred = blocker.address().port;
  const fallback = await freeFallbackPort();
  const options = { home, preferredPort: preferred, portRetryAttempts: 1, portRetryDelayMs: 1,
    chooseFallbackPort: () => fallback, openBrowser: async () => {} };
  const first = await startLocalControl(controller, options); surfaces.push(first);
  assert.equal(first.endpointPersisted, false);
  const original = new URL(first.url);
  await first.close(); surfaces.splice(surfaces.indexOf(first), 1);
  await new Promise(resolve => blocker.close(resolve));
  const second = await startLocalControl(controller, options); surfaces.push(second);
  const after = new URL(second.url);
  assert.ok(original.origin === after.origin || original.hash !== after.hash,
    'A missing endpoint cache cannot move an existing token onto another origin');
  assert.equal(JSON.parse(await readFile(join(home, 'control-capability.json'), 'utf8')).port, second.port);
});
