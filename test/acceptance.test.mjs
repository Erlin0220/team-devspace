import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import release from '../release.config.json' with { type: 'json' };
import { sourceIdentity } from '../scripts/build-utils.mjs';

const exec = promisify(execFile);
async function copyCatalogContract(root) {
  await cp('scripts/release-profile.mjs', join(root, 'scripts/release-profile.mjs'));
  await mkdir(join(root, 'client'), { recursive: true });
  await cp('client/release-catalog.mjs', join(root, 'client/release-catalog.mjs'));
}
test('release acceptance rejects extracted-only PKGs and missing native startup evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-acceptance-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['verify-acceptance.mjs', 'build-utils.mjs', 'download-catalog.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  await copyCatalogContract(root);
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ ...release, version: '1.2.3', distribution: { ...release.distribution, targets: ['darwin-arm64'] } }));
  const directory = join(root, 'release/offline/1.2.3/darwin-arm64');
  await mkdir(directory, { recursive: true });
  const bytes = 'fixture package bytes';
  await writeFile(join(directory, 'Team-DevSpace-1.2.3-macos-arm64.pkg'), bytes);
  const evidence = { schema: 1, passed: true, release: '1.2.3', target: 'darwin-arm64',
    entrypoint: { name: 'Team-DevSpace-1.2.3-macos-arm64.pkg', sha256: createHash('sha256').update(bytes).digest('hex') },
    checks: { releaseLayout: true, installerTransaction: true, installedPayload: true, zeroResidue: true,
      trayProtocol: true, traySingleInstance: true, finalEntrypointTransaction: true, nativeStartup: true } };
  const verify = () => exec(process.execPath, ['scripts/verify-acceptance.mjs'], {
    cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', GITHUB_SHA: '' },
  });
  for (const field of ['finalEntrypointTransaction', 'nativeStartup', 'installedPayload']) {
    await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ ...evidence, checks: { ...evidence.checks, [field]: false } }));
    await assert.rejects(verify(), error => /macOS.*(installed|lifecycle)|payload contents were not accepted/.test(error.stderr));
  }
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify(evidence));
  assert.match((await verify()).stdout, /"accepted":true/);
});

test('a failed acceptance attempt invalidates a previous green report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-stale-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['platform-acceptance.mjs', 'build-utils.mjs', 'release-profile.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  const target = `${process.platform}-${process.arch}`;
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ ...release, version: '1.2.3', distribution: { ...release.distribution, targets: [target] } }));
  await writeFile(join(root, 'scripts/verify-release.mjs'), 'process.exit(7);');
  const directory = join(root, 'release/offline/1.2.3', target);
  await mkdir(directory, { recursive: true });
  const report = join(directory, 'acceptance.json');
  await writeFile(report, JSON.stringify({ passed: true }));
  await assert.rejects(exec(process.execPath, ['scripts/platform-acceptance.mjs'], {
    cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', TEAM_DEVSPACE_FINAL_WINDOWS_INSTALLER: '' },
  }), error => /verify-release.mjs failed/.test(error.stderr));
  await assert.rejects(access(report), { code: 'ENOENT' });
});

test('installed payload verification rejects a foreign manifest and altered native executable before execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-installed-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['verify-release.mjs', 'distribution.mjs', 'build-utils.mjs', 'download-catalog.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  await copyCatalogContract(root);
  await writeFile(join(root, 'release.config.json'), JSON.stringify(release));
  const target = `${process.platform}-${process.arch}`;
  const directory = join(root, 'release/offline', release.version, target);
  const installed = join(root, 'installed');
  const nodePath = process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node';
  const bundle = join(root, `build/bundle-${target}`);
  for (const path of [directory, join(installed, 'runtime/bin'), join(bundle, 'runtime/bin')]) await mkdir(path, { recursive: true });
  const manifest = JSON.stringify({ schema: 1, trust: 'bootstrap-embedded-manifest', release: release.version,
    target, installMode: 'offline', components: [] });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, 'manifest.json.sha256'), hash(manifest));
  await writeFile(join(directory, 'Team-DevSpace-fixture.pkg'), 'fixture');
  await writeFile(join(directory, 'Team-DevSpace-fixture.pkg.sha256'), hash('fixture'));
  const verify = () => exec(process.execPath, ['scripts/verify-release.mjs', '--target', target, '--installed', installed],
    { cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } });
  await writeFile(join(installed, 'install-manifest.json'), '{}');
  await assert.rejects(verify(), error => /installed manifest differs/.test(error.stderr));
  await writeFile(join(installed, 'install-manifest.json'), manifest);
  await writeFile(join(bundle, nodePath), 'approved target binary');
  await writeFile(join(installed, nodePath), 'altered target binary');
  await assert.rejects(verify(), error => /Installed payload differs from the built target/.test(error.stderr));
});

test('source evidence detects staged, unstaged and untracked changes while accepting canonical EOLs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-source-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => exec('git', args, { cwd: root, timeout: 10000 });
  await git('init', '-q');
  await writeFile(join(root, '.gitattributes'), '*.txt text eol=lf\n');
  await writeFile(join(root, 'source.txt'), 'original\n');
  await git('add', '.gitattributes', 'source.txt');
  await git('-c', 'user.name=Acceptance fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const clean = sourceIdentity(root);
  assert.match(clean.commit, /^[a-f0-9]{40}$/);
  assert.equal(clean.sourceDirty, false);
  await writeFile(join(root, 'source.txt'), 'original\r\n');
  assert.equal(sourceIdentity(root).sourceDirty, false, 'Git-normalized unchanged content is not a source modification');
  await writeFile(join(root, 'source.txt'), 'edited\n');
  assert.equal(sourceIdentity(root).sourceDirty, true);
  await git('add', 'source.txt');
  assert.equal(sourceIdentity(root).sourceDirty, true, 'Staging edits must not hide them from provenance');
  await git('reset', '--quiet', 'HEAD', '--', 'source.txt');
  await writeFile(join(root, 'source.txt'), 'original\n');
  await writeFile(join(root, 'untracked.mjs'), '// new source');
  assert.equal(sourceIdentity(root).sourceDirty, true);
  await rm(join(root, 'untracked.mjs'));
  assert.equal(sourceIdentity(root).sourceDirty, false);
  if (process.platform !== 'win32') {
    await git('config', 'core.fileMode', 'true');
    await chmod(join(root, 'source.txt'), 0o755);
    assert.equal(sourceIdentity(root).sourceDirty, true, 'Changed tracked executable modes must remain dirty');
    await chmod(join(root, 'source.txt'), 0o644);
    assert.equal(sourceIdentity(root).sourceDirty, false);
  }
  assert.throws(() => sourceIdentity(join(root, 'missing')), /ENOENT/);
});

test('employee Windows acceptance requires explicit opt-in and rejects conflicting installer ownership', async () => {
  await assert.rejects(exec(process.execPath, [resolve('scripts/windows-installed-smoke.mjs')], {
    timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' },
  }), error => /Explicit --live|Windows-only/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [resolve('scripts/platform-acceptance.mjs'), '--employee-windows-installer', '--direct-windows-installer'], {
    timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' },
  }), error => /cannot be combined/.test(error.stderr));
});

test('strict Windows acceptance rejects isolated-only installer evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-final-windows-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['verify-acceptance.mjs', 'build-utils.mjs', 'download-catalog.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  await copyCatalogContract(root);
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ ...release, version: '1.2.3', distribution: { ...release.distribution, targets: ['win32-x64'] } }));
  const directory = join(root, 'release/offline/1.2.3/win32-x64');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'Team-DevSpace-1.2.3-windows-x64-setup.exe'), 'test-only bytes');
  const evidence = { schema: 1, passed: true, release: '1.2.3', target: 'win32-x64',
    entrypoint: { name: 'Team-DevSpace-1.2.3-windows-x64-setup.exe', sha256: createHash('sha256').update('test-only bytes').digest('hex') },
    checks: { releaseLayout: true, installerTransaction: true, installedPayload: true, zeroResidue: true,
      trayProtocol: true, traySingleInstance: true, nativeStartup: true, finalEntrypointTransaction: false } };
  const verify = () => exec(process.execPath, ['scripts/verify-acceptance.mjs'], {
    cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', GITHUB_SHA: '', TEAM_DEVSPACE_REQUIRE_FINAL_WINDOWS: '1' },
  });
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify(evidence));
  await assert.rejects(verify(), error => /final Windows installer bytes/.test(error.stderr));
  evidence.checks.finalEntrypointTransaction = true;
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify(evidence));
  assert.match((await verify()).stdout, /"accepted":true/);
});

test('system macOS acceptance refuses a non-Codemagic host before touching installed paths', async () => {
  await assert.rejects(exec(process.execPath, [resolve('scripts/macos-package-smoke.mjs')], {
    timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', CI: '', CM_BUILD_ID: '' },
  }), error => /requires a disposable, non-root Codemagic/.test(error.stderr));
});
