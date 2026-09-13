import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DOWNLOAD_TARGETS, packageName, httpsOrigin, validateCatalog } from '../scripts/download-catalog.mjs';
import { buildDownloadCatalog, prepareSite, prepareHomepage } from '../scripts/publish-downloads.mjs';
import { verifyAcceptance } from '../scripts/verify-acceptance.mjs';
import { renderAdmin } from '../gateway/admin-web.mjs';

const origin = 'https://downloads.example.com';
const commit = 'a'.repeat(40);
async function fixture(t, version = '1.0.0') {
  const root = await mkdtemp(join(tmpdir(), 'tds-downloads-test-'));
  t.after(async () => {
    if (process.platform !== 'win32') spawnSync('chmod', ['-R', 'u+w', root]);
    await rm(root, { recursive: true, force: true });
  });
  const input = join(root, 'input');
  for (const [index, target] of DOWNLOAD_TARGETS.entries()) {
    await mkdir(join(input, target), { recursive: true });
    // Deliberately synthetic bytes: these tests verify publishing mechanics, not real installation.
    await writeFile(join(input, target, packageName(version, target)), Buffer.alloc(64 + index, index + 1));
  }
  const catalog = await buildDownloadCatalog(input, version, commit);
  for (const target of DOWNLOAD_TARGETS) {
    await writeFile(join(input, target, 'acceptance.json'), JSON.stringify({ schema: 1, passed: true,
      release: version, target, commit, sourceDirty: false,
      entrypoint: { name: catalog.targets[target].file, sha256: catalog.targets[target].sha256 },
      checks: { releaseLayout: true, installerTransaction: true, installedPayload: true, zeroResidue: true,
        finalEntrypointTransaction: true, nativeStartup: true, trayProtocol: true, traySingleInstance: true },
      limitations: ['Synthetic test fixture, not installer execution evidence.'] }));
  }
  const site = join(root, 'site');
  await prepareSite(input, site, catalog, origin, `Fixture release ${version}\n`);
  return { root, input, catalog, site, version };
}

test('static release catalog has exactly four canonical packages and rejects unsafe identities', async t => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.catalog.targets), DOWNLOAD_TARGETS);
  assert.equal(httpsOrigin(origin), origin);
  for (const value of ['http://downloads.example.com', `${origin}/path`, `${origin}/`, 'https://x:y@downloads.example.com', 'https://downloads.example.com?x=1']) assert.throws(() => httpsOrigin(value));
  assert.throws(() => packageName('../1.0.0', 'win32-x64'));
  assert.throws(() => validateCatalog({ ...f.catalog, targets: { 'win32-x64': f.catalog.targets['win32-x64'] } }));
  assert.throws(() => validateCatalog({ ...f.catalog, targets: { ...f.catalog.targets, 'win32-x64': { ...f.catalog.targets['win32-x64'], file: '../payload.exe' } } }));
});

test('stable scripts pin immutable package URLs and hashes, with no enrollment or temporary ticket', async t => {
  const f = await fixture(t);
  const ps = await readFile(join(f.site, 'install.ps1'), 'utf8');
  const sh = await readFile(join(f.site, 'install.sh'), 'utf8');
  const page = await readFile(join(f.site, 'index.html'), 'utf8');
  const home = join(f.root, 'home');
  await prepareHomepage(home, f.catalog, origin);
  const homepage = await readFile(join(home, 'index.html'), 'utf8');
  for (const script of [ps, sh]) {
    assert.ok(script.includes(`${origin}/releases/1.0.0/`));
    assert.ok(!script.includes('?ticket='));
    assert.ok(!script.includes('Authorization'));
    assert.ok(!script.includes('/v1/enroll'));
  }
  assert.ok(ps.includes(f.catalog.targets['win32-x64'].sha256));
  assert.ok(sh.includes('hw.optional.arm64'));
  assert.ok(sh.includes('--setup none'));
  assert.ok(!sh.includes('xattr -d') && !sh.includes('spctl --master-disable'));
  assert.ok(page.includes(`${origin}/releases/1.0.0/install.ps1`));
  assert.ok(page.includes(`${origin}/releases/`));
  assert.ok(homepage.includes(`${origin}/install.ps1`));
  assert.ok(homepage.includes(`${origin}/stable/windows-x64.exe`));
  assert.ok(homepage.includes('把开发机，安全带到 ChatGPT 里。'));
  assert.ok(homepage.includes('Team DevSpace') && !homepage.includes('tailscale.com'));
  assert.ok(!renderAdmin([]).includes('issue-downloads'));
  assert.equal(spawnSync('bash', ['-n', join(f.site, 'install.sh').replaceAll('\\', '/')]).status, 0);
  assert.equal(spawnSync('bash', ['-n', resolve('scripts/download-server.sh').replaceAll('\\', '/')]).status, 0);
  if (process.platform === 'win32') {
    const file = join(f.site, 'install.ps1').replaceAll("'", "''");
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); if($e.Count){$e | Out-String | Write-Error; exit 1}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test('publication requires final installer evidence for exact commit and exact bytes', async t => {
  const f = await fixture(t);
  const args = { version: f.version, root: f.input, expectedCommit: commit, requireFinalWindows: true };
  await verifyAcceptance(args);
  await assert.rejects(verifyAcceptance({ ...args, expectedCommit: 'b'.repeat(40) }), /another commit/);
  const path = join(f.input, 'win32-x64', 'acceptance.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...evidence, sourceDirty: true }));
  await assert.rejects(verifyAcceptance(args), /dirty source/);
  await writeFile(path, JSON.stringify({ ...evidence, checks: { ...evidence.checks, finalEntrypointTransaction: false } }));
  await assert.rejects(verifyAcceptance(args), /final Windows installer/);
  await writeFile(path, JSON.stringify(evidence));
  await writeFile(join(f.input, 'win32-x64', evidence.entrypoint.name), 'corrupt');
  await assert.rejects(verifyAcceptance(args), /differs from the accepted bytes/);
});

test('server publication is immutable, all-or-nothing, CAS guarded and genuinely reversible', { skip: process.platform === 'win32' }, async t => {
  const first = await fixture(t, '1.0.0');
  const second = await fixture(t, '1.0.1');
  const server = join(first.root, 'server');
  const script = resolve('scripts/download-server.sh');
  const run = (action, version = '', stage = '') => execFileSync('bash', [script, server, action, version, stage], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('prepare');
  const siteId = 'a'.repeat(32);
  run('site-stage', siteId);
  await cp(join(first.site, 'index.html'), join(server, '.incoming', `site-${siteId}`, 'index.html'));
  run('site-publish', siteId);
  assert.equal(await readFile(join(server, 'public', 'index.html'), 'utf8'), await readFile(join(first.site, 'index.html'), 'utf8'));
  const upload = async (f, id) => { run('stage', f.version, id); await cp(f.site, join(server, '.incoming', id), { recursive: true }); };
  await upload(first, '1'.repeat(32));
  run('publish', first.version, '1'.repeat(32));
  assert.equal(run('current').trim(), '-');
  run('activate', first.version, '-');
  assert.equal(await readlink(join(server, 'public/stable')), 'releases/1.0.0');
  await upload(second, '2'.repeat(32));
  await writeFile(join(server, '.incoming', '2'.repeat(32), second.catalog.targets['linux-x64'].file), 'corrupt');
  assert.throws(() => run('publish', second.version, '2'.repeat(32)));
  assert.equal(run('current').trim(), 'releases/1.0.0');
  run('discard', second.version, '2'.repeat(32));
  await upload(second, '3'.repeat(32));
  run('publish', second.version, '3'.repeat(32));
  assert.throws(() => run('activate', second.version, '-'), /Stable changed/);
  run('activate', second.version, 'releases/1.0.0');
  assert.equal(run('current').trim(), 'releases/1.0.1');
  run('activate', first.version, 'releases/1.0.1');
  assert.equal(run('current').trim(), 'releases/1.0.0');
  assert.equal(await readFile(join(server, 'public/stable/windows-x64.exe.sha256'), 'utf8'), `${first.catalog.targets['win32-x64'].sha256}\n`);
  await upload(first, '4'.repeat(32));
  await writeFile(join(server, '.incoming', '4'.repeat(32), 'SHA256SUMS'), await readFile(join(second.site, 'SHA256SUMS')));
  assert.throws(() => run('publish', first.version, '4'.repeat(32)));
  assert.equal(run('current').trim(), 'releases/1.0.0');
  run('discard', first.version, '4'.repeat(32));
  assert.throws(() => run('stage', '../bad', '5'.repeat(32)));
});
