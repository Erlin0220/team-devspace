import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiRequest, buildRequest, buildArchitecture, matchesBuild, requiredArtifacts,
  publicBuild, collectBuild, findReusableBuild, listBuilds } from '../scripts/codemagic.mjs';
import release, { resolveReleaseProfile, releaseProfileDigest } from '../scripts/release-profile.mjs';

const appId = 'a'.repeat(24), commit = 'b'.repeat(40), id = 'c'.repeat(24);
const token = 'private-test-token';
const context = { appId, commit, architecture: 'arm64', version: '0.2.4' };
const baseBuild = () => ({ id, app_id: appId, workflow: { id: 'macos-package' }, status: 'finished',
  commit: { hash: commit }, build_inputs: { architecture: 'arm64' }, labels: [] });

async function fixture(t, architecture = 'arm64') {
  const directory = await mkdtemp(join(tmpdir(), 'tds-codemagic-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `Team-DevSpace-0.2.4-macos-${architecture}.pkg`;
  const bytes = Buffer.from(`accepted test PKG for ${architecture}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const receipt = { schema: 1, passed: true, release: '0.2.4', target: `darwin-${architecture}`, commit,
    sourceDirty: false, entrypoint: { name, sha256: hash }, checks: { releaseLayout: true,
      installerTransaction: true, installedPayload: true, finalEntrypointTransaction: true,
      trayProtocol: true, traySingleInstance: true, nativeStartup: true, zeroResidue: true },
    limitations: ['Synthetic bytes for unit testing only.'] };
  const bodies = new Map([[name, bytes], [`${name}.sha256`, Buffer.from(`${hash}  ${name}\n`)],
    ['acceptance.json', Buffer.from(JSON.stringify(receipt))]]);
  const build = { ...baseBuild(), build_inputs: { architecture }, artifacts: [...bodies].map(([name, body]) => ({
    name, size_in_bytes: body.length, short_lived_download_url: `https://artifacts.example/${name}?signature=secret`, type: 'file' })) };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.headers, undefined, 'Never send the account token to the artifact origin');
    const body = bodies.get(new URL(url).pathname.slice(1));
    return new Response(body, { status: body ? 200 : 404 });
  };
  const replace = (name, body) => {
    bodies.set(name, Buffer.from(body));
    build.artifacts.find(item => item.name === name).size_in_bytes = Buffer.byteLength(body);
  };
  return { directory, name, bytes, hash, receipt, bodies, build, calls, fetcher, replace,
    options: { ...context, architecture, directory, fetcher } };
}

test('documented manual POST uses an immutable tag, exact commit and separate target variables', () => {
  for (const architecture of ['arm64', 'x64']) {
    const body = buildRequest({ ...context, architecture });
    assert.equal(body.workflowId, 'macos-package');
    assert.equal(body.tag, `ci/macos-${commit}`);
    assert.equal(body.environment.variables.TEAM_DEVSPACE_BUILD_ARCHITECTURE, architecture);
    assert.equal(body.environment.variables.TEAM_DEVSPACE_EXPECTED_COMMIT, commit);
    assert.equal(body.branch, undefined);
    assert.ok(body.labels.includes(`tds-target:darwin-${architecture}`));
  }
  assert.throws(() => buildRequest({ ...context, architecture: 'both' }), /Invalid/);
  assert.throws(() => buildRequest({ ...context, commit: 'main' }), /Invalid/);
});

test('GET retries bounded transient failures and sends auth only to official API', async () => {
  let calls = 0;
  const result = await apiRequest(`/builds/${id}`, { token, pause: async () => {}, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, `https://codemagic.io/api/v3/builds/${id}`);
    assert.equal(options.headers['x-auth-token'], token);
    assert.equal(options.redirect, 'error');
    return calls === 1 ? new Response(null, { status: 429 }) : Response.json({ data: baseBuild() });
  } });
  assert.equal(calls, 2);
  assert.equal(result.data.id, id);
});

test('transitional builds carry only the explicit public edition and never reuse a different profile', () => {
  const profile = { gateway: 'https://gateway.example.test', downloadOrigin: 'https://downloads.example.test', updatePublicKey: 'B'.repeat(43) };
  const expectedProfileSha256 = releaseProfileDigest(resolveReleaseProfile(release, profile));
  const body = buildRequest({ ...context, profile });
  assert.deepEqual(JSON.parse(body.environment.variables.TEAM_DEVSPACE_RELEASE_PROFILE_JSON), profile);
  const build = { ...baseBuild(), labels: body.labels };
  assert.equal(matchesBuild(build, { ...context, expectedProfileSha256 }), true);
  assert.equal(matchesBuild(baseBuild(), { ...context, expectedProfileSha256 }), false);
  assert.equal(matchesBuild(build, { ...context, expectedProfileSha256: '0'.repeat(64) }), false);
  assert.throws(() => buildRequest({ ...context, profile: { ...profile, token: 'must-not-send' } }), /accepts/);
});

test('transitional collection checks the full profile digest before downloading a large package', async t => {
  const f = await fixture(t);
  const expectedProfileSha256 = 'd'.repeat(64);
  f.build.labels = [`tds-profile:${expectedProfileSha256.slice(0, 32)}`];
  await assert.rejects(collectBuild(f.build, { ...f.options, expectedProfileSha256 }), /different release profile/);
  assert.ok(f.calls.every(call => !new URL(call.url).pathname.endsWith('.pkg')));
});

test('POST never automatically retries a possibly accepted chargeable build', async () => {
  let calls = 0;
  await assert.rejects(apiRequest('/builds', { token, legacy: true, method: 'POST', body: buildRequest(context),
    fetcher: async url => { calls++; assert.equal(url, 'https://api.codemagic.io/builds'); throw new TypeError(`network error ${token}`); } }),
  error => /inspect existing builds/.test(error.message) && !error.message.includes(token));
  assert.equal(calls, 1);
});

test('authentication failures are not retried or echoed, and oversized metadata is rejected', async () => {
  let calls = 0;
  await assert.rejects(apiRequest('/builds', { token, fetcher: async () => {
    calls++; return new Response(`sensitive ${token}`, { status: 401 });
  } }), error => /HTTP 401/.test(error.message) && !error.message.includes(token));
  assert.equal(calls, 1);
  await assert.rejects(apiRequest('/builds', { token, fetcher: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) }), /size limit/);
});

test('personal accounts discover only the latest app build without requiring a team id', async () => {
  const seen = [];
  const builds = await listBuilds({ appId, token, fetcher: async url => {
    seen.push(url);
    if (url === 'https://codemagic.io/api/v3/user/apps?page_size=100') {
      return Response.json({ data: [{ id: appId, name: 'team-devspace', last_build_id: id }] });
    }
    if (url === `https://codemagic.io/api/v3/builds/${id}`) return Response.json({ data: baseBuild() });
    return new Response(null, { status: 404 });
  } });
  assert.deepEqual(seen, [
    'https://codemagic.io/api/v3/user/apps?page_size=100',
    `https://codemagic.io/api/v3/builds/${id}`,
  ]);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].id, id);
});

test('personal account validation accepts an app with no previous builds', async () => {
  const builds = await listBuilds({ appId, token, fetcher: async url => {
    assert.equal(url, 'https://codemagic.io/api/v3/user/apps?page_size=100');
    return Response.json({ data: [{ id: appId, name: 'team-devspace', last_build_id: null }] });
  } });
  assert.deepEqual(builds, []);
});

test('personal account validation rejects an app not visible to the token', async () => {
  await assert.rejects(listBuilds({ appId, token, fetcher: async () => Response.json({ data: [] }) }), /not visible/);
});

test('reuse requires exact app, workflow, actual commit and architecture', () => {
  const build = baseBuild();
  assert.equal(matchesBuild(build, context), true);
  assert.equal(matchesBuild(build, { ...context, architecture: 'x64' }), false);
  assert.equal(matchesBuild({ ...build, app_id: 'd'.repeat(24) }, context), false);
  assert.equal(matchesBuild({ ...build, workflow: { id: 'another-workflow' } }, context), false);
  assert.equal(matchesBuild({ ...build, commit: { hash: 'e'.repeat(40) } }, context), false);
  // API override is authoritative even when the UI-only input retained its default.
  assert.equal(buildArchitecture({ ...build, labels: ['tds-target:darwin-x64'] }), 'x64');
  assert.throws(() => buildArchitecture({ ...build, labels: ['tds-target:darwin-arm64', 'tds-target:darwin-x64'] }), /Conflicting/);
});

test('queued builds can be reconciled by immutable tag and labels, never after a mismatched checkout', () => {
  const build = { ...baseBuild(), status: 'queued', commit: null, tag: `ci/macos-${commit}`,
    labels: [`tds-commit:${commit}`, 'tds-target:darwin-arm64'] };
  assert.equal(matchesBuild(build, context, { pending: true }), true);
  assert.equal(matchesBuild(build, context), false);
  assert.equal(matchesBuild({ ...build, commit: { hash: 'e'.repeat(40) } }, context, { pending: true }), false);
  assert.equal(matchesBuild({ ...build, status: 'finished' }, context, { pending: true }), false);
});

test('Codemagic bundle is accepted as the metadata carrier when direct files are not listed', () => {
  const build = baseBuild();
  const pkg = 'Team-DevSpace-0.2.4-macos-arm64.pkg';
  build.artifacts = [
    { name: pkg, size_in_bytes: 100, short_lived_download_url: 'https://artifacts.example/pkg' },
    { name: 'team-devspace_46_artifacts.zip', size_in_bytes: 200, short_lived_download_url: 'https://artifacts.example/bundle' },
  ];
  const selected = requiredArtifacts(build, '0.2.4', 'arm64');
  assert.equal(selected.pkg.name, pkg);
  assert.equal(selected.checksum, null);
  assert.equal(selected.receipt, null);
  assert.equal(selected.bundle.name, 'team-devspace_46_artifacts.zip');
  build.artifacts.push(
    { name: `${pkg}.sha256`, size_in_bytes: 64, short_lived_download_url: 'https://artifacts.example/sha' },
    { name: 'acceptance.json', size_in_bytes: 100, short_lived_download_url: 'https://artifacts.example/acceptance' },
  );
  assert.equal(requiredArtifacts(build, '0.2.4', 'arm64').bundle, null);
});

test('artifact selection is unique and normalizes CI paths to allowlisted filenames', async t => {
  const f = await fixture(t);
  f.build.artifacts[0].name = `../../release/${f.name}`;
  assert.equal(requiredArtifacts(f.build, '0.2.4', 'arm64').pkg.name, f.name);
  const result = await collectBuild(f.build, f.options);
  assert.equal(result.sha256, f.hash);
  assert.deepEqual(await readFile(join(f.directory, 'darwin-arm64', f.name)), f.bytes);
  f.build.artifacts.push({ ...f.build.artifacts[0] });
  assert.throws(() => requiredArtifacts(f.build, '0.2.4', 'arm64'), /exactly one/);
  assert.equal(JSON.stringify(publicBuild(f.build)).includes('signature=secret'), false);
});

for (const architecture of ['arm64', 'x64']) {
  test(`collects and independently verifies ${architecture}; a repeat reuses exact accepted bytes`, async t => {
    const f = await fixture(t, architecture);
    const first = await collectBuild(f.build, f.options);
    assert.equal(first.reused, false);
    assert.equal(first.target, `darwin-${architecture}`);
    const second = await collectBuild(f.build, f.options);
    assert.equal(second.reused, true);
    assert.equal(f.calls.filter(call => new URL(call.url).pathname.endsWith('.pkg')).length, 1);
    assert.deepEqual(await readdir(f.directory), [`darwin-${architecture}`]);
  });
}

test('reuse resolves full details when the recent-list response omits architecture inputs', async t => {
  const f = await fixture(t, 'x64');
  const listed = [{ id, status: 'finished', commit: { hash: commit } }];
  let loaded = 0;
  const found = await findReusableBuild(listed, { ...context, architecture: 'x64' }, '0.2.4', async buildId => {
    loaded++; assert.equal(buildId, id); return f.build;
  });
  assert.equal(found.id, id);
  assert.equal(loaded, 1);
  assert.equal(await findReusableBuild(listed, context, '0.2.4', async () => f.build), null);
});

test('reuse skips incomplete artifacts and a build that failed after listing', async t => {
  const f = await fixture(t);
  const listed = [{ id, status: 'finished', commit: { hash: commit } }];
  assert.equal(await findReusableBuild(listed, context, '0.2.4', async () => ({ ...f.build, artifacts: [] })), null);
  assert.equal(await findReusableBuild(listed, context, '0.2.4', async () => ({ ...f.build, status: 'failed' })), null);
});

test('failed builds and old source receipts cannot become final artifacts', async t => {
  const f = await fixture(t);
  await assert.rejects(collectBuild({ ...f.build, status: 'failed' }, f.options), /successful exact/);
  assert.equal(f.calls.length, 0);
  f.receipt.commit = 'e'.repeat(40);
  f.replace('acceptance.json', JSON.stringify(f.receipt));
  await assert.rejects(collectBuild(f.build, f.options), /requested final source/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('dirty source, wrong architecture and unaccepted installation are rejected', async t => {
  const f = await fixture(t);
  f.receipt.sourceDirty = true;
  f.replace('acceptance.json', JSON.stringify(f.receipt));
  await assert.rejects(collectBuild(f.build, f.options), /requested final source/);
  f.receipt.sourceDirty = false;
  f.receipt.target = 'darwin-x64';
  f.replace('acceptance.json', JSON.stringify(f.receipt));
  await assert.rejects(collectBuild(f.build, f.options), /requested final source/);
  f.receipt.target = 'darwin-arm64';
  f.receipt.checks.finalEntrypointTransaction = false;
  f.replace('acceptance.json', JSON.stringify(f.receipt));
  await assert.rejects(collectBuild(f.build, f.options), /system installer/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('mismatched checksums, tampered and truncated package bytes fail closed', async t => {
  const f = await fixture(t);
  f.replace(`${f.name}.sha256`, `${'e'.repeat(64)}\n`);
  await assert.rejects(collectBuild(f.build, f.options), /checksum and acceptance/);
  f.replace(`${f.name}.sha256`, `${f.hash}\n`);
  f.replace(f.name, Buffer.from('tampered bytes'));
  await assert.rejects(collectBuild(f.build, f.options), /PKG hash/);
  f.build.artifacts[0].size_in_bytes++;
  await assert.rejects(collectBuild(f.build, f.options), /Truncated/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('unknown existing directories and different accepted bytes are never overwritten', async t => {
  const f = await fixture(t);
  const target = join(f.directory, 'darwin-arm64');
  await mkdir(target);
  await writeFile(join(target, 'operator-file'), 'keep');
  await assert.rejects(collectBuild(f.build, f.options), /without accepted provenance/);
  assert.equal(await readFile(join(target, 'operator-file'), 'utf8'), 'keep');
  await writeFile(join(target, 'acceptance.json'), JSON.stringify({ ...f.receipt, commit: 'e'.repeat(40) }));
  await assert.rejects(collectBuild(f.build, f.options), /different provenance/);
  assert.equal(await readFile(join(target, 'operator-file'), 'utf8'), 'keep');
});

test('unsafe artifact redirects are refused without sending API credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(collectBuild(f.build, { ...f.options, fetcher: async (_url, options) => {
    assert.equal(options.headers, undefined);
    return new Response(null, { status: 302, headers: { location: 'http://insecure.example/file' } });
  } }), /Unsafe/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('existing workflow remains manual-only with one build/acceptance chain and an exact-source guard', async () => {
  const yaml = await readFile(new URL('../codemagic.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(yaml, /^\s*triggering:/m);
  assert.match(yaml, /TEAM_DEVSPACE_BUILD_ARCHITECTURE:-\$\{\{ inputs\.architecture \}\}/);
  assert.match(yaml, /test "\$\(git rev-parse HEAD\)" = "\$expected_commit"/);
  assert.equal((yaml.match(/name: Build unsigned macOS package/g) ?? []).length, 1);
  assert.equal((yaml.match(/name: Accept installed macOS package/g) ?? []).length, 1);
  assert.match(yaml, /instance_type: mac_mini_m2/);
});
