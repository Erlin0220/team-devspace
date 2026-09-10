import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { atomicJson, randomSecret } from '../client/state.mjs';
import { run } from './build-utils.mjs';
import release from '../release.config.json' with { type: 'json' };

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Run this installer test on native macOS/Linux');
const target = `${process.platform}-${process.arch}`;
const work = await mkdtemp(join(tmpdir(), 'tds unix installer '));
const root = join(work, 'installed distribution');
const home = join(work, 'device state');
const media = join(work, 'offline media');
const exists = path => access(path).then(() => true, () => false);
const source = resolve('release/offline', release.version, target);
const cliDir = join(work, 'bin');
const env = { TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_CLI_DIR: cliDir, NODE_OPTIONS: '' };
const sockets = [];
try {
  await mkdir(media);
  if (process.platform === 'linux') {
    await run('/usr/bin/tar', ['-xzf', join(source, `Team-DevSpace-${release.version}-linux-${process.arch}-offline.tar.gz`), '-C', media]);
  } else {
    const expanded = join(work, 'expanded pkg');
    await run('/usr/sbin/pkgutil', ['--expand-full', join(source, `Team-DevSpace-${release.version}-macos-${process.arch}.pkg`), expanded]);
    const entries = await readdir(expanded, { recursive: true });
    const embedded = entries.find(path => path.endsWith('Contents/Resources/release-manifest.json'));
    assert.ok(embedded, 'The actual PKG must embed its offline manifest');
    await cp(dirname(join(expanded, embedded)), media, { recursive: true });
  }
  // No LaunchAgent/systemd startup is installed in this test. Provide isolated,
  // valid employee state so upgrade stop uses the real client idempotent path.
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    sockets.push(socket); ports.push(socket.address().port);
  }
  await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve))));
  const state = { schema: 1, deviceId: randomUUID(), deviceSecret: randomSecret(), ownerToken: randomSecret(),
    gateway: 'https://offline-smoke.invalid', roots: [work], ports: { devspace: ports[0], bridge: ports[1], metrics: ports[2] } };
  await atomicJson(join(home, 'state.json'), state);
  const manifestPath = join(media, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bootstrap = join(media, process.platform === 'linux' ? 'install.sh' : 'bootstrap.sh');
  const install = () => run('/bin/sh', [bootstrap, '--root', root, '--manifest', manifestPath,
    '--offline', media, '--setup', 'none'], { cwd: work, env, timeout: 240000 });
  const active = () => readFile(join(root, 'active-path'), 'utf8').then(value => value.trim());
  await install();
  const first = await active();
  if (process.platform === 'linux') {
    const stableCli = join(root, 'bin', 'team-devspace');
    await access(stableCli);
    assert.equal(await readlink(join(cliDir, 'team-devspace')), stableCli);
    const cli = await run(stableCli, ['roots', 'list'], { cwd: work, env, capture: true });
    assert.ok(cli.stdout.includes(work), 'Stable Linux CLI must resolve the active version and retained state');
  }
  await writeFile(join(first, 'obsolete'), 'old version');
  const stale = join(root, 'cache/sha256', '0'.repeat(64));
  await mkdir(stale);
  await writeFile(join(stale, 'old'), 'old artifact');
  await install();
  const second = await active();
  assert.notEqual(first, second);
  assert.equal(await exists(first), false);
  assert.equal(await exists(stale), false);
  assert.equal((await readdir(join(root, 'versions'))).length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'state.json'), 'utf8')), state);
  await rm(join(second, 'bin/cloudflared'));
  await install();
  const repaired = await active();
  assert.ok(await exists(join(repaired, 'bin/cloudflared')));
  const component = manifest.components.find(item => item.name === 'node');
  await rm(join(root, 'cache/sha256', component.sha256), { recursive: true, force: true });
  await writeFile(join(media, component.path), 'corrupt artifact');
  await assert.rejects(install(), /exited/);
  assert.equal(await active(), repaired);
  assert.ok(await exists(join(repaired, 'runtime/bin/node')));
  assert.equal(await exists(join(root, 'install.lock')), false);
  assert.equal((await readdir(join(root, 'staging'))).length, 0);
  console.log(JSON.stringify({ passed: true, target, actualOfflinePackage: true, pathsWithSpaces: true,
    nativeModulesFromInstalledTree: true, repair: true, failedRepairRetainsActive: true,
    retiredVersionsCollected: true, cacheGarbageCollected: true,
    stableLinuxCli: process.platform === 'linux', nativeLoginSessionTested: false }));
} finally {
  for (const socket of sockets) if (socket.listening) await new Promise(resolve => socket.close(resolve));
  await rm(work, { recursive: true, force: true });
}
