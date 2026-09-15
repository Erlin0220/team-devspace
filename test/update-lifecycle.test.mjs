import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { applyUpdate, checkForUpdates, startUpdateChecks, updateStatus } from '../client/updates.mjs';
import { pruneUpdateCache } from '../client/update-cache.mjs';
import { atomicJson, readJson, RELEASE_VERSION } from '../client/state.mjs';
import { packageName } from '../client/release-catalog.mjs';
import { boundedJson } from '../client/update-policy.mjs';
import { updateTestCatalog, updateTestBytes, updateTestPublicKey, signUpdateFixture } from './update-fixture.mjs';

const versionParts = RELEASE_VERSION.split('.').map(Number);
const futureVersion = [...versionParts.slice(0, 2), versionParts[2] + 1].join('.');
const policy = (auto = null) => ({ schema: 1, stable: futureVersion, auto,
  minimumSupported: null, enforceAfter: null, revision: 0 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'tds-update-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
function clock() {
  let time = Date.now(), next;
  return {
    now: () => time,
    schedule: (callback, delay) => { next = { callback, delay }; return next; },
    cancel: handle => { if (next === handle) next = null; },
    delay: () => next?.delay,
    async tick() { const job = next; assert.ok(job, 'Expected a scheduled wake'); next = null; time += job.delay; await job.callback(); },
  };
}
async function applyOptions(home, version = futureVersion) {
  const signed = await signUpdateFixture(updateTestCatalog(version));
  return { publicKey: updateTestPublicKey, distributionRoot: async () => home,
    fetcher: async url => url.endsWith('/v1/update-policy') ? Response.json({ ...policy(), stable: version })
      : url.endsWith('/update.json') ? Response.json(signed) : new Response(updateTestBytes) };
}

test('scheduler wakes at the persisted deadline after restart, not another six hours later', async t => {
  const home = await temporary(t), timer = clock(), deadline = timer.now() + 10 * 60000;
  let calls = 0;
  const stop = startUpdateChecks(home, () => {}, () => true, { ...timer,
    check: async () => { calls++; return { nextCheckAt: deadline, automatic: false, policy: policy() }; } });
  t.after(stop);
  await timer.tick();
  assert.equal(calls, 1); assert.equal(timer.delay(), deadline - timer.now());
  stop(); assert.equal(timer.delay(), undefined);
});

test('failed checks schedule the real one-hour retry and clock rollback forces a fresh check', async t => {
  const home = await temporary(t), timer = clock(); let reads = 0;
  const stop = startUpdateChecks(home, () => {}, () => true, { ...timer,
    check: options => checkForUpdates(options, { now: timer.now(), fetcher: async () => { reads++; throw new Error('offline'); } }) });
  t.after(stop);
  await timer.tick(); assert.equal(timer.delay(), 3600000); assert.equal(reads, 1);
  await timer.tick(); assert.equal(reads, 2);
  stop();
  await atomicJson(join(home, 'updates/check.json'), { currentVersion: RELEASE_VERSION,
    checkedAt: new Date(timer.now() + 86400000).toISOString(), nextCheckAt: timer.now() + 90000000 });
  const status = await checkForUpdates(home, { now: timer.now(), fetcher: async () => { reads++; return Response.json(policy()); } });
  assert.equal(status.error, null); assert.equal(reads, 3);
});

test('returned deferrals survive ticks; local busy retries do not download or contact the Gateway again', async t => {
  const home = await temporary(t), timer = clock(); let busy = true, prepares = 0, network = 0;
  const stop = startUpdateChecks(home, () => {}, () => !busy, { ...timer,
    check: (_home, options) => checkForUpdates(home, { ...options, now: timer.now(), fetcher: async () => {
      network++; return Response.json(policy(futureVersion));
    } }),
    apply: async (_home, options) => { prepares++; return options.canApply() ? { handedOff: true }
      : { deferred: true, code: 'local_operation_active', message: 'waiting for local work' }; },
  });
  t.after(stop);
  await timer.tick();
  assert.equal(prepares, 1); assert.equal(network, 1); assert.equal(timer.delay(), 600000);
  assert.equal((await updateStatus(home)).automaticResult.deferred, true);
  await timer.tick(); assert.equal(prepares, 1); assert.equal(network, 1);
  busy = false;
  await timer.tick(); assert.equal(prepares, 2); assert.equal(network, 1);
});

test('remote-work retries probe only local readiness before another apply attempt', async t => {
  const home = await temporary(t), timer = clock(); let prepares = 0, probes = 0;
  const work = () => Object.assign(new Error('busy'), { code: 'remote_work_active' });
  const stop = startUpdateChecks(home, () => {}, () => true, { ...timer,
    check: async () => ({ nextCheckAt: timer.now() + 21600000, automatic: true, policy: policy(futureVersion),
      automaticResult: await readJson(join(home, 'updates/automatic-result.json'), null) }),
    apply: async () => { prepares++; throw work(); }, readiness: async () => { probes++; throw work(); },
  });
  t.after(stop);
  await timer.tick(); assert.equal(prepares, 1); assert.equal(timer.delay(), 600000);
  await timer.tick(); assert.equal(prepares, 1); assert.equal(probes, 1);
  assert.equal((await updateStatus(home)).automaticResult.code, 'remote_work_active');
});

test('macOS prepared authorization state is retained without repeated preparation', async t => {
  const home = await temporary(t), timer = clock(); let prepares = 0;
  const stop = startUpdateChecks(home, () => {}, () => true, { ...timer,
    check: async () => ({ nextCheckAt: timer.now() + 21600000, automatic: true, policy: policy(futureVersion),
      automaticResult: await readJson(join(home, 'updates/automatic-result.json'), null) }),
    apply: async () => { prepares++; return { ready: true, requiresAuthorization: true }; },
  });
  t.after(stop);
  await timer.tick(); await timer.tick();
  assert.equal(prepares, 1); assert.equal((await updateStatus(home)).automaticResult.requiresAuthorization, true);
});

test('stopping checks aborts their request and neither writes a false failure nor schedules another wake', async t => {
  const home = await temporary(t), timer = clock(), entered = deferred();
  const stop = startUpdateChecks(home, () => assert.fail('Stopped scheduler must not refresh UI'), () => true, { ...timer,
    check: async (_home, { signal }) => {
      entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  const running = timer.tick(); await entered.promise; stop(); await running;
  assert.equal(timer.delay(), undefined);
  assert.equal(await readJson(join(home, 'updates/automatic-result.json'), null), null);
});

test('apply lock spans the asynchronous handoff and does not conflict with check/GC lock identity', async t => {
  const home = await temporary(t), options = await applyOptions(home), entered = deferred(), finish = deferred();
  const applying = applyUpdate(home, { ...options, handoff: async () => { entered.resolve(); await finish.promise; return { handedOff: true }; } });
  await entered.promise;
  try {
    const checked = await checkForUpdates(home, { fetcher: async () => Response.json(policy()) });
    assert.equal(checked.error, null);
    await assert.rejects(applyUpdate(home, options), { code: 'ELOCKED' });
  } finally { finish.resolve(); await applying; }
});

test('a stale result from another attempt cannot authorize a duplicate installer', async t => {
  const home = await temporary(t), options = await applyOptions(home);
  await atomicJson(join(home, 'updates/attempt.json'), { version: futureVersion, startedAt: Date.now(), attemptId: 'new-attempt' });
  await atomicJson(join(home, 'updates/result.json'), { version: futureVersion, exitCode: 0, attemptId: 'old-attempt' });
  await assert.rejects(applyUpdate(home, { ...options, handoff: () => assert.fail('Duplicate installer') }), { code: 'installer_pending' });
});

test('existing attempt facts project installing, failure and successful new-startup restoration', async t => {
  const home = await temporary(t), directory = join(home, 'updates'); await mkdir(directory);
  await atomicJson(join(directory, 'attempt.json'), { version: futureVersion, startedAt: Date.now(), attemptId: 'pending', phase: 'installing' });
  assert.deepEqual((await updateStatus(home)).installation.status, 'installing');
  await atomicJson(join(directory, 'result.json'), { version: futureVersion, attemptId: 'pending', exitCode: 7 });
  assert.deepEqual((await updateStatus(home)).installation.status, 'failed');
  await atomicJson(join(directory, 'attempt.json'), { version: RELEASE_VERSION, sourceVersion: '0.2.4',
    startedAt: Date.now(), attemptId: 'restarted', phase: 'installing' });
  await rm(join(directory, 'result.json'));
  const restored = await updateStatus(home);
  assert.equal(restored.installation.status, 'installed');
  assert.equal((await readJson(join(directory, 'attempt.json'), null)).attemptId, 'restarted', 'Status projection is read-only');
});

test('same-version repair is explicit, signed, and cannot become an automatic downgrade', async t => {
  const home = await temporary(t), options = await applyOptions(home, RELEASE_VERSION); let calls = 0;
  const handoff = async (_file, version, _home, _root, { attemptId }) => {
    calls++; assert.equal(version, RELEASE_VERSION); assert.match(attemptId, /^[a-f0-9-]{36}$/); return { handedOff: true };
  };
  assert.equal((await applyUpdate(home, { ...options, handoff })).changed, false);
  await assert.rejects(applyUpdate(home, { ...options, repair: true, automatic: true, handoff }), /explicit user/);
  assert.equal((await applyUpdate(home, { ...options, repair: true, handoff })).handedOff, true);
  assert.equal(calls, 1);
});

test('a proven already-running historical target does not block the next exact upgrade', async t => {
  const home = await temporary(t), options = await applyOptions(home); let handoffs = 0;
  await atomicJson(join(home, 'updates/attempt.json'), { version: RELEASE_VERSION, sourceVersion: '0.2.4',
    startedAt: Date.now(), attemptId: 'previous-upgrade', phase: 'installing' });
  const result = await applyUpdate(home, { ...options, confirmedVersion: futureVersion,
    handoff: async (_file, version) => { handoffs++; return { handedOff: true, version }; } });
  assert.equal(result.version, futureVersion); assert.equal(handoffs, 1);
  assert.equal((await readJson(join(home, 'updates/attempt.json'))).version, futureVersion);
});

test('server Retry-After controls background retry within a bounded day, not an unbounded freeze', async t => {
  const home = await temporary(t), now = Date.now();
  const result = await checkForUpdates(home, { now, fetcher: async () => new Response(null, {
    status: 429, headers: { 'Retry-After': '7200' },
  }) });
  assert.equal(result.nextCheckAt, now + 7200000); assert.ok(result.error);
  await assert.rejects(boundedJson(new Response(null, { status: 503, headers: { 'Retry-After': '999999999' } })),
    error => error.retryAfterMs === 86400000);
  await assert.rejects(boundedJson(new Response(null, { status: 503, headers: { 'Retry-After': 'invalid' } })),
    error => error.retryAfterMs === 0);
});

test('the existing inventory check sends a sanitized snapshot without adding a heartbeat', async t => {
  const home = await temporary(t), now = Date.now(), requests = [];
  await atomicJson(join(home, 'state.json'), { schema: 1, deviceId: 'fixture', keyId: 'key', bindingId: 'binding',
    deviceSecret: 'a'.repeat(43), ownerToken: 'b'.repeat(43), accessKey: `tds_${'c'.repeat(43)}`,
    gateway: 'https://team.example.test', currentProjectRoot: home, remoteAccess: 'suspended',
    ports: { devspace: 47000, bridge: 47001, metrics: 47002 } });
  await atomicJson(join(home, 'updates/automatic-result.json'), { version: futureVersion, deferred: true,
    code: 'remote_work_active', message: 'private local diagnostic' });
  const fetcher = async (url, options) => {
    requests.push({ url, body: options?.body && JSON.parse(options.body) });
    return Response.json(url.endsWith('/v1/update-policy') ? policy(futureVersion) : { reported: true });
  };
  assert.equal((await checkForUpdates(home, { now, fetcher })).inventoryReported, true);
  await checkForUpdates(home, { now: now + 10000, fetcher });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.updateReport, { targetVersion: futureVersion, status: 'deferred', code: 'remote_work_active' });
  const body = JSON.stringify(requests[1].body);
  assert.equal(body.includes('private'), false); assert.equal(body.includes('tds_'), false); assert.equal(body.includes(home), false);
});

test('update cache GC preserves current/approved/in-flight packages and never follows links or removes unknown files', async t => {
  const home = await temporary(t), directory = join(home, 'updates'); await mkdir(directory);
  const versions = ['0.1.0', '0.2.2', '0.2.3', RELEASE_VERSION, futureVersion];
  for (const version of versions) {
    await mkdir(join(directory, version));
    await writeFile(join(directory, version, packageName(version, 'win32-x64')), 'cached');
  }
  const old = join(directory, '0.1.0'), oldName = packageName('0.1.0', 'win32-x64');
  await writeFile(join(old, 'operator-notes.txt'), 'retain');
  const partial = join(old, `${oldName}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.part`);
  await writeFile(partial, 'partial'); await utimes(partial, 0, 0);
  const currentPartial = join(directory, RELEASE_VERSION, `${packageName(RELEASE_VERSION, 'win32-x64')}.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.part`);
  await writeFile(currentPartial, 'interrupted old download'); await utimes(currentPartial, 0, 0);
  const outside = join(home, 'outside'); await mkdir(outside);
  await writeFile(join(outside, packageName('0.0.1', 'win32-x64')), 'retain');
  await symlink(outside, join(directory, '0.0.1'), process.platform === 'win32' ? 'junction' : 'dir');
  await atomicJson(join(directory, 'attempt.json'), { version: '0.2.2' });
  await atomicJson(join(directory, 'install-request.json'), { version: '0.2.3' });
  const unlock = await lockfile.lock(join(directory, '.apply'), { realpath: false, lockfilePath: join(directory, '.apply.lock') });
  await pruneUpdateCache(home, policy(futureVersion));
  assert.equal(await readFile(join(old, oldName), 'utf8'), 'cached'); await unlock();
  await pruneUpdateCache(home, policy(futureVersion));
  assert.deepEqual(await readdir(old), ['operator-notes.txt']);
  await assert.rejects(readFile(currentPartial), { code: 'ENOENT' });
  for (const version of versions.slice(1)) assert.equal(await readFile(join(directory, version, packageName(version, 'win32-x64')), 'utf8'), 'cached');
  assert.equal(await readFile(join(outside, packageName('0.0.1', 'win32-x64')), 'utf8'), 'retain');
});
