import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { run, sha256File, sourceIdentity } from './build-utils.mjs';
import { packageName } from '../client/release-catalog.mjs';
import release, { requireProductionProfile, releaseProfileDigest } from './release-profile.mjs';

// Re-accept Codemagic's exact x64 PKG on an Intel Mac. This never compiles,
// repackages, signs or otherwise changes the candidate executable bytes.
assert.ok(process.platform === 'darwin' && process.arch === 'x64' && process.getuid() !== 0 &&
  process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_OS === 'macOS' && process.env.RUNNER_ARCH === 'X64', 'Use the disposable Intel macOS workflow');
const identity = sourceIdentity();
assert.equal(identity.sourceDirty, false);
assert.equal(identity.commit, process.env.GITHUB_SHA);
const target = 'darwin-x64';
const name = packageName(release.version, target);
const input = resolve('build/intel-input');
const expectedHash = process.env.TEAM_DEVSPACE_PACKAGE_SHA256;
assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/);
assert.equal(await sha256File(join(input, name)), expectedHash);
const prior = JSON.parse(await readFile(join(input, 'acceptance-darwin-x64.json'), 'utf8'));
assert.equal(prior.passed, true);
assert.equal(prior.target, target);
assert.equal(prior.release, release.version);
assert.equal(prior.commit, identity.commit);
assert.equal(prior.sourceDirty, false);
assert.equal(prior.entrypoint.name, name);
assert.equal(prior.entrypoint.sha256, expectedHash);
requireProductionProfile(release);
assert.equal(prior.releaseProfileSha256, releaseProfileDigest(release), 'Codemagic receipt must match the operator profile');
const output = resolve('release/offline', release.version, target);
await mkdir(output, { recursive: true });
await cp(join(input, name), join(output, name));
await writeFile(join(output, `${name}.sha256`), `${expectedHash}\n`);
const work = await mkdtemp(join(tmpdir(), 'tds-intel-reference-'));
const bundle = resolve('build/bundle-darwin-x64');
let linked = false;
try {
  const expanded = join(work, 'pkg');
  await run('/usr/sbin/pkgutil', ['--expand-full', join(output, name), expanded]);
  const embedded = (await readdir(expanded, { recursive: true }))
    .filter(path => path.endsWith('Contents/Resources/release-manifest.json'));
  assert.equal(embedded.length, 1, 'Expected exactly one embedded payload manifest');
  const media = dirname(join(expanded, embedded[0]));
  const bytes = await readFile(join(media, 'release-manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.release, release.version);
  assert.equal(manifest.target, target);
  await writeFile(join(output, 'manifest.json'), bytes);
  await writeFile(join(output, 'manifest.json.sha256'), `${createHash('sha256').update(bytes).digest('hex')}\n`);
  // Only the pinned archive paths are copied into the verifier's usual layout.
  for (const component of manifest.components) {
    assert.match(component.path, /^objects\/sha256\/[a-f0-9]{64}\/[a-z0-9-]+\.tar\.gz$/);
    await mkdir(dirname(join(output, component.path)), { recursive: true });
    await cp(join(media, component.path), join(output, component.path));
  }
  const reference = join(work, 'reference');
  await run('/bin/sh', [join(media, 'bootstrap.sh'), '--root', reference,
    '--manifest', join(media, 'release-manifest.json'), '--offline', media, '--setup', 'none'],
  { env: { TEAM_DEVSPACE_HOME: join(work, 'state'), TEAM_DEVSPACE_CLI_DIR: join(work, 'bin'), NODE_OPTIONS: '' }, timeout: 240000 });
  const extracted = (await readFile(join(reference, 'active-path'), 'utf8')).trim();
  assert.ok(extracted.startsWith(`${reference}/versions/`));
  await symlink(extracted, bundle, 'dir'); linked = true;
  await run(process.execPath, ['scripts/platform-acceptance.mjs', '--system-macos-installer'], { timeout: 1200000 });
  assert.equal(await sha256File(join(output, name)), expectedHash);
  const accepted = JSON.parse(await readFile(join(output, 'acceptance.json'), 'utf8'));
  assert.equal(accepted.checks.nativeArchitecture, true);
  assert.equal(accepted.entrypoint.sha256, expectedHash);
  console.log(JSON.stringify({ nativeIntelAccepted: true, commit: identity.commit, sha256: expectedHash, rebuilt: false }));
} finally {
  if (linked) await rm(bundle);
  await rm(work, { recursive: true, force: true });
}
