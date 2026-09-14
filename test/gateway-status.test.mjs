import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayStatusProbe, readGatewayStatus } from '../client/gateway-status.mjs';

const device = { gateway: 'https://test.example', keyId: 'key-a', bindingId: 'binding-a',
  deviceSecret: 'private-test-only', remoteAccess: 'active' };

test('desktop gateway polling is bounded while manual and lifecycle reads stay fresh', async () => {
  let time = 0, calls = 0;
  const request = async (_origin, _path, _token, options) => {
    calls++;
    return { state: 'active', bindingId: options.body.bindingId };
  };
  const probe = createGatewayStatusProbe({ request, now: () => time });
  for (time = 0; time < 300000; time += 5000) assert.equal((await probe(device)).state, 'active');
  assert.equal(calls, 1, 'Sixty local refreshes require only one remote read');
  await probe(device); assert.equal(calls, 2);
  await probe(device, { force: true }); assert.equal(calls, 3);
  probe.invalidate(); await probe(device); assert.equal(calls, 4);
  await readGatewayStatus(device, { request }); await readGatewayStatus(device, { request });
  assert.equal(calls, 6, 'Uncached CLI/diagnostic/lifecycle reads are never delayed');
});

test('display cache never crosses binding, credential, gateway or pause intent', async () => {
  let calls = 0;
  const request = async (_origin, _path, _token, { body }) => {
    calls++; return { state: 'active', bindingId: body.bindingId };
  };
  const probe = createGatewayStatusProbe({ request });
  await probe(device);
  for (const changed of [{ bindingId: 'other' }, { keyId: 'other' }, { deviceSecret: 'other' },
    { gateway: 'https://other.example' }, { remoteAccess: 'suspended' }]) {
    await probe({ ...device, ...changed });
  }
  assert.equal(calls, 6);
  assert.equal((await probe({ ...device, bindingId: null })).state, 'not-enrolled');
  await probe(device); assert.equal(calls, 7);
});

test('in-flight reads deduplicate; a stale response cannot replace a forced read', async () => {
  let finish, calls = 0;
  const probe = createGatewayStatusProbe({ request: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return { state: 'suspended', bindingId: device.bindingId };
  } });
  const first = probe(device), shared = probe(device);
  assert.equal(first, shared);
  probe.invalidate();
  assert.equal((await probe(device, { force: true })).state, 'suspended');
  finish({ state: 'active', bindingId: device.bindingId }); await first;
  assert.equal((await probe(device)).state, 'suspended');
  assert.equal(calls, 2);
});

test('unreachable and invalid responses use a short retry window, not a five-second storm', async () => {
  let time = 0, calls = 0;
  const probe = createGatewayStatusProbe({ now: () => time, request: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('offline'), { status: 0 });
    if (calls === 2) return { state: 'active', bindingId: 'wrong' };
    throw Object.assign(new Error('revoked'), { status: 403 });
  } });
  assert.equal((await probe(device)).state, 'unreachable');
  time = 25000; await probe(device); assert.equal(calls, 1);
  time = 30000; assert.equal((await probe(device)).state, 'invalid-response');
  time = 60000; assert.equal((await probe(device)).state, 'disabled');
  time = 90000; assert.equal((await probe(device)).state, 'disabled');
  assert.equal(calls, 3);
});

test('an empty JSON response is retryable and cannot poison the display cache', async () => {
  let time = 0, calls = 0;
  const probe = createGatewayStatusProbe({ now: () => time, request: async () => {
    calls++;
    return calls === 1 ? null : { state: 'active', bindingId: device.bindingId };
  } });
  assert.equal((await probe(device)).state, 'invalid-response');
  time = 30000;
  assert.equal((await probe(device)).state, 'active');
  assert.equal(calls, 2);
});
