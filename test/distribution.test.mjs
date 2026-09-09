import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReleaseLayout, validateDistributionConfig } from '../scripts/distribution.mjs';
import { run, sha256File } from '../scripts/build-utils.mjs';

const baseRelease = {
  version: '1.2.3', gateway: 'https://team.example.test', devspaceVersion: '1.0.8',
  nodeVersion: '22.23.0', cloudflaredVersion: '2026.8.3', gitFallbackVersion: '2.55.0.windows.5',
  distribution: { bucket: 'team-devspace-releases', baseUrl: 'https://team.example.test/releases',
    hostname: 'team.example.test', visibility: 'public', targets: ['win32-x64'] },
};

test('distribution config requires explicit immutable targets and source path', () => {
  assert.equal(validateDistributionConfig(baseRelease).bucket, 'team-devspace-releases');
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, baseUrl: 'https://team.example.test/latest/' } }));
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, targets: ['win32-x64', 'win32-x64'] } }));
  assert.throws(() => validateDistributionConfig({ ...baseRelease,
    distribution: { ...baseRelease.distribution, visibility: 'private' } }));
});

test('release layout separates app, upstream dependencies, runtimes and optional fallback', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds-distribution-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const bundle = join(work, 'bundle');
  const output = join(work, 'release');
  const directories = ['client', 'platform', 'node_modules/@waishnav/devspace', 'runtime', 'bin', 'git', 'node_modules/example'];
  for (const directory of directories) await mkdir(join(bundle, directory), { recursive: true });
  const files = {
    'client/cli.mjs': 'client', 'platform/platform.txt': 'platform', 'node_modules/@waishnav/devspace/package.json': '{"version":"1.0.8"}',
    'node_modules/example/index.js': 'dependency', 'runtime/node.exe': 'node', 'bin/cloudflared.exe': 'cloudflared',
    'bin/team-devspace.cmd': 'command', 'git/git.exe': 'git', 'package.json': '{}', 'package-lock.json': '{}', '.npmrc': '',
    'release.config.json': '{}', 'README.md': 'readme', 'sbom.cdx.json': '{}', 'THIRD-PARTY-NOTICES.txt': 'notices',
    'release-provenance.json': '{}',
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(bundle, path), contents);
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar';
  const built = await buildReleaseLayout({ bundle, target: 'win32-x64', release: baseRelease, tar, outputDirectory: output });
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
  assert.equal(manifest.sourceBase, 'https://team.example.test/releases/1.2.3/win32-x64/');
  assert.equal(await sha256File(built.manifestPath), built.manifestSha256);
});
