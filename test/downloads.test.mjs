import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DOWNLOAD_TARGETS, ALIASES, packageName, httpsOrigin, validateCatalog, downloadPage } from '../scripts/download-catalog.mjs';
import { buildDownloadCatalog, prepareSite, prepareHomepage, main, retainedReleaseVersions } from '../scripts/publish-downloads.mjs';

test('release cleanup retains cold-cache upgrade fixtures independently of rollout policy', () => {
  const retained = retainedReleaseVersions('0.2.6', { auto: '0.2.5', minimumSupported: null });
  assert.deepEqual(retained, ['0.2.6', '0.2.5', '0.2.3', '0.2.4']);
  assert.deepEqual(retainedReleaseVersions('0.2.4', { auto: '0.2.4', minimumSupported: '0.2.3' }), ['0.2.4', '0.2.3']);
});
import { verifyAcceptance } from '../scripts/verify-acceptance.mjs';
import { renderAdmin } from '../gateway/admin-web.mjs';
import { signUpdateFixture } from './update-fixture.mjs';

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
        existingInstallUpgrade: true,
        nativeArchitecture: true,
        finalEntrypointTransaction: true, nativeStartup: true, trayProtocol: true, traySingleInstance: true },
      limitations: ['Synthetic test fixture, not installer execution evidence.'] }));
  }
  const site = join(root, 'site');
  await prepareSite(input, site, catalog, origin, `Fixture release ${version}\n`, { signer: signUpdateFixture });
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
  const serverScript = await readFile(resolve('scripts/download-server.sh'), 'utf8');
  const page = await readFile(join(f.site, 'index.html'), 'utf8');
  const home = join(f.root, 'home');
  await prepareHomepage(home, f.catalog, origin);
  const homepage = await readFile(join(home, 'index.html'), 'utf8');
  assert.deepEqual(await readFile(join(home, 'devspace-logo-light.png')), await readFile(resolve('platform/macos/devspace-logo-light.png')));
  assert.equal(await readFile(join(home, 'download-site.js'), 'utf8'), await readFile(resolve('assets/download-site.js'), 'utf8'));
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
  assert.ok(!page.includes('历史版本'));
  assert.ok(!homepage.includes(`href="${origin}/releases/"`));
  assert.ok(homepage.includes(`${origin}/install.ps1`));
  assert.ok(homepage.includes(`${origin}/stable/windows-x64.exe`));
  assert.ok(homepage.includes('<h1 id="hero-title">') && homepage.includes('你自己的开发环境'));
  assert.ok(homepage.includes('Team DevSpace') && !homepage.includes('tailscale.com'));
  assert.ok(!renderAdmin([]).includes('issue-downloads'));
  assert.match(serverScript, /@entry path [^\n]*\/update\.json/,
    'Stable signed update metadata must be reachable from /update.json');
  assert.equal(spawnSync('bash', ['-n', join(f.site, 'install.sh').replaceAll('\\', '/')]).status, 0);
  assert.equal(spawnSync('bash', ['-n', resolve('scripts/download-server.sh').replaceAll('\\', '/')]).status, 0);
  if (process.platform === 'win32') {
    const file = join(f.site, 'install.ps1').replaceAll("'", "''");
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); if($e.Count){$e | Out-String | Write-Error; exit 1}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test('homepage preserves fixed and pinned download identities within the publication budget', async t => {
  const { catalog } = await fixture(t);
  for (const stable of [true, false]) {
    const page = downloadPage(catalog, origin, { stable });
    assert.ok(Buffer.byteLength(page) < 65536);
    assert.ok(page.includes('prefers-reduced-motion:reduce'));
    assert.ok(page.includes('forced-colors:active'));
    assert.ok(!page.includes('pause-motion') && !page.includes('暂停动效') && !page.includes('继续动效'));
    assert.ok(page.includes('aria-labelledby="hero-title"'));
    assert.ok(page.includes(`${origin}/devspace-logo-light.png`));
    assert.ok(page.includes(`<link rel="icon" href="${origin}/devspace-logo-light.png" type="image/png">`));
    assert.ok(page.includes(`${origin}/download-site.js`));
    assert.equal((page.match(/data-copy-command/g) ?? []).length, 2);
    assert.ok(page.includes('复制脚本') && !page.includes('查看脚本'));
    assert.ok(page.includes('.nav .nav-cta:hover{background:#fff;border-color:#fff;color:#151417}'));
    assert.ok(page.includes('不代表当前设备的实时状态'));
    const base = stable ? origin : `${origin}/releases/${catalog.version}`;
    assert.ok(page.includes(`<code>irm ${base}/install.ps1 | iex</code>`));
    assert.ok(page.includes(`<code>curl -fsSL ${base}/install.sh | sh</code>`));
    for (const target of DOWNLOAD_TARGETS) {
      const url = stable ? `${origin}/stable/${ALIASES[target]}` : `${base}/${catalog.targets[target].file}`;
      assert.ok(page.includes(`href="${url}"`));
      assert.ok(page.includes(`href="${url}.sha256"`));
    }
    assert.equal(page.includes('class="historical"'), !stable);
    assert.equal(page.includes(`当前稳定版 ${catalog.version}`), stable);
  }
});

test('homepage preview cannot publish and oversized pages fail before replacing staging output', async t => {
  for (const flag of ['--publish', '--site-only', '--init-server']) {
    await assert.rejects(main(['--preview', flag]), /separate.*operation/);
  }
  const { root, catalog } = await fixture(t);
  const output = join(root, 'homepage');
  const original = await prepareHomepage(output, catalog, origin);
  const version = `1.0.${'1'.repeat(10000)}`;
  const large = { ...catalog, version, targets: Object.fromEntries(DOWNLOAD_TARGETS.map(target =>
    [target, { ...catalog.targets[target], file: packageName(version, target) }])) };
  assert.ok(Buffer.byteLength(downloadPage(large, origin, { stable: true })) > 65536);
  await assert.rejects(prepareHomepage(output, large, origin), /verification budget/);
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), original);
});

test('publication requires final installer evidence for exact commit and exact bytes', async t => {
  const f = await fixture(t);
  const args = { version: f.version, root: f.input, expectedCommit: commit,
    requireFinalWindows: true, requireInstalledUpgrade: true, requireNativeArchitecture: true };
  await verifyAcceptance(args);
  await assert.rejects(verifyAcceptance({ ...args, expectedCommit: 'b'.repeat(40) }), /another commit/);
  const path = join(f.input, 'win32-x64', 'acceptance.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...evidence, sourceDirty: true }));
  await assert.rejects(verifyAcceptance(args), /dirty source/);
  await writeFile(path, JSON.stringify({ ...evidence, checks: { ...evidence.checks, finalEntrypointTransaction: false } }));
  await assert.rejects(verifyAcceptance(args), /final Windows installer/);
  await writeFile(path, JSON.stringify({ ...evidence, checks: { ...evidence.checks, existingInstallUpgrade: false } }));
  await assert.rejects(verifyAcceptance(args), /not cross-version upgrade acceptance/);
  await writeFile(path, JSON.stringify({ ...evidence, checks: { ...evidence.checks, nativeArchitecture: false } }));
  await assert.rejects(verifyAcceptance(args), /not Rosetta-only evidence/);
  await writeFile(path, JSON.stringify(evidence));
  const x64Path = join(f.input, 'darwin-x64', 'acceptance.json');
  const x64Evidence = JSON.parse(await readFile(x64Path, 'utf8'));
  await writeFile(x64Path, JSON.stringify({ ...x64Evidence,
    limitations: ['This process is not verified on matching native CPU architecture; Rosetta is not Intel hardware acceptance.'],
    checks: { ...x64Evidence.checks, nativeArchitecture: false } }));
  await verifyAcceptance({ ...args, allowRosettaDarwinX64: true });
  await writeFile(x64Path, JSON.stringify({ ...x64Evidence,
    limitations: [], checks: { ...x64Evidence.checks, nativeArchitecture: false } }));
  await assert.rejects(verifyAcceptance({ ...args, allowRosettaDarwinX64: true }), /must remain explicit/);
  await writeFile(x64Path, JSON.stringify(x64Evidence));
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
  const homepage = join(first.root, 'homepage');
  await prepareHomepage(homepage, first.catalog, origin);
  run('site-stage', siteId);
  for (const file of ['index.html', 'download-site.js', 'devspace-logo-light.png']) {
    await cp(join(homepage, file), join(server, '.incoming', `site-${siteId}`, file));
  }
  run('site-publish', siteId);
  assert.equal(await readFile(join(server, 'public', 'index.html'), 'utf8'), await readFile(join(homepage, 'index.html'), 'utf8'));
  assert.equal(await readFile(join(server, 'public', 'download-site.js'), 'utf8'), await readFile(join(homepage, 'download-site.js'), 'utf8'));
  assert.deepEqual(await readFile(join(server, 'public', 'devspace-logo-light.png')), await readFile(join(homepage, 'devspace-logo-light.png')));
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
  run('verify', first.version);
  assert.throws(() => run('prune', second.version), /Stable changed/);
  await mkdir(join(server, 'public/releases/operator-notes'));
  const unused = await fixture(t, '0.9.9');
  await upload(unused, '6'.repeat(32)); run('publish', unused.version, '6'.repeat(32));
  assert.throws(() => run('prune', first.version), /publication lease/);
  assert.throws(() => run('prune', first.version, `1000000000:${first.version}`), /expired/);
  const retention = `${Math.floor(Date.now() / 1000) + 900}:${first.version}`;
  run('prune', first.version, retention);
  assert.equal(run('current').trim(), 'releases/1.0.0');
  assert.deepEqual(JSON.parse(await readFile(join(server, 'public/releases.json'), 'utf8')),
    { schema: 1, versions: ['1.0.1', '1.0.0'] });
  assert.equal(await readFile(join(server, 'public/stable/windows-x64.exe.sha256'), 'utf8'), `${first.catalog.targets['win32-x64'].sha256}\n`);
  assert.ok(await readFile(join(server, 'public/releases/1.0.1/catalog.json')), 'Known-good predecessor remains recoverable');
  await assert.rejects(readFile(join(server, 'public/releases/0.9.9/catalog.json')), { code: 'ENOENT' });
  await writeFile(join(server, 'public/releases/operator-notes/kept.txt'), 'outside version ownership');
  run('prune', first.version, retention); // Idempotent and never removes non-version operator data.
  assert.equal(await readFile(join(server, 'public/releases/operator-notes/kept.txt'), 'utf8'), 'outside version ownership');
});
