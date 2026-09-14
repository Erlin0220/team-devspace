import test from 'node:test';
import assert from 'node:assert/strict';
import { clearUpdatePolicyCache, updateRules } from '../gateway/update-policy.mjs';

const row = revision => ({ auto_version: revision ? '0.2.6' : null,
  minimum_supported: null, enforce_after: null, revision });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('concurrent policy cache misses share one D1 read', async t => {
  const env = { PUBLIC_ORIGIN: 'https://policy-coalesce.example.test' }, read = deferred();
  t.after(() => clearUpdatePolicyCache(env));
  let reads = 0;
  const store = { updatePolicy: () => { reads++; return read.promise; } };
  const pending = Array.from({ length: 5 }, () => updateRules(env, store));
  read.resolve(row(0));
  const values = await Promise.all(pending);
  assert.equal(reads, 1);
  assert.ok(values.every(value => value.revision === 0));
});

test('an old D1 read cannot refill policy cache after an administrator invalidates it', async t => {
  const env = { PUBLIC_ORIGIN: 'https://policy-invalidate.example.test' }, old = deferred();
  t.after(() => clearUpdatePolicyCache(env));
  let reads = 0;
  const store = { updatePolicy: async () => ++reads === 1 ? old.promise : row(1) };
  const pending = updateRules(env, store);
  clearUpdatePolicyCache(env);
  assert.equal((await updateRules(env, store)).revision, 1);
  old.resolve(row(0));
  await pending;
  assert.equal((await updateRules(env, store)).revision, 1);
  assert.equal(reads, 2);
});

test('a failed D1 read is not cached and a fresh read bypasses an in-flight snapshot', async t => {
  const env = { PUBLIC_ORIGIN: 'https://policy-fresh.example.test' }, old = deferred();
  t.after(() => clearUpdatePolicyCache(env));
  let reads = 0;
  const store = { updatePolicy: async () => {
    reads++;
    if (reads === 1) throw new Error('temporary D1 failure');
    return reads === 2 ? old.promise : row(1);
  } };
  await assert.rejects(updateRules(env, store), /temporary D1 failure/);
  const pending = updateRules(env, store);
  assert.equal((await updateRules(env, store, true)).revision, 1);
  old.resolve(row(0)); await pending;
  assert.equal((await updateRules(env, store)).revision, 1);
});
