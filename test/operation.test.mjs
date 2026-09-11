import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { withDeviceOperation } from '../client/operation.mjs';

if (process.argv[2] === '--operation-worker') {
  try {
    process.send('attempting');
    await withDeviceOperation(process.argv[3], async () => {
      const released = new Promise(resolve => process.once('message', resolve));
      process.send('acquired');
      await released;
    });
    process.disconnect();
  } catch (error) { console.error(error.message); process.exitCode = 1; process.disconnect(); }
} else {
  async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), 'tds-operation-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    return home;
  }
  function worker(t, home) {
    const child = fork(fileURLToPath(import.meta.url), ['--operation-worker', home], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const events = [];
    const waiters = new Map();
    child.on('message', value => { events.push(value); waiters.get(value)?.(); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
    return { child, events, exited, wait: event => Promise.race([
      events.includes(event) ? Promise.resolve() : new Promise(resolve => waiters.set(event, resolve)),
      exited.then(result => { throw new Error(`Worker exited before ${event}: ${JSON.stringify(result)}`); }),
      sleep(10000, undefined, { ref: false }).then(() => { throw new Error(`Worker did not emit ${event}`); }),
    ]) };
  }

  test('device operations are reentrant and release their lock after failure', async t => {
    const home = await fixture(t);
    await assert.rejects(withDeviceOperation(home, () => withDeviceOperation(home, async () => {
      throw new Error('injected operation failure');
    })), /injected operation failure/);
    assert.equal(await withDeviceOperation(home, async () => 'recovered'), 'recovered');
    assert.equal(await access(join(home, '.lifecycle.lock')).then(() => true, () => false), false);
  });

  test('separate processes share one device operation owner without blocking another installation', async t => {
    const home = await fixture(t);
    const other = await fixture(t);
    const first = worker(t, home);
    await first.wait('acquired');
    const second = worker(t, home);
    await second.wait('attempting');
    await sleep(150);
    assert.equal(second.events.includes('acquired'), false);
    assert.equal(await withDeviceOperation(other, async () => 'independent'), 'independent');
    first.child.send('release');
    assert.equal((await first.exited).code, 0);
    await second.wait('acquired');
    second.child.send('release');
    assert.equal((await second.exited).code, 0);
  });

  test('a killed operation owner is recoverable after its lock becomes stale', async t => {
    const home = await fixture(t);
    const first = worker(t, home);
    await first.wait('acquired');
    first.child.kill('SIGKILL');
    await first.exited;
    // Advance only the abandoned lock age, not production stale/retry settings.
    const old = new Date(Date.now() - 60000);
    await utimes(join(home, '.lifecycle.lock'), old, old);
    assert.equal(await withDeviceOperation(home, async () => 'recovered-after-crash'), 'recovered-after-crash');
  });
}
