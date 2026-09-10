import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { approvedRoots, atomicJson, loadState, normalizeGateway, randomSecret, readJson, upstreamEnvironment } from '../client/state.mjs';
import { configureDevice, requestFromFile } from '../client/setup.mjs';
import { createAccessKey } from '../client/admin.mjs';
import { launchAgentXml, windowsTaskXml, serviceLabel } from '../client/platform.mjs';
import { diagnosticReport, openLogs, rollbackResumeFailure, stopTeamDevSpace } from '../client/control.mjs';
import release from '../release.config.json' with { type: 'json' };

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-client-'));
  const project = join(home, 'project');
  await mkdir(project);
  const requests = [];
  const bindingId = randomUUID();
  const keyId = randomUUID();
  const flags = { reject: false };
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = body ? JSON.parse(body) : null;
    requests.push({ path: request.url, body: data, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (flags.reject) { response.writeHead(503); response.end(JSON.stringify({ error: 'temporary_failure' })); return; }
    if (request.url === '/v1/admin/keys') {
      response.writeHead(201); response.end(JSON.stringify({ id: data.id, label: data.label, state: 'issued' })); return;
    }
    response.end(JSON.stringify({ keyId, bindingId, deviceId: data.deviceId,
      tunnelToken: 'fixture-not-a-real-tunnel-token', hostname: 'tds-fixture.example.test',
      endpoint: `http://127.0.0.1:${server.address().port}/mcp`, devspaceVersion: release.devspaceVersion,
      controlApiVersion: release.controlApiVersion }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  return { home, project, requests, flags, gateway: `http://127.0.0.1:${server.address().port}`, bindingId, keyId };
}

test('installation retry/repair preserves identity, key, roots and upstream state outside the package', async t => {
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
  assert.deepEqual(repaired.roots, ready.roots);
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

test('administrator issuance can be retried without losing the original employee credential', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  const output = join(f.home, 'employee-key.json');
  f.flags.reject = true;
  await assert.rejects(createAccessKey(config, 'Employee A', output), /temporary_failure/);
  const failed = f.requests.at(-1).body;
  f.flags.reject = false;
  const issued = await createAccessKey(config, 'Employee A', output);
  const saved = await readJson(output);
  assert.equal(issued.id, failed.id);
  assert.equal(f.requests.at(-1).body.keyHash, failed.keyHash);
  assert.ok(saved.accessKey.startsWith('tds_'));
  assert.ok(!JSON.stringify(issued).includes(saved.accessKey));
  assert.ok(!JSON.stringify(f.requests.at(-1).body).includes(saved.accessKey));
  const outside = join(f.home, '..', `team-devspace-unsafe-export-${randomUUID()}.json`);
  await assert.rejects(createAccessKey(config, 'Employee A', outside), /private administrator configuration directory/);
  await assert.rejects(access(outside), { code: 'ENOENT' });
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

test('concurrent administrator issuance reuses one persisted employee credential', async t => {
  const f = await fixture(t);
  const config = { gateway: f.gateway, adminToken: randomSecret(), directory: f.home };
  const [a, b] = await Promise.all([
    createAccessKey(config, 'Same employee'), createAccessKey(config, 'Same employee'),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.accessKey, b.accessKey);
  assert.equal(new Set(f.requests.map(request => request.body.keyHash)).size, 1);
});

test('setup request accepts NSIS UTF-16LE and consumes only the temporary request', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-request-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'request.json');
  const data = { accessKey: `tds_${randomSecret()}`, roots: ['C:\\project\\\u6d4b\u8bd5'] };
  await writeFile(path, Buffer.concat([Buffer.from([255, 254]), Buffer.from(JSON.stringify(data), 'utf16le')]));
  assert.deepEqual(await requestFromFile(path, true), data);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await writeFile(path, '\uFEFF' + JSON.stringify(data));
  assert.deepEqual(await requestFromFile(path, false), data);
  await access(path);
});

test('Allowed Roots are explicit existing directories; gateway origin cannot carry secrets or paths', async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-roots-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await approvedRoots([home, home]), [await realpath(home)]);
  await assert.rejects(approvedRoots([]));
  await assert.rejects(approvedRoots(['relative']));
  await assert.rejects(approvedRoots([parse(home).root]));
  await assert.rejects(approvedRoots([join(home, 'missing')]));
  for (const value of ['http://evil.example', 'https://user:password@example.test', 'https://example.test/mcp', 'https://example.test?token=secret']) {
    assert.throws(() => normalizeGateway(value));
  }
  assert.equal(normalizeGateway('https://example.test/'), 'https://example.test');
  assert.equal(normalizeGateway('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
});

test('native startup configuration contains no credentials, no SYSTEM/root elevation, and supports XML-special paths', () => {
  const state = { deviceId: randomUUID(), deviceSecret: randomSecret(), accessKey: `tds_${randomSecret()}`,
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  const home = join(homedir(), 'Project & Notes');
  const root = join(homedir(), 'Team & DevSpace');
  const task = windowsTaskXml(state, 'runtime', home, 'S-1-5-21-123', root);
  assert.ok(task.includes('InteractiveToken'));
  assert.ok(task.includes('LeastPrivilege'));
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
  assert.throws(() => serviceLabel(state, 'arbitrary-process'));
});

test('opening logs delegates to the desktop shell without waiting for its exit code', async () => {
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

test('closing is allowed when the Gateway says the device is already disabled',
  { skip: process.platform !== 'win32' }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'team-devspace-disabled-'));
    const project = join(home, 'project');
    await mkdir(project);
    t.after(() => rm(home, { recursive: true, force: true }));
    const server = http.createServer((_request, response) => {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'device_disabled' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    await atomicJson(join(home, 'state.json'), {
      schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
      keyId: randomUUID(), bindingId: randomUUID(), gateway: `http://127.0.0.1:${server.address().port}`,
      roots: [project], remoteAccess: 'active', releaseVersion: release.version, devspaceVersion: release.devspaceVersion,
      ports: { devspace: 65120, bridge: 65121, metrics: 65122 },
    });
    assert.equal((await stopTeamDevSpace(home)).stopped, true);
    assert.equal((await loadState(home)).remoteAccess, 'suspended');
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
