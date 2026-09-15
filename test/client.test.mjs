import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { approvedProjectRoot, atomicJson, loadState, normalizeGateway, randomSecret, readJson, upstreamEnvironment } from '../client/state.mjs';
import { changeProjectRoot, configureDevice, configureFromDesktop, deviceStatus, replaceAccessKey, requestFromFile } from '../client/setup.mjs';
import { trayState } from '../client/tray.mjs';
import { createAccessKey } from '../client/admin.mjs';
import { launchAgentXml, removeWindowsTask, systemdUserUnit, waitForMacJobsUnloaded, windowsTaskXml, serviceLabel, windowsTaskNames } from '../client/platform.mjs';
import { diagnosticReport, localPauseServiceAction, openLogs, resumeRemoteAccess, rollbackResumeFailure, stopTeamDevSpace, suspendRemoteAccess } from '../client/control.mjs';
import release from '../release.config.json' with { type: 'json' };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-client-'));
  const project = join(home, 'project');
  await mkdir(project);
  const requests = [];
  const adminKeys = new Map();
  const adminTombstones = new Set();
  const bindingId = randomUUID();
  const keyId = randomUUID();
  const flags = { reject: false, deviceState: 'active', releaseDisabled: false };
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = body ? JSON.parse(body) : null;
    requests.push({ path: request.url, method: request.method, body: data, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/admin/keys' && request.method === 'GET') {
      response.end(JSON.stringify({ keys: [...adminKeys.values()] })); return;
    }
    if (request.url === '/v1/admin/keys' && request.method === 'POST') {
      if (adminTombstones.has(data.id)) {
        response.writeHead(409); response.end(JSON.stringify({ error: 'deleted_key_id_cannot_be_reused' })); return;
      }
      const existingById = adminKeys.get(data.id);
      const existingByLabel = [...adminKeys.values()].find(item => item.label === data.label);
      if (existingById && existingById.keyHash !== data.keyHash || existingByLabel && existingByLabel.id !== data.id) {
        response.writeHead(409); response.end(JSON.stringify({ error: 'key_label_or_id_conflict' })); return;
      }
      const row = existingById ?? { id: data.id, label: data.label, keyHash: data.keyHash, state: 'issued' };
      adminKeys.set(row.id, row);
      if (flags.adminLoseCreateResponse) {
        flags.adminLoseCreateResponse = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(201); response.end(JSON.stringify({ id: row.id, label: row.label, state: row.state })); return;
    }
    if (flags.reject) { response.writeHead(503); response.end(JSON.stringify({ error: 'temporary_failure' })); return; }
    if (request.url === '/v1/device/status-v2') {
      response.end(JSON.stringify({ state: flags.deviceState, bindingId })); return;
    }
    if (request.url === '/v1/enrollment/preflight') {
      if (flags.preflightMissing) { response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' })); return; }
      response.end(JSON.stringify({ available: !flags.preflightUnavailable })); return;
    }
    if (request.url === '/v1/device/release') {
      if (flags.releaseDisabled) { response.writeHead(403); response.end(JSON.stringify({ error: 'device_disabled' })); return; }
      response.end(JSON.stringify({ released: true })); return;
    }
    if (flags.beforeEnrollmentResponse) await flags.beforeEnrollmentResponse();
    if (flags.loseEnrollmentResponse) {
      flags.loseEnrollmentResponse = false;
      flags.preflightUnavailable = true; // The Gateway committed the binding before the response was lost.
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify({ keyId, bindingId, deviceId: data.deviceId, state: flags.deviceState,
      tunnelToken: 'fixture-not-a-real-tunnel-token', hostname: 'tds-fixture.example.test',
      endpoint: `http://127.0.0.1:${server.address().port}/mcp`, devspaceVersion: release.devspaceVersion,
      controlApiVersion: release.controlApiVersion }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  return { home, project, requests, flags, adminKeys, adminTombstones,
    gateway: `http://127.0.0.1:${server.address().port}`, bindingId, keyId };
}

test('CLI direct entry still runs through a Unix symlink', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'team-devspace-cli-symlink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, 'team-devspace-cli.mjs');
  await symlink(join(process.cwd(), 'client', 'cli.mjs'), link);
  const { stdout } = await promisify(execFile)(process.execPath, [link, '--help'], { timeout: 30000 });
  assert.match(stdout, /Team DevSpace/);
});

test('installation retry/repair preserves identity, key, current project and upstream state outside the package', async t => {
  const f = await fixture(t);
  const accessKey = `tds_${randomSecret()}`;
  const input = { gateway: f.gateway, accessKey, roots: [f.project] };
  f.flags.reject = true;
  await assert.rejects(configureDevice(input, { home: f.home, startup: false }), /temporary_failure/);
  const pending = await loadState(f.home);
  assert.ok(pending.deviceId);
  f.flags.reject = false;
  const ready = await configureDevice(input, { home: f.home, startup: false });
  const state = await loadState(f.home);
  assert.equal(state.deviceId, pending.deviceId);
  assert.equal(state.deviceSecret, pending.deviceSecret);
  assert.equal(state.ownerToken, pending.ownerToken);
  assert.equal(ready.bindingId, f.bindingId);
  const enrollmentRequests = f.requests.length;
  const repaired = await configureDevice({}, { home: f.home, startup: false });
  assert.equal(f.requests.length, enrollmentRequests, 'Existing Enrollment must be reused without another Gateway call');
  assert.equal(repaired.reusedEnrollment, true);
  assert.equal(repaired.deviceId, ready.deviceId);
  assert.equal(repaired.currentProjectRoot, ready.currentProjectRoot);
  await rm(join(f.home, 'tunnel.token'));
  const recovered = await configureDevice({}, { home: f.home, startup: false });
  assert.equal(f.requests.length, enrollmentRequests + 1, 'Missing Tunnel credential must trigger one idempotent Enrollment repair');
  assert.equal(recovered.bindingId, ready.bindingId);
  const config = await readJson(join(f.home, 'devspace', 'config.json'));
  assert.equal(config.stateDir, join(f.home, 'upstream-state'));
  assert.equal(config.subagents.enabled, false);
  assert.deepEqual(config.subagents.providers, []);
  assert.equal(config.host, '127.0.0.1');
  assert.ok(!JSON.stringify(ready).includes(accessKey));
  assert.ok(f.requests.every(request => request.body.deviceSecret === pending.deviceSecret));
  await assert.rejects(configureDevice({ ...input, accessKey: `tds_${randomSecret()}` }, { home: f.home, startup: false }), /already belongs/);
  assert.equal((await loadState(f.home)).accessKey, accessKey);
});

test('pending Enrollment can replace a bad Access Key without losing the local identity or current project', async t => {
  const f = await fixture(t);
  const badKey = `tds_${randomSecret()}`;
  const goodKey = `tds_${randomSecret()}`;
  const input = { gateway: f.gateway, accessKey: badKey, roots: [f.project] };
  f.flags.reject = true;
  await assert.rejects(configureDevice(input, { home: f.home, startup: false }), /temporary_failure/);
  const pending = await loadState(f.home);
  assert.equal(pending.bindingId, undefined);
  f.flags.reject = false;
  const completed = await configureDevice({ ...input, accessKey: goodKey }, { home: f.home, startup: false });
  const state = await loadState(f.home);
  assert.equal(completed.bindingId, f.bindingId);
  assert.equal(state.accessKey, goodKey);
  assert.equal(state.deviceId, pending.deviceId);
  assert.equal(state.deviceSecret, pending.deviceSecret);
  assert.equal(state.ownerToken, pending.ownerToken);
  assert.equal(state.currentProjectRoot, pending.currentProjectRoot);
});

test('reinstall preserves an explicit suspended policy instead of reopening access from observed Gateway state', async t => {
  const f = await fixture(t);
  const input = { gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] };
  await configureDevice(input, { home: f.home, startup: false });
  const state = await loadState(f.home);
  await atomicJson(join(f.home, 'state.json'), { ...state, remoteAccess: 'suspended' });
  const requestsBefore = f.requests.length;
  const preserved = await configureDevice({}, { home: f.home, startup: false });
  assert.equal(preserved.remoteAccess, 'suspended');
  assert.equal((await loadState(f.home)).remoteAccess, 'suspended');
  assert.equal(f.requests.length, requestsBefore, 'Repair must not contact the Gateway just to override an explicit local pause');
});

test('missing Tunnel credential recovery must retain an explicit pause even when the Gateway is active', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  await atomicJson(join(f.home, 'state.json'), { ...before, remoteAccess: 'suspended' });
  await rm(join(f.home, 'tunnel.token'));
  const repaired = await configureDevice({}, { home: f.home, startup: false });
  assert.equal(repaired.remoteAccess, 'suspended');
  const after = await loadState(f.home);
  assert.equal(after.remoteAccess, 'suspended');
  assert.equal(after.bindingId, before.bindingId);
  assert.equal(after.deviceSecret, before.deviceSecret);
  assert.ok((await readFile(join(f.home, 'tunnel.token'), 'utf8')).trim());
});

test('lost key-replacement response remains repairable from the tray using the same device identity', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  const replacementKey = `tds_${randomSecret()}`;
  f.flags.loseEnrollmentResponse = true;
  await assert.rejects(replaceAccessKey(replacementKey, f.home, { startup: false }), /gateway_unreachable/);
  const status = await deviceStatus(f.home);
  assert.equal(status.remoteAccess, 'not-enrolled');
  assert.equal(trayState(status).repairEnabled, true, 'Pending Enrollment must expose a working recovery action');
  const callsBeforeRetry = f.requests.length;
  const recovered = await replaceAccessKey(replacementKey, f.home, { startup: false });
  assert.equal(recovered.recoveredEnrollment, true);
  assert.deepEqual(f.requests.slice(callsBeforeRetry).map(request => request.path), ['/v1/enroll'],
    'Retry must not reject its already-bound key or release a second binding');
  const after = await loadState(f.home);
  assert.equal(after.accessKey, replacementKey);
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.deviceSecret, before.deviceSecret);
  assert.equal(after.ownerToken, before.ownerToken);
  assert.equal(after.currentProjectRoot, before.currentProjectRoot);
});

test('a pause requested during credential repair must not be overwritten by an older enrollment response', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  await rm(join(f.home, 'tunnel.token'));
  let entered;
  let respond;
  let pauseReachedGateway;
  const enrollmentEntered = new Promise(resolve => { entered = resolve; });
  const responseGate = new Promise(resolve => { respond = resolve; });
  const pausePersisted = new Promise(resolve => { pauseReachedGateway = resolve; });
  t.after(() => respond());
  f.flags.beforeEnrollmentResponse = async () => { entered(); await responseGate; };
  const repairing = configureDevice({}, { home: f.home, startup: false });
  await enrollmentEntered;
  const pausing = suspendRemoteAccess(f.home, {
    deactivateRemoteStartup: async () => {},
    control: async () => { pauseReachedGateway(); },
  });
  // Without a shared operation owner, pause commits while enrollment still has
  // an old active snapshot. With one, pause safely runs after repair releases it.
  await Promise.race([pausePersisted, sleep(500)]);
  respond();
  await Promise.all([repairing, pausing]);
  assert.equal((await loadState(f.home)).remoteAccess, 'suspended');
});

test('current project can change while paused without starting runtime or touching Tunnel', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
    { home: f.home, startup: false });
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  const nextRoot = join(f.home, 'second-project');
  await mkdir(nextRoot);
  let serviceCalls = 0;
  const result = await changeProjectRoot(nextRoot, f.home, {
    serviceAction: async () => { serviceCalls++; },
  });
  const state = await loadState(f.home);
  assert.equal(state.remoteAccess, 'suspended');
  assert.equal(state.currentProjectRoot, await realpath(nextRoot));
  assert.equal(result.currentProjectRoot, state.currentProjectRoot);
  assert.equal(result.reconnectRequired, false);
  assert.equal(serviceCalls, 0);
  assert.deepEqual((await readJson(join(f.home, 'devspace', 'config.json'))).allowedRoots, [state.currentProjectRoot]);
});

test('Access Key replacement validates first, preserves local identity and current project, then re-enrolls without reinstalling', async t => {
  const f = await fixture(t);
  const originalKey = `tds_${randomSecret()}`;
  const replacementKey = `tds_${randomSecret()}`;
  await configureDevice({ gateway: f.gateway, accessKey: originalKey, roots: [f.project] }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  const result = await replaceAccessKey(replacementKey, f.home, { startup: false });
  const after = await loadState(f.home);
  assert.equal(result.replacedAccessKey, true);
  assert.equal(after.accessKey, replacementKey);
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.deviceSecret, before.deviceSecret);
  assert.equal(after.ownerToken, before.ownerToken);
  assert.equal(after.currentProjectRoot, before.currentProjectRoot);
  assert.equal(after.pendingAccessKey, undefined);
  const replacementRequests = f.requests.slice(-3).map(request => request.path);
  assert.deepEqual(replacementRequests, ['/v1/enrollment/preflight', '/v1/device/release', '/v1/enroll']);
});

test('Admin Reset allows the same Access Key to re-enroll the retained local Device identity', async t => {
  const f = await fixture(t);
  const accessKey = `tds_${randomSecret()}`;
  await configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: f.project }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  f.flags.releaseDisabled = true; // The administrator already removed the old server binding.
  const result = await replaceAccessKey(accessKey, f.home, { startup: false });
  const after = await loadState(f.home);
  assert.equal(result.replacedAccessKey, true);
  assert.equal(after.accessKey, accessKey);
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.deviceSecret, before.deviceSecret);
  assert.equal(after.ownerToken, before.ownerToken);
  assert.equal(after.currentProjectRoot, before.currentProjectRoot);
  assert.deepEqual(f.requests.slice(-3).map(request => request.path),
    ['/v1/enrollment/preflight', '/v1/device/release', '/v1/enroll']);
});

test('Admin Reset plus the same Access Key preserves an explicit local pause', async t => {
  const f = await fixture(t);
  const accessKey = `tds_${randomSecret()}`;
  await configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: f.project }, { home: f.home, startup: false });
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  f.flags.releaseDisabled = true;
  const result = await replaceAccessKey(accessKey, f.home, { startup: false });
  const after = await loadState(f.home);
  assert.equal(result.remoteAccess, 'suspended');
  assert.equal(after.remoteAccess, 'suspended');
});

test('changing to a different Access Key preserves explicit pause, identity and project', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
    { home: f.home, startup: false });
  const before = await loadState(f.home);
  await atomicJson(join(f.home, 'state.json'), { ...before, remoteAccess: 'suspended' });
  const replacement = `tds_${randomSecret()}`;
  const result = await replaceAccessKey(replacement, f.home, { startup: false });
  const after = await loadState(f.home);
  assert.equal(result.remoteAccess, 'suspended');
  assert.equal(after.remoteAccess, 'suspended');
  assert.equal(after.accessKey, replacement);
  for (const field of ['deviceId', 'deviceSecret', 'ownerToken', 'currentProjectRoot']) assert.equal(after[field], before[field]);
  assert.equal(f.requests.some(request => request.path === '/v1/device/resume'), false);
});

test('same Access Key still bound on the server gives an explicit Admin Reset next step', async t => {
  const f = await fixture(t);
  const accessKey = `tds_${randomSecret()}`;
  await configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: f.project }, { home: f.home, startup: false });
  f.flags.preflightUnavailable = true;
  const requestsBefore = f.requests.length;
  await assert.rejects(replaceAccessKey(accessKey, f.home, { startup: false }), error =>
    error.code === 'access_key_still_bound' && /重置设备绑定/.test(error.message));
  assert.deepEqual(f.requests.slice(requestsBefore).map(request => request.path), ['/v1/enrollment/preflight']);
});

test('project change rolls back state/config and restarts the previous root when new runtime validation fails', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
    { home: f.home, startup: false });
  const before = await loadState(f.home);
  const nextRoot = join(f.home, 'broken-project');
  await mkdir(nextRoot);
  const events = [];
  await assert.rejects(changeProjectRoot(nextRoot, f.home, {
    serviceAction: async (action, state) => { events.push(`${action}:${state.currentProjectRoot}`); },
    verifyRuntime: async state => {
      if (state.currentProjectRoot === await realpath(nextRoot)) throw new Error('new runtime failed');
    },
  }), error => error.code === 'project_root_change_failed' && /已恢复原目录/.test(error.message));
  const after = await loadState(f.home);
  assert.equal(after.currentProjectRoot, before.currentProjectRoot);
  assert.deepEqual((await readJson(join(f.home, 'devspace', 'config.json'))).allowedRoots, [before.currentProjectRoot]);
  assert.deepEqual(events.map(event => event.split(':', 1)[0]), ['stop', 'start', 'stop', 'start']);
});

test('project change restores the previous runtime even when the initial stop reports a partial failure', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
    { home: f.home, startup: false });
  const before = await loadState(f.home);
  const nextRoot = join(f.home, 'next-project');
  await mkdir(nextRoot);
  const events = [];
  let firstStop = true;
  await assert.rejects(changeProjectRoot(nextRoot, f.home, {
    serviceAction: async (action, state) => {
      events.push(`${action}:${state.currentProjectRoot}`);
      if (action === 'stop' && firstStop) { firstStop = false; throw new Error('partial stop failure'); }
    },
    verifyRuntime: async () => {},
  }), error => error.code === 'project_root_change_failed' && /已恢复原目录/.test(error.message));
  const after = await loadState(f.home);
  assert.equal(after.currentProjectRoot, before.currentProjectRoot);
  assert.deepEqual((await readJson(join(f.home, 'devspace', 'config.json'))).allowedRoots, [before.currentProjectRoot]);
  assert.deepEqual(events.map(event => event.split(':', 1)[0]), ['stop', 'stop', 'start']);
});

test('missing Gateway key-switch capability produces actionable feedback without mutating existing identity', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  f.flags.preflightMissing = true;
  await assert.rejects(replaceAccessKey(`tds_${randomSecret()}`, f.home, { startup: false }), { code: 'gateway_update_required' });
  assert.deepEqual(await loadState(f.home), before);
  assert.equal(f.requests.some(request => request.path === '/v1/device/release'), false);
});

test('resume releases the local pause only behind a suspended Gateway, before starting runtime', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  const events = [];
  let gateway = 'active';
  const result = await resumeRemoteAccess(f.home, {
    control: async (_gateway, path) => {
      events.push(path);
      if (path.endsWith('/suspend')) { assert.equal((await loadState(f.home)).remoteAccess, 'suspended'); gateway = 'suspended'; }
      if (path.endsWith('/resume')) gateway = 'active';
    },
    installServices: async () => { events.push('install'); assert.equal(gateway, 'suspended'); },
    serviceAction: async action => {
      events.push(action);
      assert.equal((await loadState(f.home)).remoteAccess, 'active', 'The real runtime reads this persisted value on startup');
      assert.equal(gateway, 'suspended', 'External access must remain closed while the runtime starts');
    },
    deviceStatus: async () => ({ localReady: true, ready: gateway === 'active', gateway }),
  });
  assert.deepEqual(events, process.platform === 'linux'
    ? ['/v1/device/suspend', 'install', 'start', '/v1/device/resume']
    : process.platform === 'win32'
      ? ['/v1/device/suspend', 'enable', 'start', '/v1/device/resume']
      : ['/v1/device/suspend', 'start', '/v1/device/resume']);
  assert.equal(result.ready, true);
});

test('desktop resume recreates startup entries only when the retained entry is missing',
  { skip: process.platform === 'linux' }, async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  const events = [];
  let gateway = 'active';
  let starts = 0;
  const result = await resumeRemoteAccess(f.home, {
    control: async (_gateway, path) => {
      events.push(path);
      if (path.endsWith('/suspend')) gateway = 'suspended';
      if (path.endsWith('/resume')) gateway = 'active';
    },
    installServices: async () => { events.push('install'); },
    serviceAction: async action => {
      events.push(action);
      if (action === 'start' && starts++ === 0) throw new Error('startup entry missing');
    },
    deviceStatus: async () => ({ localReady: starts > 1, ready: gateway === 'active' && starts > 1, gateway }),
  });
  assert.deepEqual(events, process.platform === 'win32'
    ? ['/v1/device/suspend', 'enable', 'start', 'install', 'start', '/v1/device/resume']
    : ['/v1/device/suspend', 'start', 'install', 'start', '/v1/device/resume']);
  assert.equal(result.ready, true);
});

test('failed resume restores persisted pause before local cleanup', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] }, { home: f.home, startup: false });
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  let stopped = false;
  let reopened = false;
  await assert.rejects(resumeRemoteAccess(f.home, {
    control: async (_gateway, path) => { if (path.endsWith('/resume')) reopened = true; },
    installServices: async () => {},
    serviceAction: async action => {
      if (action === 'start') throw new Error('test startup failure');
      assert.equal((await loadState(f.home)).remoteAccess, 'suspended');
      stopped = true;
    },
  }), /test startup failure/);
  assert.equal(stopped, true);
  assert.equal(reopened, false);
  assert.equal((await loadState(f.home)).remoteAccess, 'suspended');
});

test('administrator issuance can be retried without losing the original employee credential', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  const output = join(f.home, 'employee-key.json');
  f.flags.adminLoseCreateResponse = true;
  await assert.rejects(createAccessKey(config, 'Employee A', output), /gateway_unreachable/);
  const failed = f.requests.findLast(request => request.path === '/v1/admin/keys' && request.body)?.body;
  const issued = await createAccessKey(config, 'Employee A', output);
  const saved = await readJson(output);
  assert.equal(issued.id, failed.id);
  const retry = f.requests.findLast(request => request.path === '/v1/admin/keys' && request.body)?.body;
  assert.equal(retry.keyHash, failed.keyHash);
  assert.ok(saved.accessKey.startsWith('tds_'));
  assert.ok(!JSON.stringify(issued).includes(saved.accessKey));
  assert.ok(!JSON.stringify(retry).includes(saved.accessKey));
  const outside = join(f.home, '..', `team-devspace-unsafe-export-${randomUUID()}.json`);
  await assert.rejects(createAccessKey(config, 'Employee A', outside), /private administrator configuration directory/);
  await assert.rejects(access(outside), { code: 'ENOENT' });
});

test('administrator issuance never resurrects a locally cached credential after the server record was deleted', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  const first = await createAccessKey(config, 'Reusable employee');
  assert.equal(f.adminKeys.delete(first.id), true);
  const second = await createAccessKey(config, 'Reusable employee');
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.accessKey, first.accessKey);
  assert.equal(f.adminKeys.has(first.id), false);
  assert.equal(f.adminKeys.has(second.id), true);

  const cache = join(config.directory, 'issued-keys', `${createHash('sha256').update('Reusable employee').digest('hex')}.json`);
  const record = await readJson(cache);
  assert.equal(record.id, second.id);
  assert.equal(record.confirmed, true);
});

test('administrator issuance rotates an unconfirmed cached credential when the server tombstone proves it was deleted', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  f.flags.adminLoseCreateResponse = true;
  await assert.rejects(createAccessKey(config, 'Lost then deleted'), /gateway_unreachable/);
  const [oldId, oldRow] = [...f.adminKeys.entries()][0];
  assert.ok(oldRow);
  f.adminKeys.delete(oldId);
  f.adminTombstones.add(oldId);

  const replacement = await createAccessKey(config, 'Lost then deleted');
  assert.notEqual(replacement.id, oldId);
  assert.equal(f.adminKeys.has(oldId), false);
  assert.equal(f.adminKeys.has(replacement.id), true);
});

test('concurrent first-time setup publishes exactly one durable device identity', async t => {
  const f = await fixture(t);
  const input = { gateway: f.gateway, accessKey: `tds_${randomSecret()}`, roots: [f.project] };
  const [a, b] = await Promise.all([
    configureDevice(input, { home: f.home, startup: false }),
    configureDevice(input, { home: f.home, startup: false }),
  ]);
  assert.equal(a.deviceId, b.deviceId);
  const state = await loadState(f.home);
  assert.equal(state.deviceId, a.deviceId);
  assert.equal(new Set(f.requests.map(request => request.body.deviceSecret)).size, 1);
  assert.equal(new Set(f.requests.map(request => request.body.deviceId)).size, 1);
});

test('concurrent first-time setup cannot silently replace another selected project root', async t => {
  const f = await fixture(t);
  const otherProject = join(f.home, 'other-project');
  await mkdir(otherProject);
  const accessKey = `tds_${randomSecret()}`;
  const results = await Promise.allSettled([
    configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: f.project }, { home: f.home, startup: false }),
    configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: otherProject }, { home: f.home, startup: false }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(['project_root_conflict', 'project_root_change_requires_command'].includes(rejected?.reason?.code),
    `Unexpected conflict code: ${rejected?.reason?.code}`);
  assert.equal(f.requests.filter(request => request.path === '/v1/enroll').length, 1,
    'Conflicting local setup must fail before creating a second remote Enrollment request');
  const state = await loadState(f.home);
  assert.ok([await realpath(f.project), await realpath(otherProject)].includes(state.currentProjectRoot));
});

test('an enrolled device cannot bypass project-root rollback by changing the root through setup', async t => {
  const f = await fixture(t);
  const accessKey = `tds_${randomSecret()}`;
  await configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: f.project }, { home: f.home, startup: false });
  const before = await loadState(f.home);
  const otherProject = join(f.home, 'other-project');
  await mkdir(otherProject);
  await assert.rejects(
    configureDevice({ gateway: f.gateway, accessKey, currentProjectRoot: otherProject }, { home: f.home, startup: false }),
    { code: 'project_root_change_requires_command' });
  assert.equal((await loadState(f.home)).currentProjectRoot, before.currentProjectRoot);
});

test('concurrent administrator issuance reuses one persisted employee credential', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  const [a, b] = await Promise.all([
    createAccessKey(config, 'Same employee'), createAccessKey(config, 'Same employee'),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.accessKey, b.accessKey);
  // The second caller may observe an already confirmed record and legitimately
  // GET the key list first. Compare actual issuance writes, not body-less reads.
  const writes = f.requests.filter(request => request.method === 'POST' && request.path === '/v1/admin/keys');
  assert.equal(writes.length, 2);
  assert.deepEqual([...new Set(writes.map(request => request.body.keyHash))],
    [createHash('sha256').update(a.accessKey).digest('hex')]);
  assert.equal(f.adminKeys.size, 1);
});

test('setup request accepts NSIS UTF-16LE and consumes only the temporary request', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-request-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'request.json');
  const data = { accessKey: `tds_${randomSecret()}`, currentProjectRoot: 'C:\\project\\\u6d4b\u8bd5' };
  await writeFile(path, Buffer.concat([Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le')]));
  assert.deepEqual(await requestFromFile(path, true), data);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await writeFile(path, '\uFEFF' + JSON.stringify(data));
  assert.deepEqual(await requestFromFile(path, false), data);
  await access(path);
});

test('Current Project Root is one explicit existing directory; gateway origin cannot carry secrets or paths', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-project-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await approvedProjectRoot(home), await realpath(home));
  await assert.rejects(approvedProjectRoot('relative'), { code: 'project_root_invalid' });
  await assert.rejects(approvedProjectRoot(parse(home).root), { code: 'project_root_invalid' });
  await assert.rejects(approvedProjectRoot(join(home, 'missing')), { code: 'project_root_unavailable' });
  for (const value of ['http://evil.example', 'https://user:password@example.test', 'https://example.test/mcp', 'https://example.test?token=secret']) {
    assert.throws(() => normalizeGateway(value));
  }
  assert.equal(normalizeGateway('https://example.test/'), 'https://example.test');
  assert.equal(normalizeGateway('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});

test('missing Current Project Root is detected without corrupting retained Enrollment state', async t => {
  const f = await fixture(t);
  await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
    { home: f.home, startup: false });
  await rm(f.project, { recursive: true, force: true });
  const status = await deviceStatus(f.home);
  assert.equal(status.currentProjectRootAvailable, false);
  assert.equal(status.currentProjectRoot, f.project);
  assert.equal(status.ready, false);
  const presentation = trayState(status);
  assert.equal(presentation.status, 'partial');
  assert.equal(presentation.summary, 'Team DevSpace 项目目录不可用');
  assert.equal(presentation.projectRootEnabled, true, 'Missing project must keep the reselect action available');
});

test('remote pause keeps desktop startup entries and disables Windows/Linux startup without deleting them', () => {
  assert.equal(localPauseServiceAction('win32'), 'disable');
  assert.equal(localPauseServiceAction('darwin'), 'stop');
  assert.equal(localPauseServiceAction('linux'), 'disable');
});

test('Windows task removal retries a transient delete failure before surfacing an error', async () => {
  const label = 'com.teamdevspace.0123456789abcdef.tunnel';
  let deletes = 0;
  await removeWindowsTask(label, { wait: async () => {}, runNative: async (_command, args) => {
    if (args[0] === '/End') return { stdout: '' };
    if (args[0] === '/Delete') {
      deletes++;
      if (deletes === 1) throw Object.assign(new Error('transient scheduler failure'), { code: 1 });
      return { stdout: '' };
    }
    if (args[0] === '/Query') return { stdout: `"${label}","N/A","Ready"\n` };
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  } });
  assert.equal(deletes, 2);
});

test('macOS lifecycle waits for launchd to finish unregistering a stopped job before restart', async () => {
  let prints = 0;
  let waits = 0;
  await waitForMacJobsUnloaded('gui/501', ['com.teamdevspace.runtime'], {
    attempts: 4,
    wait: async () => { waits++; },
    runNative: async (command, args, allowMissing) => {
      assert.equal(command, 'launchctl');
      assert.deepEqual(args, ['print', 'gui/501/com.teamdevspace.runtime']);
      assert.equal(allowMissing, true);
      prints++;
      return prints < 3 ? { stdout: 'transitional launchd job' } : null;
    },
  });
  assert.equal(prints, 3);
  assert.equal(waits, 2);
});

test('macOS lifecycle fails closed if launchd never unregisters the stopped job', async () => {
  await assert.rejects(waitForMacJobsUnloaded('gui/501', ['com.teamdevspace.runtime'], {
    attempts: 3,
    wait: async () => {},
    runNative: async () => ({ stdout: 'still loaded' }),
  }), /launchd still owns stopped Team DevSpace jobs/);
});

test('Windows task removal never hides a persistent delete or permission failure', async () => {
  const label = 'com.teamdevspace.0123456789abcdef.tunnel';
  let deletes = 0;
  await assert.rejects(removeWindowsTask(label, { attempts: 3, wait: async () => {}, runNative: async (_command, args) => {
    if (args[0] === '/End') return { stdout: '' };
    if (args[0] === '/Delete') { deletes++; throw Object.assign(new Error('access denied'), { code: 1 }); }
    if (args[0] === '/Query') return { stdout: `"${label}","N/A","Ready"\n` };
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  } }), /access denied/);
  assert.equal(deletes, 3);
});

test('native startup configuration contains no credentials, no SYSTEM/root elevation, and supports XML-special paths', () => {
  const state = { deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(), accessKey: `tds_${randomSecret()}`,
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  const home = join(homedir(), 'Project & Notes');
  const root = join(homedir(), 'Team & DevSpace');
  const task = windowsTaskXml(state, 'runtime', home, 'S-1-5-21-123', root);
  assert.ok(task.includes('InteractiveToken'));
  assert.ok(task.includes('LeastPrivilege'));
  assert.ok(task.includes('<SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-123)</SecurityDescriptor>'));
  assert.ok(task.includes('&amp;'));
  assert.ok(task.includes('tds-launcher.exe'));
  assert.ok(task.includes('runtime.log'));
  assert.ok(!/powershell|launch\.ps1/i.test(task));
  assert.ok(!task.includes(state.deviceSecret) && !task.includes(state.accessKey));
  const tunnelTask = windowsTaskXml(state, 'tunnel', home, 'S-1-5-21-123', root);
  assert.ok(tunnelTask.includes('tds-launcher.exe') && tunnelTask.includes('cloudflared.exe'));
  assert.ok(tunnelTask.includes('--token-file') && !/powershell|launch\.ps1/i.test(tunnelTask));
  const launch = launchAgentXml(state, 'tunnel', home, { node: '/app/node', cloudflared: '/app/cloudflared' }, root);
  assert.ok(launch.includes('--token-file'));
  assert.ok(launch.includes('<key>KeepAlive</key><true/>'));
  assert.ok(!launch.includes('<key>UserName</key>'));
  assert.ok(!launch.includes(state.deviceSecret) && !launch.includes(state.accessKey));
  const systemd = systemdUserUnit(state, 'runtime', home, { node: '/old/version/node', cloudflared: '/old/version/cloudflared' },
    join(root, 'versions', 'candidate'));
  assert.equal(serviceLabel(state, 'runtime', 'linux'), 'team-devspace-runtime');
  assert.equal(serviceLabel(state, 'runtime', 'darwin'), 'com.teamdevspace.runtime');
  assert.equal(serviceLabel(state, 'runtime', 'win32'), serviceLabel({ ...state, deviceId: randomUUID() }, 'runtime', 'win32'),
    'Windows lifecycle ownership must survive a remote Device Binding identity change');
  assert.notEqual(serviceLabel(state, 'runtime', 'win32'), serviceLabel({ ...state, ownerToken: randomSecret() }, 'runtime', 'win32'),
    'Separate local owners must not share Task Scheduler entries');
  assert.ok(!serviceLabel(state, 'runtime', 'win32').includes(state.ownerToken), 'Lifecycle labels must not expose the owner credential');
  assert.ok(systemd.includes('TEAM_DEVSPACE_ACTIVE_PATH=') && systemd.includes('active-path'));
  assert.ok(systemd.includes('ExecStart=:/bin/sh -c'));
  assert.ok(systemd.includes('cd \\"$active\\"') || systemd.includes('cd "$active"'));
  assert.ok(systemd.includes('exec \\"$active/runtime/bin/node\\"') || systemd.includes('exec "$active/runtime/bin/node"'));
  assert.ok(systemd.includes('StandardOutput=journal') && systemd.includes('Restart=on-failure'));
  assert.ok(systemd.includes('StartLimitBurst=5'));
  assert.ok(!systemd.includes('WorkingDirectory='), 'systemd user services must not quote arbitrary state-home paths as WorkingDirectory');
  assert.ok(!systemd.includes('network-online.target') && !systemd.includes('append:'));
  assert.ok(!systemd.includes('/old/version/node') && !systemd.includes(state.deviceSecret) && !systemd.includes(state.accessKey));
  assert.throws(() => serviceLabel(state, 'arbitrary-process'));
});

test('Windows lifecycle discovery selects only Team DevSpace owner/device task identities', () => {
  const row = (name, status = 'Ready') => `"\\${name}","N/A","${status}"`;
  const output = [
    row('com.teamdevspace.0123456789abcdef.runtime'),
    row('com.teamdevspace.0123456789abcdef0123456789abcdef.tray', 'Running'),
    row('com.teamdevspace.not-ours.runtime'),
    row('Other.Task'),
  ].join('\r\n');
  assert.deepEqual(windowsTaskNames(output), [
    'com.teamdevspace.0123456789abcdef.runtime',
    'com.teamdevspace.0123456789abcdef0123456789abcdef.tray',
  ]);
});

test('opening logs delegates to the desktop shell without waiting for its exit code',
  { skip: process.platform === 'linux' }, async () => {
  let launched;
  const home = join(homedir(), 'TeamDevSpace');
  const directory = join(home, 'logs');
  assert.equal(await openLogs(home, {
    launch: async (command, args) => { launched = { command, args }; },
  }), directory);
  assert.equal(launched.args.at(-1), directory);
});

test('diagnostics separate desired remote access from observed Gateway state and filter proxy warning noise', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-diagnostic-'));
  const project = join(home, 'project');
  await mkdir(project);
  await mkdir(join(home, 'logs'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'state.json'), {
    schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
    accessKey: `tds_${randomSecret()}`, keyId: randomUUID(), bindingId: randomUUID(),
    gateway: 'http://127.0.0.1:1', roots: [project], remoteAccess: 'suspended',
    releaseVersion: release.version, devspaceVersion: release.devspaceVersion,
    ports: { devspace: 65110, bridge: 65111, metrics: 65112 },
  });
  await writeFile(join(home, 'logs', 'runtime.error.log'),
    '(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n(Use `node --trace-warnings ...`)\nreal failure\n');
  const report = await diagnosticReport(home);
  assert.equal(report.desiredRemoteAccess, 'suspended');
  assert.equal(report.gatewayHealth, 'unreachable');
  assert.equal('bindingState' in report, false);
  assert.deepEqual(report.recentErrors.find(entry => entry.component === 'runtime')?.lines, ['real failure']);
});

test('suspend persists fail-closed intent even when local shutdown and Gateway confirmation both fail', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-suspend-intent-'));
  const project = join(home, 'project');
  await mkdir(project);
  t.after(() => rm(home, { recursive: true, force: true }));
  await atomicJson(join(home, 'state.json'), {
    schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
    accessKey: `tds_${randomSecret()}`, keyId: randomUUID(), bindingId: randomUUID(),
    gateway: 'http://127.0.0.1:1', roots: [project], remoteAccess: 'active',
    releaseVersion: release.version, devspaceVersion: release.devspaceVersion,
    ports: { devspace: 65130, bridge: 65131, metrics: 65132 },
  });
  const calls = [];
  await assert.rejects(suspendRemoteAccess(home, {
    deactivateRemoteStartup: async () => { calls.push('local'); throw new Error('local stop failed'); },
    control: async () => { calls.push('gateway'); const error = new Error('gateway_unreachable'); error.code = 'gateway_unreachable'; throw error; },
  }), /暂停意图已保存/);
  assert.equal((await loadState(home)).remoteAccess, 'suspended');
  assert.deepEqual(calls, ['local', 'gateway']);
});

test('closing is local-only and keeps active startup policy for the next login',
  { skip: process.platform !== 'win32' }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'team-devspace-close-local-'));
    const project = join(home, 'project');
    await mkdir(project);
    t.after(() => rm(home, { recursive: true, force: true }));
    await atomicJson(join(home, 'state.json'), {
      schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
      keyId: randomUUID(), bindingId: randomUUID(), gateway: 'http://127.0.0.1:1',
      roots: [project], remoteAccess: 'active', releaseVersion: release.version, devspaceVersion: release.devspaceVersion,
      ports: { devspace: 65119, bridge: 65118, metrics: 65117 },
    });
    const result = await stopTeamDevSpace(home);
    assert.equal(result.stopped, true);
    assert.equal(result.remoteAccess, 'active');
    assert.equal(result.startupRetained, true);
    assert.equal((await loadState(home)).remoteAccess, 'active');
  });

test('closing does not change an explicit suspended policy or contact the Gateway',
  { skip: process.platform !== 'win32' }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'team-devspace-close-suspended-'));
    const project = join(home, 'project');
    await mkdir(project);
    t.after(() => rm(home, { recursive: true, force: true }));
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests++;
      response.writeHead(500);
      response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    await atomicJson(join(home, 'state.json'), {
      schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
      keyId: randomUUID(), bindingId: randomUUID(), gateway: `http://127.0.0.1:${server.address().port}`,
      roots: [project], remoteAccess: 'suspended', releaseVersion: release.version, devspaceVersion: release.devspaceVersion,
      ports: { devspace: 65120, bridge: 65121, metrics: 65122 },
    });
    const result = await stopTeamDevSpace(home);
    assert.equal(result.stopped, true);
    assert.equal(result.remoteAccess, 'suspended');
    assert.equal(result.startupRetained, true);
    assert.equal((await loadState(home)).remoteAccess, 'suspended');
    assert.equal(requests, 0);
  });

test('resume rollback reports dual failure instead of claiming local services stopped', async () => {
  const calls = [];
  await assert.rejects(rollbackResumeFailure(new Error('resume failed'),
    async () => { calls.push('gateway'); throw new Error('gateway rollback failed'); },
    async () => { calls.push('local'); throw new Error('local cleanup failed'); }),
  /neither Gateway suspension nor local service shutdown could be confirmed/);
  assert.deepEqual(calls, ['gateway', 'local']);
});

test('private upstream environment cannot inherit a personal DevSpace public URL or roots', () => {
  const old = process.env.DEVSPACE_ALLOWED_ROOTS;
  const oldUrl = process.env.DEVSPACE_PUBLIC_BASE_URL;
  try {
    process.env.DEVSPACE_ALLOWED_ROOTS = 'personal-root';
    process.env.DEVSPACE_PUBLIC_BASE_URL = 'https://personal.example';
    const env = upstreamEnvironment(join(tmpdir(), 'team-devspace-isolation'));
    assert.equal(env.DEVSPACE_ALLOWED_ROOTS, undefined);
    assert.equal(env.DEVSPACE_PUBLIC_BASE_URL, undefined);
    assert.equal(env.DEVSPACE_TOOL_MODE, 'minimal');
    assert.equal(env.DEVSPACE_WIDGETS, 'off');
    assert.equal(env.DEVSPACE_LOG_TOOL_CALLS, 'false');
  } finally {
    if (old === undefined) delete process.env.DEVSPACE_ALLOWED_ROOTS; else process.env.DEVSPACE_ALLOWED_ROOTS = old;
    if (oldUrl === undefined) delete process.env.DEVSPACE_PUBLIC_BASE_URL; else process.env.DEVSPACE_PUBLIC_BASE_URL = oldUrl;
  }
});


test('progress observer failures do not roll back a project root or resumed connection', async t => {
  const f = await fixture(t);
  const onProgress = () => { throw new Error('presentation unavailable'); };
  await configureDevice({ gateway: f.gateway, accessKey: 'tds_' + randomSecret(), currentProjectRoot: f.project },
    { home: f.home, startup: false, onProgress });
  const nextRoot = join(f.home, 'observer-project'); await mkdir(nextRoot);
  const actions = [];
  await changeProjectRoot(nextRoot, f.home, { onProgress,
    serviceAction: async action => { actions.push(action); }, verifyRuntime: async () => {} });
  assert.equal((await loadState(f.home)).currentProjectRoot, await realpath(nextRoot));
  assert.deepEqual(actions, ['stop', 'start']);
  await atomicJson(join(f.home, 'state.json'), { ...await loadState(f.home), remoteAccess: 'suspended' });
  let gateway = 'suspended';
  await resumeRemoteAccess(f.home, { onProgress, control: async (_gateway, path) => {
    if (path.endsWith('/resume')) gateway = 'active'; else if (path.endsWith('/suspend')) gateway = 'suspended';
  }, installServices: async () => {}, serviceAction: async () => {},
  deviceStatus: async () => ({ localReady: true, gateway, ready: gateway === 'active' }) });
  assert.equal(gateway, 'active'); assert.equal((await loadState(f.home)).remoteAccess, 'active');
});

test('project rollback never rewrites configuration or restarts an unresolved runtime owner', async t => {
  for (const initialStopFails of [true, false]) {
    const f = await fixture(t);
    await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
      { home: f.home, startup: false });
    const before = await loadState(f.home);
    const nextRoot = join(f.home, 'rollback-project'); await mkdir(nextRoot);
    const actions = []; let stops = 0;
    await assert.rejects(changeProjectRoot(nextRoot, f.home, {
      serviceAction: async action => {
        actions.push(action);
        if (action === 'stop' && (++stops > 1 || initialStopFails)) throw new Error('owner remains running');
      },
      verifyRuntime: async () => { throw new Error('candidate not ready'); },
    }), { code: 'project_root_rollback_failed' });
    assert.deepEqual(actions, initialStopFails ? ['stop', 'stop'] : ['stop', 'start', 'stop']);
    const expectedRoot = initialStopFails ? before.currentProjectRoot : await realpath(nextRoot);
    const after = await loadState(f.home);
    assert.equal(after.currentProjectRoot, expectedRoot, 'Do not replace facts while an unresolved owner may still use them');
    assert.deepEqual((await readJson(join(f.home, 'devspace', 'config.json'))).allowedRoots, [expectedRoot]);
    assert.equal(after.deviceId, before.deviceId); assert.equal(after.bindingId, before.bindingId);
  }
});

test('project rollback cannot start a runtime until both original configuration and state are restored', async t => {
  for (const failingWrite of ['writeUpstreamConfig', 'saveState']) {
    const f = await fixture(t);
    await configureDevice({ gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project },
      { home: f.home, startup: false });
    const nextRoot = join(f.home, 'rollback-storage-project'); await mkdir(nextRoot);
    const actions = []; let writes = 0;
    await assert.rejects(changeProjectRoot(nextRoot, f.home, {
      [failingWrite]: async () => { if (++writes > 1) throw new Error('original storage unavailable'); },
      serviceAction: async action => { actions.push(action); },
      verifyRuntime: async () => { throw new Error('candidate not ready'); },
    }), { code: 'project_root_rollback_failed' });
    assert.deepEqual(actions, ['stop', 'start', 'stop'], 'Restoration failure must leave the stopped runtime stopped');
  }
});

test('desktop enrollment starts core services despite an unavailable tray login entry',
  { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const events = [];
  const result = await configureFromDesktop(f.home, {
    input: { gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project }, startup: true,
    installServices: async (_state, _home, _root, components) => {
      events.push(`install:${components.join(',')}`);
      if (components.includes('tray')) throw new Error('tray registration unavailable');
    },
    serviceAction: async (action, _state, _home, components) => { events.push(`${action}:${components.join(',')}`); },
  });
  assert.equal(result.bindingId, f.bindingId);
  assert.equal(result.startup, 'partial');
  assert.match(result.warning, /托盘/);
  assert.ok(events.includes('start:runtime,tunnel'));
  assert.equal((await loadState(f.home)).bindingId, f.bindingId);
  assert.equal(f.requests.filter(item => item.path === '/v1/enroll').length, 1);
});

test('desktop enrollment never downgrades a required core startup failure to a tray warning', async t => {
  const f = await fixture(t);
  let starts = 0;
  await assert.rejects(configureFromDesktop(f.home, {
    input: { gateway: f.gateway, accessKey: `tds_${randomSecret()}`, currentProjectRoot: f.project }, startup: true,
    installServices: async () => { throw new Error('required startup unavailable'); },
    serviceAction: async () => { starts++; },
  }), /required startup unavailable/);
  assert.equal(starts, 0);
});
