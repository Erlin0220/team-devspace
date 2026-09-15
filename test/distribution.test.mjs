import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReleaseLayout, validateDistributionConfig } from '../scripts/distribution.mjs';
import { run, sha256File } from '../scripts/build-utils.mjs';
import { dependencyFingerprint, pruneRuntime } from '../scripts/runtime-profile.mjs';

test('runtime cache ignores only app version metadata, not dependency or installation policy changes', () => {
  const input = { lockfile: { version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/dependency': { version: '1.2.3' } } },
    packageJson: { version: '0.1.0', scripts: { postinstall: 'node install.mjs' }, dependencies: { dependency: '1.2.3' } },
    npmrc: 'registry=https://registry.npmjs.org/', target: 'linux-x64', nodeVersion: 'v22', npmVersion: '11', profile: 'profile' };
  const before = dependencyFingerprint(input);
  const versionOnly = structuredClone(input);
  versionOnly.lockfile.version = versionOnly.lockfile.packages[''].version = versionOnly.packageJson.version = '0.1.1';
  assert.equal(dependencyFingerprint(versionOnly), before);
  assert.equal(input.lockfile.version, '0.1.0', 'Computing a key must not mutate provenance input');
  for (const change of [value => { value.lockfile.packages['node_modules/dependency'].version = '1.2.4'; },
    value => { value.packageJson.scripts.postinstall = 'node changed.mjs'; },
    value => { value.npmrc += '\nignore-scripts=true'; }, value => { value.target = 'darwin-arm64'; }]) {
    const changed = structuredClone(input); change(changed);
    assert.notEqual(dependencyFingerprint(changed), before);
  }
});

test('macOS preinstall normalizes Intel hardware names to the release x64 target', async () => {
  const preinstall = await readFile('platform/macos/preinstall', 'utf8');
  assert.match(preinstall, /if \[ "\$ARCH" = x86_64 \]; then ARCH=x64; fi/);
  assert.match(preinstall, /EXPECTED_ARCH='__TEAM_DEVSPACE_MACOS_ARCH__'/);
  assert.doesNotMatch(preinstall, /requires Apple Silicon/);
});

test('macOS postinstall confirms visible UI instead of trusting process startup', async () => {
  const [postinstall, launchApp] = await Promise.all([
    readFile('platform/macos/postinstall', 'utf8'),
    readFile('platform/macos/launch-app.sh', 'utf8'),
  ]);
  const marker = '.ui-ready';
  assert.match(launchApp, new RegExp(marker.replace('.', '\\.')),
    'The app wrapper must pass a dedicated visible-UI marker into the native UI process');
  assert.match(launchApp, /TEAM_DEVSPACE_UI_READY_MARKER/);
  assert.doesNotMatch(launchApp, /\.app-started/,
    'Entering the shell wrapper must not be treated as successful onboarding UI');
  assert.match(postinstall, new RegExp(marker.replace('.', '\\.')),
    'The installer must wait for the visible UI marker instead of trusting open(1) alone');
  assert.ok(postinstall.indexOf('/bin/rm -f "$UI_READY"') < postinstall.indexOf("/usr/bin/open '/Applications/Team DevSpace.app'"),
    'A stale UI marker must be removed before requesting a new app launch');
  assert.match(postinstall, /while \[ "\$attempt" -lt 45 \] && \[ ! -f "\$UI_READY" \]/);
  assert.match(postinstall, /AUTO_OPEN_UNCONFIRMED/);
  assert.match(postinstall, /display alert "Team DevSpace 需要完成设置"/);
  assert.match(postinstall, /隐私与安全性/);
  assert.match(postinstall, /Access Key/);
  assert.match(postinstall, /exit 0\n$/,
    'A blocked first launch must stay a recoverable onboarding state, not roll back a valid package install');
  assert.doesNotMatch(postinstall, /xattr[^\n]*quarantine/i,
    'Internal-free onboarding must explain Gatekeeper recovery instead of silently stripping quarantine metadata');
});

const baseRelease = {
  version: '1.2.3', gateway: 'https://team.example.test', devspaceVersion: '1.0.8',
  nodeVersion: '22.23.0', cloudflaredVersion: '2026.8.3', cloudflaredSourceCommit: 'f'.repeat(40),
  cloudflaredGoVersion: '1.26.8', gitFallbackVersion: '2.55.0.windows.5',
  distribution: { mode: 'static-https', origin: 'https://downloads.example.com', trustProfile: 'internal-free', macosMinimumVersion: '12.0',
    targets: ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'] },
};

test('distribution config requires static HTTPS, internal-free trust and explicit immutable targets', () => {
  const distribution = validateDistributionConfig(baseRelease);
  assert.equal(distribution.mode, 'static-https');
  assert.equal(distribution.trustProfile, 'internal-free');
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, mode: 'public-object-storage' } }));
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, trustProfile: 'commercial-signing' } }));
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, targets: ['win32-x64', 'win32-x64'] } }));
});

test('release layout separates app, upstream dependencies, runtimes and optional fallback', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds-distribution-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const bundle = join(work, 'bundle');
  const output = join(work, 'release');
  const directories = ['client', 'platform', 'node_modules/@waishnav/devspace', 'runtime/bin', 'bin', 'git', 'node_modules/example'];
  for (const directory of directories) await mkdir(join(bundle, directory), { recursive: true });
  const files = {
    'client/cli.mjs': 'client', 'platform/platform.txt': 'platform', 'node_modules/@waishnav/devspace/package.json': '{"version":"1.0.8"}',
    'node_modules/example/index.js': 'dependency', 'node_modules/example/index.js.map': 'source-map',
    'node_modules/example/index.d.ts': 'types', 'node_modules/example/index.d.mts': 'types', 'node_modules/example/index.d.cts': 'types',
    'runtime/node.exe': 'node', 'runtime/bin/node': 'node', 'bin/cloudflared.exe': 'cloudflared', 'bin/cloudflared': 'cloudflared',
    'bin/team-devspace.cmd': 'command', 'git/git.exe': 'git', 'package.json': '{}', 'package-lock.json': '{}', '.npmrc': '',
    'release.config.json': '{}', 'README.md': 'readme', 'sbom.cdx.json': '{}', 'THIRD-PARTY-NOTICES.txt': 'notices',
    'release-provenance.json': '{}', 'LICENSE': 'license', 'NOTICE': 'notice', 'LICENSES/README.md': 'third-party licenses',
  };
  await mkdir(join(bundle, 'LICENSES'));
  for (const [path, contents] of Object.entries(files)) await writeFile(join(bundle, path), contents);
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar';
  const gitFallbackArchive = join(work, 'official-PortableGit.7z.exe');
  await writeFile(gitFallbackArchive, 'official-self-extracting-archive-fixture');
  const build = () => buildReleaseLayout({ bundle, target: 'win32-x64', release: baseRelease, tar, outputDirectory: output, gitFallbackArchive });
  const built = await build();
  assert.deepEqual(built.components.map(component => component.name),
    ['app', 'devspace-runtime', 'node', 'cloudflared', 'git-fallback']);
  for (const component of built.components) {
    const artifact = join(built.layout, ...component.path.split('/'));
    assert.equal((await stat(artifact)).size, component.size);
    assert.equal(await sha256File(artifact), component.sha256);
  }
  const app = built.components.find(component => component.name === 'app');
  const appArchive = join(built.layout, ...app.path.split('/'));
  const listing = (await run(tar, ['-tzf', appArchive], { capture: true })).stdout;
  assert.doesNotMatch(listing, /node_modules/);
  const manifest = JSON.parse(await readFile(built.manifestPath, 'utf8'));
  assert.equal(manifest.installMode, 'offline');
  assert.equal('sourceBase' in manifest, false);
  assert.equal(await sha256File(built.manifestPath), built.manifestSha256);
  const git = built.components.find(component => component.name === 'git-fallback');
  assert.equal(git.format, '7z-sfx');
  assert.equal(git.sha256, await sha256File(gitFallbackArchive), 'The official self-extractor must not be recompressed');
  const runtime = built.components.find(component => component.name === 'devspace-runtime');
  const runtimeListing = (await run(tar, ['-tzf', join(built.layout, runtime.path)], { capture: true })).stdout;
  assert.match(runtimeListing, /node_modules\/example\/index\.js/);
  assert.doesNotMatch(runtimeListing, /\.map$|\.d\.ts$|\.d\.mts$|\.d\.cts$/m,
    'Employee runtime archives must omit source maps and TypeScript declaration files');
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
    const unixBuilt = await buildReleaseLayout({ bundle, target, release: baseRelease, tar, outputDirectory: output });
    const unixRuntime = unixBuilt.components.find(component => component.name === 'devspace-runtime');
    const unixListing = (await run(tar, ['-tzf', join(unixBuilt.layout, unixRuntime.path)], { capture: true })).stdout;
    assert.match(unixListing, /node_modules\/example\/index\.js/);
    assert.doesNotMatch(unixListing, /\.map$|\.d\.ts$|\.d\.mts$|\.d\.cts$/m,
      `${target} employee runtime must omit source maps and TypeScript declaration files`);
  }
  assert.doesNotMatch(runtimeListing, /^\.npmrc$|^package-lock\.json$/m);
  await assert.rejects(access(join(built.layout, '.staging')));
  await writeFile(join(bundle, 'package-lock.json'), '{"version":"9.9.9"}');
  await writeFile(join(bundle, '.npmrc'), 'registry=https://registry.npmjs.org/');
  const rebuilt = await build();
  assert.equal(rebuilt.components.find(component => component.name === 'devspace-runtime').sha256, runtime.sha256,
    'App/build metadata changes must not change the unchanged runtime component');
});

test('Unix profile prunes only optional Claude executables and foreign PTYs, preserving SDK and native build', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds-profile-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
    const bundle = join(work, target);
    const paths = ['node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
      'node_modules/node-pty/build/Release', ...['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']
        .map(platform => `node_modules/node-pty/prebuilds/${platform}`),
      ...(target.startsWith('darwin-') ? ['node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64',
        'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64'] : [])];
    for (const path of paths) {
      await mkdir(join(bundle, path), { recursive: true });
      await writeFile(join(bundle, path, 'payload'), 'fixture');
    }
    await writeFile(join(bundle, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64': { optional: true },
    } }));
    await pruneRuntime(bundle, target);
    await access(join(bundle, 'node_modules/@anthropic-ai/claude-agent-sdk/payload'));
    await access(join(bundle, 'node_modules/node-pty/build/Release/payload'));
    await access(join(bundle, `node_modules/node-pty/prebuilds/${target}/payload`));
    if (target.startsWith('darwin-')) {
      const piPrebuilds = 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds';
      await access(join(bundle, piPrebuilds, target, 'payload'));
      const foreign = target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64';
      await assert.rejects(access(join(bundle, piPrebuilds, foreign)));
    }
    await assert.rejects(access(join(bundle, 'node_modules/node-pty/prebuilds/win32-x64')));
    await assert.rejects(access(join(bundle, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64')));
    await mkdir(join(bundle, 'node_modules/@anthropic-ai/claude-agent-sdk-new-platform'));
    await assert.rejects(pruneRuntime(bundle, target), /non-optional dependency/);
    await access(join(bundle, 'node_modules/@anthropic-ai/claude-agent-sdk-new-platform'));
  }
});
