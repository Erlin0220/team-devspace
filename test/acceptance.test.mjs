import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
test('release acceptance rejects extracted-only PKGs and missing native startup evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-acceptance-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['verify-acceptance.mjs', 'build-utils.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ version: '1.2.3', distribution: { targets: ['darwin-arm64'] } }));
  const directory = join(root, 'release/offline/1.2.3/darwin-arm64');
  await mkdir(directory, { recursive: true });
  const bytes = 'fixture package bytes';
  await writeFile(join(directory, 'fixture.pkg'), bytes);
  const evidence = { schema: 1, passed: true, release: '1.2.3', target: 'darwin-arm64',
    entrypoint: { name: 'fixture.pkg', sha256: createHash('sha256').update(bytes).digest('hex') },
    checks: { releaseLayout: true, installerTransaction: true, zeroResidue: true,
      trayProtocol: true, traySingleInstance: true, finalEntrypointTransaction: true, nativeStartup: true } };
  const verify = () => exec(process.execPath, ['scripts/verify-acceptance.mjs'], {
    cwd: root, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', GITHUB_SHA: '' },
  });
  for (const field of ['finalEntrypointTransaction', 'nativeStartup']) {
    await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ ...evidence, checks: { ...evidence.checks, [field]: false } }));
    await assert.rejects(verify(), error => /macOS.*(installed|lifecycle)/.test(error.stderr));
  }
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify(evidence));
  assert.match((await verify()).stdout, /"accepted":true/);
});

test('a failed acceptance attempt invalidates a previous green report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-stale-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  for (const file of ['platform-acceptance.mjs', 'build-utils.mjs']) await cp(join('scripts', file), join(root, 'scripts', file));
  const target = `${process.platform}-${process.arch}`;
  await writeFile(join(root, 'release.config.json'), JSON.stringify({ version: '1.2.3', distribution: { targets: [target] } }));
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

test('system macOS acceptance refuses a non-Codemagic host before touching installed paths', async () => {
  await assert.rejects(exec(process.execPath, [resolve('scripts/macos-package-smoke.mjs')], {
    timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', CI: '', CM_BUILD_ID: '' },
  }), error => /requires a disposable, non-root Codemagic/.test(error.stderr));
});
