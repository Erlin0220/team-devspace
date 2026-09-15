import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateDistributionConfig } from './distribution.mjs';
import { run, sha256File } from './build-utils.mjs';

const { values } = parseArgs({ options: {
  root: { type: 'string' }, target: { type: 'string' }, installed: { type: 'string' },
} });
const { default: release } = await import('./release-profile.mjs');
const distribution = validateDistributionConfig(release);
const root = resolve(values.root ?? join('release', 'offline', release.version));
const targets = values.target ? [values.target] : distribution.targets;
if (targets.some(target => !distribution.targets.includes(target))) throw new Error('Requested release target is not enabled');
if (values.installed && (targets.length !== 1 || targets[0] !== `${process.platform}-${process.arch}`)) {
  throw new Error('Installed payload verification requires exactly the current native target');
}

for (const target of targets) {
  const directory = join(root, target);
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.trust, 'bootstrap-embedded-manifest');
  assert.equal(manifest.release, release.version);
  assert.equal(manifest.target, target);
  assert.equal(manifest.installMode, 'offline');
  assert.equal('sourceBase' in manifest, false);

  const expectedManifestHash = (await readFile(join(directory, 'manifest.json.sha256'), 'utf8')).trim().split(/\s+/)[0];
  assert.equal(await sha256File(manifestPath), expectedManifestHash);

  for (const component of manifest.components) {
    const artifact = join(directory, ...component.path.split('/'));
    assert.equal((await stat(artifact)).size, component.size, `${target}/${component.name} size differs from manifest`);
    assert.equal(await sha256File(artifact), component.sha256, `${target}/${component.name} SHA-256 differs from manifest`);
  }

  const entries = await readdir(directory);
  const entrypoints = entries.filter(name => name.startsWith('Team-DevSpace-') && !name.endsWith('.sha256'));
  assert.ok(entrypoints.length > 0, `${target} has no administrator handoff entrypoint`);
  for (const name of entrypoints) {
    const checksumPath = join(directory, `${name}.sha256`);
    const expected = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(await sha256File(join(directory, name)), expected, `${target}/${name} SHA-256 differs from its checksum file`);
  }
  if (values.installed) {
    const installed = resolve(values.installed);
    const bundle = resolve(`build/bundle-${target}`);
    assert.deepEqual(await readFile(join(installed, 'install-manifest.json')), manifestBytes,
      'The installed manifest differs from the verified release manifest');
    const windows = process.platform === 'win32';
    const nodePath = windows ? 'runtime/node.exe' : 'runtime/bin/node';
    const cloudPath = windows ? 'bin/cloudflared.exe' : 'bin/cloudflared';
    const files = [nodePath, cloudPath, 'client/cli.mjs', 'client/platform.mjs',
      'client/state.mjs', 'client/setup.mjs', 'client/control.mjs', 'client/operation.mjs',
      'release.config.json', 'release-provenance.json', 'sbom.cdx.json', 'THIRD-PARTY-NOTICES.txt'];
    if (windows || process.platform === 'darwin') files.push('client/tray.mjs', 'client/desktop.mjs',
      'client/desktop-controller.mjs', 'client/desktop-state.mjs', 'client/local-control.mjs',
      'client/control.html', 'client/control.js', 'client/control.css');
    if (windows) files.push('platform/windows/tds-launcher.exe', 'platform/windows/team-devspace-tray.exe');
    if (process.platform === 'darwin') files.push('platform/macos/Team DevSpace Tray.app/Contents/MacOS/TeamDevSpaceTray');
    // Compare the extracted/native files, not just the surrounding archive hashes.
    // Foreign or stale payloads must not be accepted merely because they launch.
    for (const path of files) assert.equal(await sha256File(join(installed, path)), await sha256File(join(bundle, path)),
      `Installed payload differs from the built target: ${path}`);
    const executable = [nodePath, cloudPath, ...files.filter(path => path.endsWith('/TeamDevSpaceTray'))];
    if (!windows) for (const path of executable) await access(join(installed, path), 1);
    const runtime = JSON.parse((await run(join(installed, nodePath), ['-p',
      'JSON.stringify({version:process.versions.node,target:process.platform+"-"+process.arch})'],
    { capture: true, env: { NODE_OPTIONS: '' } })).stdout);
    assert.equal(runtime.version, release.nodeVersion);
    assert.equal(runtime.target, target, 'Installed Node executes a different target architecture');
    const provenance = JSON.parse(await readFile(join(installed, 'release-provenance.json'), 'utf8'));
    assert.equal(provenance.target, target);
    assert.equal(provenance.release, release.version);
    assert.equal(await sha256File(join(installed, cloudPath)),
      provenance.cloudflaredBuild?.sha256 ?? provenance.binaries.cloudflared.sha256);
    const cloudVersion = await run(join(installed, cloudPath), ['--version'], { capture: true });
    assert.ok(cloudVersion.stdout.includes(release.cloudflaredVersion), 'Installed cloudflared version mismatch');
    const upstream = JSON.parse(await readFile(join(installed, 'node_modules/@waishnav/devspace/package.json'), 'utf8'));
    assert.equal(upstream.version, release.devspaceVersion);
    if (process.platform === 'darwin') {
      const macho = process.arch === 'x64' ? 'x86_64' : 'arm64';
      for (const path of executable) {
        const archs = (await run('/usr/bin/lipo', ['-archs', join(installed, path)], { capture: true })).stdout.trim().split(/\s+/);
        assert.ok(archs.includes(macho), `Installed Mach-O architecture mismatch: ${path} -> ${archs.join(' ')}`);
      }
      await access(join(installed, 'node_modules/node-pty/prebuilds', target, 'spawn-helper'), 1);
    }
    console.log(JSON.stringify({ installedPayload: true, target, filesMatched: files.length,
      manifestMatched: true, runtimeExecuted: true, cloudflaredVerified: true, executablePermissions: !windows }));
  }
  console.log(JSON.stringify({ verified: true, target, components: manifest.components.length, entrypoints: entrypoints.length }));
}
