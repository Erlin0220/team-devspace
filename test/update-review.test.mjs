import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson, RELEASE_VERSION } from '../client/state.mjs';
import { applyUpdate, checkForUpdates, startUpdateChecks } from '../client/updates.mjs';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { updateTestCatalog, updateTestBytes, updateTestPublicKey, signUpdateFixture } from './update-fixture.mjs';

const parts = RELEASE_VERSION.split('.').map(Number);
const nextVersion = [...parts.slice(0, 2), parts[2] + 1].join('.');
const laterVersion = [...parts.slice(0, 2), parts[2] + 2].join('.');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'tds-update-review-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}

test('an initial or post-upgrade check failure preserves retry backoff across restarts', async t => {
  for (const oldVersion of [null, '0.2.3']) {
    const home = await temporary(t), now = Date.now(); let requests = 0;
    if (oldVersion) await atomicJson(join(home, 'updates/check.json'), { currentVersion: oldVersion });
    const fetcher = async () => { requests++; throw new Error('offline'); };
    await checkForUpdates(home, { now, fetcher });
    await checkForUpdates(home, { now: now + 30000, fetcher });
    assert.equal(requests, 1, 'A restarted controller must respect the saved failure deadline');
    assert.equal((await readJson(join(home, 'updates/check.json'))).currentVersion, RELEASE_VERSION);
  }
});

test('automatic handoff records the actual target, not a stale cached auto version', async t => {
  const home = await temporary(t), now = Date.now(); let next;
  const stop = startUpdateChecks(home, () => {}, () => true, {
    now: () => now, schedule: callback => { next = callback; return {}; }, cancel: () => {},
    check: async () => ({ nextCheckAt: now + 21600000, automatic: true,
      policy: { stable: nextVersion, auto: nextVersion } }),
    apply: async () => ({ handedOff: true, version: laterVersion }),
  });
  t.after(stop);
  await next();
  assert.equal((await readJson(join(home, 'updates/automatic-result.json'))).version, laterVersion);
});

test('a pending installer rejects duplicate apply before network reads or package hashing', async t => {
  const home = await temporary(t); let requests = 0;
  await atomicJson(join(home, 'updates/attempt.json'), { version: '0.2.6', startedAt: Date.now(), attemptId: 'current-attempt' });
  await atomicJson(join(home, 'updates/result.json'), { version: '0.2.6', exitCode: 0, attemptId: 'stale-attempt' });
  await assert.rejects(applyUpdate(home, {
    fetcher: async () => { requests++; throw new Error('Network must not be needed to detect an in-flight installer'); },
    handoff: () => assert.fail('Duplicate installer'),
  }), { code: 'installer_pending' });
  assert.equal(requests, 0);
});

test('an apply failure carries the actual fresh target for scheduler inventory', async t => {
  const home = await temporary(t), version = laterVersion;
  const catalog = await signUpdateFixture(updateTestCatalog(version));
  await assert.rejects(applyUpdate(home, { automatic: true, publicKey: updateTestPublicKey,
    distributionRoot: async () => { throw new Error('Synthetic preparation failure'); },
    fetcher: async url => url.endsWith('/v1/update-policy') ? Response.json({ schema: 1,
      stable: version, auto: version, minimumSupported: null, enforceAfter: null, revision: 1 })
      : url.endsWith('/update.json') ? Response.json(catalog) : new Response(updateTestBytes),
    handoff: async () => assert.fail('Preparation failed before any native handoff'),
  }), error => error.version === version && error.message === 'Synthetic preparation failure');
});

test('closing the shared controller aborts a manual update check without saving a false failure', async t => {
  const home = await temporary(t), entered = deferred(), finish = deferred(); let requestSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requestSignal = signal; entered.resolve();
    await Promise.race([finish.promise, new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
    return Response.json({ schema: 1, stable: RELEASE_VERSION, auto: null, minimumSupported: null, enforceAfter: null, revision: 0 });
  });
  const controller = createDesktopController(home);
  const pending = controller.dispatch('update-check').catch(error => error);
  await entered.promise;
  const disposing = controller.dispose();
  try { assert.equal(requestSignal.aborted, true, 'Manual checks must receive the controller cancellation signal'); }
  finally { finish.resolve(); await disposing; await pending; }
  assert.equal(await readJson(join(home, 'updates/check.json'), null), null);
});
