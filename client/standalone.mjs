import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import lockfile from 'proper-lockfile';
import { atomicJson, loadState, privateDirectory, readJson } from './state.mjs';
import { withDeviceOperation } from './operation.mjs';
import { componentArguments, executablePaths } from './platform.mjs';
import { loopbackRequest } from './http.mjs';

const COMPONENTS = ['runtime', 'tunnel'];
const MAX_LOG = 5 * 1024 * 1024;
const LOCK_STALE = 30000;
const entrypoint = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const missing = error => ['ENOENT', 'ESRCH'].includes(error.code);

function componentName(component) {
  if (!COMPONENTS.includes(component)) throw new Error('Unknown standalone component');
  return component;
}

// Always use one namespace-local, disposable location, independent of the
// invoking shell's XDG_RUNTIME_DIR. A fresh shell must find the same owner.
export async function standaloneDirectory(home) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Standalone requires a non-root Linux user');
  const canonical = await realpath(home);
  const namespace = await readlink('/proc/self/ns/pid');
  const base = `/tmp/team-devspace-${process.getuid()}`;
  const directory = join(base, hash(`${canonical}\0${namespace}`));
  for (const path of [base, directory]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('Unsafe standalone runtime directory; refusing to use a symlink, shared or foreign-owned directory');
    }
  }
  return directory;
}

export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const info = await lstat(`/proc/${pid}`);
    if (info.uid !== process.getuid()) return null;
    const [text, boot, namespace] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink(`/proc/${pid}/ns/pid`),
    ]);
    // comm may contain spaces and ')'. Fields after its final ')' begin at #3.
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, uid: info.uid, boot: boot.trim(), namespace, start: fields[19],
      session: Number(fields[3]), state: fields[0] };
  } catch (error) { if (missing(error) || ['EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
}

export async function isSameProcess(expected) {
  if (!expected || expected.uid !== process.getuid() || !/^\d+$/.test(expected.start ?? '')) return false;
  const actual = await processIdentity(expected.pid);
  return Boolean(actual && !['Z', 'X'].includes(actual.state) && actual.uid === expected.uid &&
    actual.start === expected.start && actual.boot === expected.boot && actual.namespace === expected.namespace);
}

async function signalProcess(identity, signal) {
  if (!await isSameProcess(identity)) return;
  try { process.kill(identity.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function ownedWorkers(owner, nonce) {
  const self = await processIdentity(process.pid);
  if (!owner || owner.uid !== self.uid || owner.boot !== self.boot || owner.namespace !== self.namespace || !/^\d+$/.test(owner.start ?? '')) return [];
  const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number);
  const identities = await Promise.all(pids.map(processIdentity));
  const candidates = identities.filter(info => info && info.pid !== owner.pid && info.uid === owner.uid &&
    BigInt(info.start) >= BigInt(owner.start) && !['Z', 'X'].includes(info.state));
  const owned = await Promise.all(candidates.map(async info => {
    const environment = await readFile(`/proc/${info.pid}/environ`, 'utf8').catch(error => {
      if (missing(error) || ['EACCES', 'EPERM'].includes(error.code)) return ''; throw error;
    });
    return environment.split('\0').includes(`TEAM_DEVSPACE_KEEPER_NONCE=${nonce}`) ? info : null;
  }));
  return owned.filter(Boolean);
}

async function clearSession(owner, nonce) {
  // An inherited, per-keeper nonce also identifies PTYs/setsid children that
  // have left the original session. Check UID/boot/namespace/birth time before
  // signalling, never just a process name or a reused PID/session number.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const member of await ownedWorkers(owner, nonce)) await signalProcess(member, signal);
    const until = Date.now() + (signal === 'SIGTERM' ? 2500 : 1500);
    while ((await ownedWorkers(owner, nonce)).length && Date.now() < until) await sleep(100);
  }
  if ((await ownedWorkers(owner, nonce)).length) throw new Error('Standalone workers could not be stopped; refusing activation/removal');
}

const recordPath = (directory, component) => join(directory, `${componentName(component)}.json`);
const lockPath = (directory, component) => join(directory, `${componentName(component)}.lock`);
const startupPath = (home, component) => join(home, 'startup', `${componentName(component)}.standalone.json`);

async function readRecord(directory, component, home) {
  const record = await readJson(recordPath(directory, component), null);
  if (record && (record.home !== home || record.component !== component || typeof record.nonce !== 'string')) {
    throw new Error('Invalid standalone owner record; refusing to signal any process');
  }
  return record;
}

async function keeperAlive(record) {
  if (!record || !await isSameProcess(record.owner)) return false;
  const args = (await readFile(`/proc/${record.owner.pid}/cmdline`, 'utf8').catch(error => {
    if (missing(error)) return ''; throw error;
  })).split('\0');
  return args.includes('--keeper') && args[args.indexOf('--keeper') + 1] === record.component &&
    args[args.indexOf('--home') + 1] === record.home && args[args.indexOf('--nonce') + 1] === record.nonce;
}

export async function hasStandaloneStartup(home, components = COMPONENTS) {
  return (await Promise.all(components.map(component => access(startupPath(home, component))
    .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })))).some(Boolean);
}

async function jobRoot(home, component) {
  const startup = await readJson(startupPath(home, component));
  if (typeof startup.root !== 'string' || !isAbsolute(startup.root)) throw new Error('Invalid standalone startup path; run repair');
  if (!startup.distributionRoot) return realpath(startup.root);
  const distribution = await realpath(startup.distributionRoot);
  const active = (await readFile(join(distribution, 'active-path'), 'utf8')).trim();
  const root = await realpath(active);
  const rel = relative(join(distribution, 'versions'), root);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid standalone active version pointer');
  return root;
}

export async function installStandalone(state, home, root, scope) {
  await withDeviceOperation(home, async () => {
    home = await realpath(home);
    root = await realpath(root);
    const distributionRoot = process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT ||
      (dirname(root).endsWith('/versions') ? dirname(dirname(root)) : null);
    for (const component of scope) {
      componentName(component);
      await atomicJson(startupPath(home, component), { root, distributionRoot });
      if (state.remoteAccess === 'suspended') await standaloneAction('stop', state, home, [component]);
    }
  });
}

async function stopOne(home, directory, component) {
  const record = await readRecord(directory, component, home);
  if (!record) {
    if (await lockfile.check(directory, { lockfilePath: lockPath(directory, component), stale: LOCK_STALE })) {
      throw new Error('Standalone startup is still acquiring ownership; retry after it completes');
    }
    await rm(lockPath(directory, component), { recursive: true, force: true });
    return;
  }
  if (await keeperAlive(record)) {
    await signalProcess(record.owner, 'SIGTERM');
    const until = Date.now() + 8000;
    while (await keeperAlive(record) && Date.now() < until) await sleep(100);
    if (await keeperAlive(record)) await signalProcess(record.owner, 'SIGKILL');
    const killedBy = Date.now() + 2000;
    while (await keeperAlive(record) && Date.now() < killedBy) await sleep(100);
    if (await keeperAlive(record)) throw new Error('Standalone keeper did not stop');
  } else if (await isSameProcess(record.owner)) {
    // Metadata that points at a live unrelated process is never trusted, even
    // when its PID happens to exist. Do not kill it or its session.
    throw new Error('Standalone owner command mismatch; refusing to stop an unrelated process');
  }
  await clearSession(record.owner, record.nonce);
  const current = await readRecord(directory, component, home);
  if (current && current.nonce !== record.nonce) throw new Error('Standalone owner changed while stopping');
  await rm(recordPath(directory, component), { force: true });
  await rm(lockPath(directory, component), { recursive: true, force: true });
}

async function localReady(state, component) {
  try {
    if (component === 'tunnel') {
      const { status } = await loopbackRequest(state.ports.metrics, '/ready', { timeout: 500 });
      // An offline edge may report 503. Installation needs a running connector,
      // not successful Internet access; deviceStatus still checks full readiness.
      return status === 200 || status === 503;
    }
    return (await loopbackRequest(state.ports.devspace, '/healthz', { timeout: 500 })).status === 200 &&
      (await loopbackRequest(state.ports.bridge, '/healthz', { timeout: 500, headers: {
        Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId,
      } })).status === 200;
  } catch { return false; }
}

async function startOne(home, directory, component) {
  const state = await loadState(home);
  if (state.remoteAccess === 'suspended') return; // no stale caller can bypass pause
  let record = await readRecord(directory, component, home);
  let nonce = record?.nonce;
  if (!await keeperAlive(record)) {
    await stopOne(home, directory, component);
    const root = await jobRoot(home, component);
    const paths = await executablePaths(root);
    await access(paths.node);
    const errorLog = await (async () => {
      await privateDirectory(join(home, 'logs'));
      return open(join(home, 'logs', component + '.error.log'), 'a', 0o600);
    })().catch(() => null);
    nonce = randomUUID();
    try {
      const child = spawn(paths.node, [join(root, 'client', 'standalone.mjs'), '--keeper', component, '--home', home, '--nonce', nonce], {
        cwd: root, detached: true, stdio: ['ignore', errorLog?.fd ?? 'ignore', errorLog?.fd ?? 'ignore'],
        env: { ...process.env, NODE_OPTIONS: '', TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_KEEPER_NONCE: '' },
      });
      await new Promise((ready, reject) => { child.once('error', reject); child.once('spawn', ready); });
      child.unref();
    } finally { await errorLog?.close().catch(() => {}); }
  }
  const until = Date.now() + 20000;
  do {
    record = await readRecord(directory, component, home);
    if (record?.nonce === nonce && await keeperAlive(record) && await isSameProcess(record.child) && await localReady(state, component)) return;
    if (record?.nonce === nonce && record.finished) break;
    await sleep(100);
  } while (Date.now() < until);
  await stopOne(home, directory, component);
  throw new Error(`Standalone ${component} failed to start; inspect ${join(home, 'logs', `${component}.error.log`)}`);
}

export async function standaloneAction(action, state, home, components) {
  return withDeviceOperation(home, async () => {
    home = await realpath(home);
    const directory = await standaloneDirectory(home);
    const failures = [];
    for (const component of components) {
      componentName(component);
      if (action === 'start') await startOne(home, directory, component);
      else {
        try {
          await stopOne(home, directory, component);
          if (action === 'remove') await rm(startupPath(home, component), { force: true });
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Standalone cleanup failed; unresolved owners were retained');
    if (action === 'remove' && !(await readdir(directory)).length) await rm(directory, { recursive: true });
  });
}

// A failed diagnostics sink keeps draining the worker's pipes. Retry disk
// access at a bounded cadence, without retaining log chunks or restarting it.
export async function logWriter(path, { openFile = open, now = Date.now, retryDelayMs = 60000 } = {}) {
  let file, size = 0, retryAt = 0, closed = false, pending = Promise.resolve();
  const closeFile = async () => {
    const handle = file; file = undefined;
    try { await handle?.close(); } catch {}
  };
  const acquire = async () => {
    if (closed || file || now() < retryAt) return;
    try { file = await openFile(path, 'a', 0o600); size = (await file.stat()).size; }
    catch { retryAt = now() + retryDelayMs; await closeFile(); }
  };
  await acquire();
  return {
    write(value) {
      pending = pending.then(async () => {
        await acquire();
        if (!file || closed) return;
        try {
          const buffer = Buffer.from(value);
          if (size + buffer.length > MAX_LOG) { await file.truncate(0); size = 0; }
          const limited = buffer.subarray(Math.max(0, buffer.length - MAX_LOG));
          await file.write(limited); size += limited.length;
        } catch { retryAt = now() + retryDelayMs; await closeFile(); }
      });
      return pending;
    },
    async close() { await pending; closed = true; await closeFile(); },
  };
}

async function runKeeper(home, component, nonce) {
  componentName(component);
  if (typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid standalone launch identity');
  home = await realpath(home);
  const directory = await standaloneDirectory(home);
  const owner = await processIdentity(process.pid);
  if (owner.session !== process.pid) throw new Error('Standalone keeper must run in its own session');
  const record = { home, component, nonce, owner, child: null, finished: false };
  let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  const release = await lockfile.lock(directory, { lockfilePath: lockPath(directory, component), stale: LOCK_STALE,
    update: 5000, onCompromised: stop });
  const output = await logWriter(join(home, 'logs', `${component}.log`));
  const errors = await logWriter(join(home, 'logs', `${component}.error.log`));
  const event = message => errors.write(`${new Date().toISOString()} standalone ${component}: ${message}\n`);
  try {
    await atomicJson(recordPath(directory, component), record);
    let failures = 0;
    while (!stopping) {
      const state = await loadState(home);
      if (state.remoteAccess === 'suspended') break;
      const root = await jobRoot(home, component);
      const paths = await executablePaths(root);
      const command = component === 'tunnel' ? paths.cloudflared : paths.node;
      const started = Date.now();
      const child = spawn(command, componentArguments(component, home, state, root), {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '', TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_KEEPER_NONCE: nonce,
          PATH: `${join(root, 'runtime', 'bin')}:${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      });
      const ended = new Promise(resolveExit => {
        child.once('error', error => resolveExit({ code: null, error: error.code ?? 'spawn_failed' }));
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      });
      const pipe = async (stream, writer) => { try { for await (const chunk of stream) await writer.write(chunk); } catch { stop(); } };
      const drains = [pipe(child.stdout, output), pipe(child.stderr, errors)];
      record.child = child.pid ? await processIdentity(child.pid) : null;
      await atomicJson(recordPath(directory, component), record);
      let outcome;
      // Subscribe once. Repeated Promise.race against a long-lived process's
      // unresolved exit promise would retain a callback every poll forever.
      void ended.then(value => { outcome = value; });
      while (!stopping && !outcome) {
        await sleep(500, undefined, { signal: abort.signal }).catch(error => {
          if (error.name !== 'AbortError') throw error;
        });
        if (!outcome && (await loadState(home)).remoteAccess === 'suspended') stop();
      }
      await clearSession(owner, nonce);
      outcome ??= await ended;
      await Promise.all(drains);
      record.child = null;
      await atomicJson(recordPath(directory, component), record);
      if (stopping || outcome.code === 0) break;
      failures = Date.now() - started >= 60000 ? 1 : failures + 1;
      await event(`worker exited (${outcome.error ?? outcome.signal ?? outcome.code}); failure ${failures}/5`);
      if (failures >= 5) { await event('restart limit reached; run repair after fixing the failure'); break; }
      await sleep([1000, 2000, 5000, 10000][failures - 1], undefined, { signal: abort.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  } catch (error) {
    await event(`stopped safely (${error.code ?? error.message})`);
  } finally {
    try {
      await clearSession(owner, nonce);
      record.child = null;
      record.finished = true;
      await atomicJson(recordPath(directory, component), record);
    } finally {
      await Promise.allSettled([output.close(), errors.close()]);
      await release().catch(() => {});
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, stop);
    }
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === entrypoint) {
  const { values } = parseArgs({ options: { keeper: { type: 'string' }, home: { type: 'string' }, nonce: { type: 'string' } } });
  runKeeper(values.home, values.keeper, values.nonce).catch(error => {
    console.error(`Standalone: ${error.message}`); process.exitCode = 1;
  });
}
