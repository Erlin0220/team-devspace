import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import lockfile from 'proper-lockfile';
import { atomicJson, readJson, secureStateDirectory } from '../client/state.mjs';
import { run, sha256File, sourceIdentity } from './build-utils.mjs';
import { packageName } from './download-catalog.mjs';
import { verifyAcceptance } from './verify-acceptance.mjs';
import release, { resolveReleaseProfile, requireProductionProfile, releaseProfileDigest } from './release-profile.mjs';

const WORKFLOW = 'macos-package';
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{24}$/;
const ARCHES = ['arm64', 'x64'];
const FAILED = new Set(['failed', 'canceled', 'timeout', 'skipped']);
const TERMINAL = new Set(['finished', ...FAILED]);
const defaultConfig = () => join(homedir(), '.team-devspace-admin', 'codemagic.json');
const tagFor = commit => `ci/macos-${commit}`;
const targetLabel = architecture => `tds-target:darwin-${architecture}`;
const profileLabel = digest => `tds-profile:${digest.slice(0, 32)}`;

// Never retry a POST: a lost response may already have started a chargeable build.
export async function apiRequest(path, { token, method = 'GET', body, legacy = false,
  fetcher = fetch, pause = sleep } = {}) {
  if (!token || /[\r\n]/.test(token)) throw new Error('Configure a Codemagic API token first');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
  const origin = legacy ? 'https://api.codemagic.io' : 'https://codemagic.io/api/v3';
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetcher(`${origin}${path}`, { method, redirect: 'error',
        signal: AbortSignal.timeout(30000), headers: { 'x-auth-token': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`Codemagic ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('Codemagic metadata exceeded its size limit');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (method !== 'GET' || attempt >= 2 || !(error.retryable || error instanceof TypeError || error.name === 'TimeoutError')) {
        // Response bodies, request headers and signed artifact URLs are never logged.
        if (error.message.startsWith('Codemagic ') || error.message.includes('size limit')) throw error;
        throw new Error(`Codemagic ${method} request failed${method === 'POST' ? '; inspect existing builds before retrying' : ''}`);
      }
      await pause(1000 * (attempt + 1));
    }
  }
}

export function buildRequest({ appId, commit, architecture, profile }) {
  if (!ID.test(appId) || !SHA.test(commit) || !ARCHES.includes(architecture)) throw new Error('Invalid build identity');
  const edition = profile ? resolveReleaseProfile(release, profile) : null;
  if (edition) requireProductionProfile(edition);
  return { appId, workflowId: WORKFLOW, tag: tagFor(commit),
    labels: [targetLabel(architecture), ...(edition ? [profileLabel(releaseProfileDigest(edition))] : [])],
    environment: { variables: { TEAM_DEVSPACE_BUILD_ARCHITECTURE: architecture, TEAM_DEVSPACE_EXPECTED_COMMIT: commit,
      ...(edition ? { TEAM_DEVSPACE_RELEASE_PROFILE_JSON: JSON.stringify(profile) } : {}) } } };
}

export function buildArchitecture(build) {
  const labels = ARCHES.filter(arch => build.labels?.includes(targetLabel(arch)));
  if (labels.length > 1) throw new Error('Conflicting Codemagic architecture labels');
  if (labels.length === 1) return labels[0];
  return ARCHES.includes(build.build_inputs?.architecture) ? build.build_inputs.architecture : undefined;
}

export function matchesBuild(build, { appId, commit, architecture, expectedProfileSha256 }, { pending = false } = {}) {
  if (build.app_id !== appId || build.workflow?.id !== WORKFLOW || buildArchitecture(build) !== architecture) return false;
  if (expectedProfileSha256 && !build.labels?.includes(profileLabel(expectedProfileSha256))) return false;
  if (build.commit?.hash === commit) return true;
  return pending && !TERMINAL.has(build.status) && !build.commit?.hash &&
    build.tag === tagFor(commit);
}

export function requiredArtifacts(build, version, architecture) {
  const expected = packageName(version, `darwin-${architecture}`);
  const artifacts = build.artifacts ?? [];
  const one = (name, optional = false) => {
    const found = artifacts.filter(item => typeof item.name === 'string' && basename(item.name.replaceAll('\\', '/')) === name);
    if (found.length === 0 && optional) return null;
    if (found.length !== 1 || !Number.isSafeInteger(found[0].size_in_bytes) || found[0].size_in_bytes < 1) {
      throw new Error(`Build ${build.id} does not contain exactly one valid ${name}`);
    }
    return { ...found[0], name };
  };
  const pkg = one(expected);
  const checksum = one(`${expected}.sha256`, true);
  const receipt = one('acceptance.json', true);
  const bundles = artifacts.filter(item => typeof item.name === 'string' && /_artifacts\.zip$/.test(basename(item.name.replaceAll('\\', '/'))) &&
    Number.isSafeInteger(item.size_in_bytes) && item.size_in_bytes > 0 && item.size_in_bytes <= 16 * 1024 * 1024);
  const bundle = (!checksum || !receipt) && bundles.length === 1 ? bundles[0] : null;
  if ((!checksum || !receipt) && !bundle) throw new Error(`Build ${build.id} is missing its acceptance artifact bundle`);
  return { pkg, checksum, receipt, bundle };
}

export function readBundleText(archive, entry, limit = 65536) {
  if (!entry || entry.startsWith('/') || entry.includes('..') || /[\r\n\x00]/.test(entry)) throw new Error('Unsafe artifact bundle entry');
  const commands = process.platform === 'win32'
    ? [[join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xOf', archive, entry]]]
    : [['tar', ['-xOf', archive, entry]], ['unzip', ['-p', archive, entry]]];
  for (const [command, args] of commands) {
    try {
      return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: limit });
    } catch {}
  }
  throw new Error(`Cannot read required Codemagic artifact bundle entry: ${entry}`);
}

export async function findReusableBuild(listed, context, version, load) {
  // List responses may omit build_inputs. Resolve full details before deciding
  // a UI-triggered build cannot be reused for this architecture.
  const candidates = listed.filter(item => !FAILED.has(item.status) &&
    (item.commit?.hash === context.commit || (item.tag === tagFor(context.commit) && !TERMINAL.has(item.status))));
  candidates.sort((a, b) => Number(b.status === 'finished') - Number(a.status === 'finished'));
  for (const candidate of candidates) {
    const full = await load(candidate.id);
    if (!matchesBuild(full, context, { pending: true }) || FAILED.has(full.status)) continue;
    if (full.status === 'finished') {
      try { requiredArtifacts(full, version, context.architecture); } catch { continue; }
    }
    return full;
  }
  return null;
}

export function publicBuild(build) {
  return { buildId: build.id, status: build.status, commit: build.commit?.hash ?? null,
    architecture: buildArchitecture(build) ?? null, tag: build.tag ?? null,
    artifacts: (build.artifacts ?? []).map(item => ({ name: item.name, bytes: item.size_in_bytes })) };
}

async function loadConfig(path, env = process.env) {
  const stored = await readJson(path, {});
  const teamId = env.CODEMAGIC_TEAM_ID ?? stored.teamId;
  const config = { appId: env.CODEMAGIC_APP_ID ?? stored.appId,
    ...(teamId ? { teamId } : {}), token: env.CM_API_TOKEN ?? env.CODEMAGIC_API_TOKEN ?? stored.token };
  if (!ID.test(config.appId ?? '') || (config.teamId && !/^[A-Za-z0-9_-]{1,128}$/.test(config.teamId)) ||
      typeof config.token !== 'string' || !config.token.trim() || /[\r\n]/.test(config.token)) {
    throw new Error('Codemagic credentials are missing or invalid. Run macos:ci -- configure --help; never put credentials in the repository.');
  }
  config.token = config.token.trim();
  return config;
}

async function getBuild(config, id) {
  if (!ID.test(id ?? '')) throw new Error('Invalid Codemagic build ID');
  const result = await apiRequest(`/builds/${id}`, config);
  const build = result.data;
  if (build?.id !== id || build.app_id !== config.appId || build.workflow?.id !== WORKFLOW) throw new Error('Codemagic returned a different app/workflow/build');
  return build;
}

export async function listBuilds(config) {
  if (config.teamId) {
    const query = new URLSearchParams({ app_id: config.appId, workflow_id: WORKFLOW, page_size: '100' });
    const result = await apiRequest(`/teams/${config.teamId}/builds?${query}`, config);
    if (!Array.isArray(result.data)) throw new Error('Unexpected Codemagic build-list response');
    return result.data;
  }
  const result = await apiRequest('/user/apps?page_size=100', config);
  const app = result.data?.find(item => item.id === config.appId);
  if (!app) throw new Error('Configured Codemagic app is not visible to this API token');
  return app.last_build_id ? [await getBuild(config, app.last_build_id)] : [];
}

async function ensureRemoteTag(commit) {
  const ref = `refs/tags/${tagFor(commit)}`;
  const existing = (await run('git', ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`], { capture: true })).stdout.trim();
  if (!existing) await run('git', ['push', 'origin', `${commit}:${ref}`], { capture: true });
  const checked = (await run('git', ['ls-remote', '--tags', 'origin', ref, `${ref}^{}`], { capture: true })).stdout.trim().split('\n');
  const line = checked.find(value => value.endsWith(`${ref}^{}`)) ?? checked.find(value => value.endsWith(`\t${ref}`));
  if (line?.split(/\s+/)[0] !== commit) throw new Error('The immutable Codemagic tag points to another commit; it was not overwritten');
}

// Artifact links come only from authenticated Codemagic metadata. Do not send the
// account token to the download origin or persist/log its short-lived URLs.
async function artifactResponse(artifact, fetcher = fetch) {
  let url = new URL(artifact.short_lived_download_url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe Codemagic artifact URL');
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(240000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Artifact redirect has no location');
      url = new URL(location, url); continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Codemagic artifact download: HTTP ${response.status}`); }
    return response;
  }
  throw new Error('Too many artifact redirects');
}

async function downloadArtifact(artifact, path, limit, fetcher) {
  if (artifact.size_in_bytes > limit) throw new Error('Artifact exceeds its permitted size');
  const response = await artifactResponse(artifact, fetcher);
  let received = 0;
  try {
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > artifact.size_in_bytes || received > limit) throw new Error('Oversized Codemagic artifact');
        yield chunk;
      }
    }, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    if (received !== artifact.size_in_bytes) throw new Error('Truncated Codemagic artifact');
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function collectBuild(build, { appId, commit, architecture, version, directory, expectedProfileSha256, fetcher = fetch }) {
  if (build.status !== 'finished' || !matchesBuild(build, { appId, commit, architecture, expectedProfileSha256 })) throw new Error('Only a successful exact-commit/architecture/profile build can be collected');
  const target = `darwin-${architecture}`;
  const { pkg, checksum, receipt, bundle } = requiredArtifacts(build, version, architecture);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.codemagic-'));
  const candidate = join(staging, target);
  await mkdir(candidate);
  try {
    let bundlePath;
    if (bundle) {
      bundlePath = join(staging, 'artifacts.zip');
      await downloadArtifact(bundle, bundlePath, 16 * 1024 * 1024, fetcher);
    }
    const receiptPath = join(candidate, 'acceptance.json');
    if (receipt) await downloadArtifact(receipt, receiptPath, 65536, fetcher);
    else await writeFile(receiptPath, readBundleText(bundlePath, `release/offline/${version}/${target}/acceptance.json`, 65536), { flag: 'wx', mode: 0o600 });
    const evidence = await readJson(receiptPath);
    if (expectedProfileSha256 && evidence.releaseProfileSha256 !== expectedProfileSha256) {
      throw new Error('Downloaded acceptance belongs to a different release profile');
    }
    if (evidence.passed !== true || evidence.commit !== commit || evidence.sourceDirty !== false ||
        evidence.release !== version || evidence.target !== target || evidence.entrypoint?.name !== pkg.name ||
        !/^[a-f0-9]{64}$/.test(evidence.entrypoint?.sha256 ?? '')) throw new Error('Downloaded acceptance does not describe the requested final source/package');
    const checksumName = `${pkg.name}.sha256`;
    const checksumPath = join(candidate, checksumName);
    if (checksum) await downloadArtifact(checksum, checksumPath, 4096, fetcher);
    else await writeFile(checksumPath, readBundleText(bundlePath, `release/${checksumName}`, 4096), { flag: 'wx', mode: 0o600 });
    const hashText = (await readFile(checksumPath, 'utf8')).trim();
    const hashMatch = /^([a-f0-9]{64})(?:\s+\*?([^\r\n]+))?$/.exec(hashText);
    if (!hashMatch || hashMatch[1] !== evidence.entrypoint.sha256 || (hashMatch[2] && hashMatch[2] !== pkg.name)) throw new Error('PKG checksum and acceptance disagree');
    const destination = join(directory, target);
    const previous = await readJson(join(destination, 'acceptance.json'), null);
    if (previous) {
      if (previous.commit !== commit || previous.entrypoint?.sha256 !== evidence.entrypoint.sha256) throw new Error('Existing accepted candidate has different provenance/bytes; use a separate --directory');
      await verifyAcceptance({ version, root: directory, targets: [target], expectedCommit: commit, expectedProfileSha256 });
      return { collected: true, reused: true, buildId: build.id, target, commit, sha256: evidence.entrypoint.sha256 };
    }
    // Never merge into an unknown partial directory or replace accepted bytes.
    try { await stat(destination); throw new Error('Artifact destination already exists without accepted provenance'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await downloadArtifact(pkg, join(candidate, pkg.name), 1024 * 1024 * 1024, fetcher);
    if (await sha256File(join(candidate, pkg.name)) !== evidence.entrypoint.sha256) throw new Error('Downloaded PKG hash differs from acceptance');
    await verifyAcceptance({ version, root: staging, targets: [target], expectedCommit: commit, expectedProfileSha256 });
    await rename(candidate, destination);
    return { collected: true, reused: false, buildId: build.id, target, commit, sha256: evidence.entrypoint.sha256, directory: destination };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: 'string', default: defaultConfig() }, 'app-id': { type: 'string' }, 'team-id': { type: 'string' },
    commit: { type: 'string' }, arch: { type: 'string', default: 'both' }, 'build-id': { type: 'string' },
    directory: { type: 'string' }, retry: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [action] = positionals;
  if (values.help || !action) {
    console.log('Codemagic manual macOS builds\n  configure --app-id <id> [--team-id <id>]  Save CM_API_TOKEN in the protected per-user directory\n  start [--arch both|arm64|x64]          Reuse matching builds; start only missing targets\n  status                              Read current cloud state (no waiting/daemon)\n  collect                             Download and verify final PKGs, SHA256 and acceptance\n  status|collect --arch <arch> --build-id <id>  Inspect/reuse an existing build\n  --commit <full-sha>                  Default: current HEAD\n  --directory <path>                   Default: release/offline/<version>\n  --retry                             Explicitly retry a failed/ambiguous submission AFTER checking the cloud\n\nUse CM_API_TOKEN/CODEMAGIC_API_TOKEN and CODEMAGIC_APP_ID; CODEMAGIC_TEAM_ID is optional for team-owned apps. Or configure once. Never pass the token as a command argument. A start creates an immutable ci/macos-<sha> tag; no push triggers are added. Build IDs only are saved under ignored build/codemagic/. Collection never promotes stable or changes update policy.');
    return;
  }
  if (positionals.length !== 1 || !['configure', 'start', 'status', 'collect'].includes(action)) throw new Error('Unknown Codemagic command');
  if (action === 'configure') {
    const path = resolve(values.config);
    const rel = relative(process.cwd(), path);
    if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error('Credential configuration must be outside the repository');
    const config = await loadConfig(path, { ...process.env,
      CODEMAGIC_APP_ID: values['app-id'] ?? process.env.CODEMAGIC_APP_ID,
      CODEMAGIC_TEAM_ID: values['team-id'] ?? process.env.CODEMAGIC_TEAM_ID });
    await listBuilds(config); // Validate the app, and the team boundary when one is configured.
    await secureStateDirectory(dirname(path));
    await atomicJson(path, config);
    console.log(JSON.stringify({ configured: true, appId: config.appId, teamId: config.teamId, credentialFile: path }));
    return;
  }
  if (!['both', ...ARCHES].includes(values.arch)) throw new Error('Choose both, arm64 or x64');
  if (values['build-id'] && (values.arch === 'both' || action === 'start')) throw new Error('--build-id requires one architecture and status/collect');
  if (values.retry && action !== 'start') throw new Error('--retry is only valid for start');
  const config = await loadConfig(values.config);
  const identity = sourceIdentity();
  const commit = values.commit ?? identity.commit;
  if (!SHA.test(commit) || (action === 'start' && (identity.sourceDirty || commit !== identity.commit))) throw new Error('Start requires the current clean, fully committed source tree');
  const sourceRelease = JSON.parse((await run('git', ['show', `${commit}:release.config.json`], { capture: true })).stdout);
  const version = sourceRelease.version;
  const profile = sourceRelease.gateway === 'https://gateway.example.com'
    ? { gateway: release.gateway, downloadOrigin: release.distribution.origin, updatePublicKey: release.distribution.updatePublicKey } : undefined;
  if (profile) requireProductionProfile(release);
  const expectedProfileSha256 = profile ? releaseProfileDigest(release) : undefined;
  const architectures = values.arch === 'both' ? ARCHES : [values.arch];
  const recordPath = resolve('build', 'codemagic', `${commit}.json`);
  await mkdir(dirname(recordPath), { recursive: true });
  const unlock = await lockfile.lock(recordPath, { realpath: false, retries: 0 });
  try {
    const record = await readJson(recordPath, { appId: config.appId, commit, version, expectedProfileSha256, builds: {} });
    if (record.appId !== config.appId || record.commit !== commit || record.version !== version) throw new Error('Local build references belong to another source/app');
    if (record.expectedProfileSha256 !== expectedProfileSha256) throw new Error('Local build record belongs to a different release profile; inspect it rather than reusing or overwriting it');
    const listed = values['build-id'] ? [] : await listBuilds(config);
    const details = new Map();
    let tagReady = false;
    for (const architecture of architectures) {
      const context = { appId: config.appId, commit, architecture, expectedProfileSha256 };
      let id = values['build-id'] ?? record.builds[architecture]?.id;
      let build = id ? await getBuild(config, id) : null;
      if (build && !matchesBuild(build, context, { pending: true })) throw new Error('Recorded build has a different source/architecture');
      if (!build || (FAILED.has(build.status) && !values['build-id'])) {
        const reusable = await findReusableBuild(listed, context, version, async buildId => {
          if (!details.has(buildId)) details.set(buildId, await getBuild(config, buildId));
          return details.get(buildId);
        });
        build = reusable ?? (values.retry ? null : build);
      }
      if (!build && action === 'start') {
        if (record.builds[architecture] && !values.retry) throw new Error(`Previous ${architecture} submission is unresolved. Inspect cloud builds; use --retry only when it is safe.`);
        if (!tagReady) { await ensureRemoteTag(commit); tagReady = true; }
        record.builds[architecture] = { requestedAt: new Date().toISOString(), id: null };
        await atomicJson(recordPath, record);
        const response = await apiRequest('/builds', { ...config, legacy: true, method: 'POST', body: buildRequest({ ...context, profile }) });
        if (!ID.test(response.buildId ?? '')) throw new Error('Codemagic did not return a build ID; reconcile the pending request before retrying');
        record.builds[architecture].id = response.buildId;
        await atomicJson(recordPath, record);
        console.log(JSON.stringify({ started: true, buildId: response.buildId, commit, architecture, tag: tagFor(commit) }));
        continue;
      }
      if (!build) throw new Error(`No matching ${architecture} build found; use start or provide its --build-id`);
      record.builds[architecture] = { id: build.id };
      await atomicJson(recordPath, record);
      console.log(JSON.stringify(publicBuild(build)));
      if (FAILED.has(build.status)) throw new Error(`Codemagic ${architecture} build ${build.id} ${build.status}; inspect before an explicit --retry`);
      if (action === 'collect') console.log(JSON.stringify(await collectBuild(build, { ...context, version,
        directory: resolve(values.directory ?? join('release', 'offline', version)) })));
    }
  } finally { await unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
