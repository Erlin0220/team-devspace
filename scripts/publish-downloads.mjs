import { cp, mkdir, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run, sha256File, sourceIdentity } from './build-utils.mjs';
import { DOWNLOAD_TARGETS, packageName, VERSION, validateCatalog, httpsOrigin, packageUrls, downloadPage } from './download-catalog.mjs';
import { installScripts } from './download-commands.mjs';
import { verifyAcceptance } from './verify-acceptance.mjs';
import release, { requireProductionProfile, releaseProfileDigest } from './release-profile.mjs';
import { signUpdateCatalog } from './sign-updates.mjs';
import { validateUpdatePolicy, verifySignedCatalog } from '../client/update-policy.mjs';
import { administrator } from '../client/admin.mjs';
import { control } from '../client/http.mjs';
import { UPGRADE_BASELINES } from './upgrade-baselines.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function retainedReleaseVersions(version, policy) {
  return [...new Set([version, policy.auto, policy.minimumSupported,
    ...Object.keys(UPGRADE_BASELINES)].filter(Boolean))];
}

export async function buildDownloadCatalog(directory, version, commit) {
  const targets = {};
  for (const target of DOWNLOAD_TARGETS) {
    const file = packageName(version, target);
    const path = join(directory, target, file);
    targets[target] = { file, size: (await stat(path)).size, sha256: await sha256File(path) };
  }
  return validateCatalog({ schema: 1, version, commit, targets });
}

export async function prepareSite(directory, output, catalog, origin, notes, { signer = signUpdateCatalog } = {}) {
  validateCatalog(catalog); httpsOrigin(origin);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Site staging directory must be empty');
  for (const target of DOWNLOAD_TARGETS) {
    const item = catalog.targets[target];
    const dest = join(output, item.file);
    await cp(join(directory, target, item.file), dest);
    if ((await stat(dest)).size !== item.size || await sha256File(dest) !== item.sha256) throw new Error(`Package changed while staging: ${target}`);
    await writeFile(`${dest}.sha256`, `${item.sha256}\n`);
    // Acceptance contains build/test facts only, never employee state or credentials.
    const evidence = JSON.parse(await readFile(join(directory, target, 'acceptance.json'), 'utf8'));
    const { schema, passed, release: version, commit, sourceDirty, releaseProfileSha256, entrypoint, checks, limitations } = evidence;
    await writeFile(join(output, `acceptance-${target}.json`), `${JSON.stringify({ schema, passed, release: version,
      target, commit, sourceDirty, releaseProfileSha256, entrypoint, checks, limitations }, null, 2)}\n`);
  }
  const scripts = installScripts(catalog, origin);
  await writeFile(join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(join(output, 'update.json'), `${JSON.stringify(await signer(catalog), null, 2)}\n`);
  await writeFile(join(output, 'install.ps1'), scripts.windows);
  await writeFile(join(output, 'install.sh'), scripts.unix);
  await writeFile(join(output, 'index.html'), downloadPage(catalog, origin));
  await writeFile(join(output, 'release-notes.txt'), notes);
  const entries = (await readdir(output)).sort();
  const sums = await Promise.all(entries.map(async name => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Unexpected staged filename');
    return `${await sha256File(join(output, name))}  ${name}\n`;
  }));
  await writeFile(join(output, 'SHA256SUMS'), sums.join(''));
}

export async function prepareHomepage(output, catalog, origin) {
  validateCatalog(catalog); httpsOrigin(origin);
  const page = downloadPage(catalog, origin, { stable: true });
  // Fail locally before upload if the page exceeds the existing read-back verifier.
  if (Buffer.byteLength(page) > 65536) throw new Error('Homepage exceeds the 64 KiB verification budget');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.html'), page);
  await cp(resolve('assets', 'download-site.js'), join(output, 'download-site.js'));
  await cp(resolve('platform', 'macos', 'devspace-logo-light.png'), join(output, 'devspace-logo-light.png'));
  return page;
}

async function smallBody(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(response.url).pathname}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('Unexpectedly large release metadata');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const request = (url, options = {}) => fetch(url, { redirect: 'error',
  signal: AbortSignal.timeout(1800000), headers: { 'Accept-Encoding': 'identity' }, ...options });

// Server-side full SHA256 verification is a prerequisite in main(). Normal
// publication probes the delivery path with bounded ranges, not four full GETs.
// A full independent HTTPS hash check remains available for incident diagnosis.
export async function verifyRemote(origin, catalog, { fetcher = request, full = false } = {}) {
  const urls = packageUrls(catalog, origin);
  const remoteText = await smallBody(await fetcher(`${origin}/releases/${catalog.version}/catalog.json`));
  if (remoteText !== `${JSON.stringify(catalog, null, 2)}\n`) throw new Error('Published catalog differs from the staged catalog');
  for (const target of DOWNLOAD_TARGETS) {
    const item = catalog.targets[target];
    const head = await fetcher(urls[target], { method: 'HEAD' });
    if (head.status !== 200 || Number(head.headers.get('Content-Length')) !== item.size ||
        !head.headers.get('ETag') || head.headers.get('Accept-Ranges') !== 'bytes') throw new Error(`HEAD/ETag verification failed: ${target}`);
    const checksum = await smallBody(await fetcher(`${urls[target]}.sha256`));
    if (checksum.trim() !== item.sha256) throw new Error(`Published checksum differs: ${target}`);
    const ranges = [[0, Math.min(65535, item.size - 1)]];
    if (item.size > 65536) ranges.push([Math.max(65536, item.size - 65536), item.size - 1]);
    for (const [start, end] of ranges) {
      const partial = await fetcher(urls[target], { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' } });
      if (partial.status !== 206 || partial.headers.get('Content-Range') !== `bytes ${start}-${end}/${item.size}` ||
          partial.headers.get('ETag') !== head.headers.get('ETag')) {
        await partial.body?.cancel();
        throw new Error(`Resumable download failed: ${target}`);
      }
      let received = 0;
      for await (const chunk of partial.body) {
        received += chunk.length;
        if (received > end - start + 1) throw new Error(`Oversized range: ${target}`);
      }
      if (received !== end - start + 1) throw new Error(`Truncated range: ${target}`);
    }
    if (full) {
      const response = await fetcher(urls[target]);
      if (response.status !== 200 || Number(response.headers.get('Content-Length')) !== item.size) {
        await response.body?.cancel(); throw new Error(`Download failed or has an unexpected size: ${target}`);
      }
      const hash = createHash('sha256'); let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > item.size) throw new Error(`Oversized download: ${target}`);
        hash.update(chunk);
      }
      if (received !== item.size || hash.digest('hex') !== item.sha256) throw new Error(`HTTPS package checksum mismatch: ${target}`);
    }
    console.log(JSON.stringify({ httpsDeliveryVerified: true, target, size: item.size,
      fullHttpsHash: full, head: true, ranges: ranges.length }));
  }
}

async function stableCheck(origin, catalog) {
  const response = await request(`${origin}/catalog.json`);
  if (!/no-store/.test(response.headers.get('Cache-Control') ?? '')) throw new Error('Stable metadata must not be cached');
  const text = await smallBody(response);
  if (text !== `${JSON.stringify(catalog, null, 2)}\n`) throw new Error('Stable activation could not be confirmed');
  for (const name of ['install.ps1', 'install.sh']) {
    const stable = await request(`${origin}/${name}`);
    if (!/no-store/.test(stable.headers.get('Cache-Control') ?? '')) throw new Error('Stable entrypoint must not be cached');
    const pinned = await smallBody(await request(`${origin}/releases/${catalog.version}/${name}`));
    if (digest(await smallBody(stable)) !== digest(pinned)) throw new Error('Stable installer script does not match its release');
  }
}

async function publishHomepage({ origin, catalog, server, command }) {
  const output = resolve('build', 'downloads', 'homepage');
  const page = await prepareHomepage(output, catalog, origin);
  const uploadId = randomUUID().replaceAll('-', '');
  try {
    await command('site-stage', uploadId);
    await run('scp', ['-q',
      relative(process.cwd(), join(output, 'index.html')).replaceAll('\\', '/'),
      relative(process.cwd(), join(output, 'download-site.js')).replaceAll('\\', '/'),
      relative(process.cwd(), join(output, 'devspace-logo-light.png')).replaceAll('\\', '/'),
      `${server.sshHost}:${server.serverRoot}/.incoming/site-${uploadId}/`], { timeout: 120000 });
    await command('site-publish', uploadId, catalog.version);
  } catch (error) {
    await command('site-discard', uploadId).catch(() => {});
    throw error;
  }
  const response = await request(`${origin}/`);
  if (!/no-store/.test(response.headers.get('Cache-Control') ?? '')) throw new Error('Homepage must not be cached');
  if (await smallBody(response) !== page) throw new Error('Published homepage differs from generated homepage');
  const localScript = await readFile(join(output, 'download-site.js'), 'utf8');
  const remoteScript = await request(`${origin}/download-site.js`);
  if (!/no-store/.test(remoteScript.headers.get('Cache-Control') ?? '') || await smallBody(remoteScript) !== localScript) throw new Error('Published homepage script differs from staging');
  const localLogo = join(output, 'devspace-logo-light.png');
  const remoteLogo = await request(`${origin}/devspace-logo-light.png`);
  const logoBytes = Buffer.from(await remoteLogo.arrayBuffer());
  if (!remoteLogo.ok || !/no-store/.test(remoteLogo.headers.get('Cache-Control') ?? '') ||
      logoBytes.length !== (await stat(localLogo)).size || digest(logoBytes) !== await sha256File(localLogo)) {
    throw new Error('Published homepage logo differs from staging');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    publish: { type: 'boolean' }, 'full-https-verify': { type: 'boolean' }, activate: { type: 'string' }, 'init-server': { type: 'boolean' }, 'site-only': { type: 'boolean' }, preview: { type: 'boolean' },
    config: { type: 'string', default: '.runtime/downloads.json' }, version: { type: 'string' },
    commit: { type: 'string' }, directory: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Prepare accepted release: npm run downloads:publish\nInitialize existing Caddy site (DNS must be ready): npm run downloads:deploy\nPublish + verify HTTPS + activate: npm run downloads:publish -- --publish\nPreview the homepage locally from the active catalog: npm run downloads:preview\nRefresh only the public homepage: npm run downloads:site\nRecover an unpruned staged release: npm run downloads:publish -- --activate <version>\nOptional full HTTPS hash verification: add --full-https-verify\nImport accepted artifacts: add --version <version> --commit <source-commit> --directory <four-target-directory>\nNo Access Key, download ticket, R2 or HTTP publishing credentials. Uses existing SSH.');
    return;
  }
  const origin = httpsOrigin(release.distribution.origin);
  const version = values.activate ?? values.version ?? release.version;
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  if (values.activate && (values.commit || values.directory || values.version || values.publish || values['init-server'] || values['site-only'])) throw new Error('Activation is a separate operation');
  if (values['site-only'] && (values.publish || values['init-server'] || values.commit || values.directory || values.version)) throw new Error('Homepage refresh is a separate operation');
  if (values.preview) {
    if (values.publish || values.activate || values['init-server'] || values['site-only'] || values.commit || values.directory || values.version) throw new Error('Homepage preview is a separate read-only operation');
    const catalog = validateCatalog(JSON.parse(await smallBody(await request(`${origin}/catalog.json`))));
    const output = resolve('build', 'downloads', 'homepage-preview');
    const page = await prepareHomepage(output, catalog, origin);
    console.log(JSON.stringify({ preview: true, output, bytes: Buffer.byteLength(page), version: catalog.version, origin }));
    return;
  }
  const remote = values.publish || values.activate || values['init-server'] || values['site-only'];
  if (remote) requireProductionProfile(release);
  let server, remoteScript, command, initialStable;
  if (remote) {
    server = JSON.parse(await readFile(values.config, 'utf8'));
    if (Object.keys(server).sort().join() !== 'serverRoot,sshHost' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(server.sshHost ?? '') ||
        !/^\/srv\/[a-zA-Z0-9_-]+$/.test(server.serverRoot ?? '')) throw new Error('Invalid dedicated SSH distribution configuration');
    remoteScript = `.cache/team-devspace-downloads/publisher-${randomUUID().replaceAll('-', '')}.sh`;
    await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', server.sshHost, 'umask 077; mkdir -p .cache/team-devspace-downloads']);
    await run('scp', ['-q', 'scripts/download-server.sh', `${server.sshHost}:${remoteScript}`]);
    command = async (action, argument = '', stage = '', capture = false) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', server.sshHost,
      ['bash', remoteScript, server.serverRoot, action, argument, stage].map(quote).join(' ')], { capture, timeout: 1800000 });
  }
  let uploadId, operator, publicationToken;
  const lease = async action => control(operator.gateway, '/v1/admin/publication', operator.adminToken,
    { body: { action, token: publicationToken } });
  try {
    if (values['init-server']) {
      await command('prepare');
      await command('configure', new URL(origin).hostname);
      console.log(JSON.stringify({ configured: true, origin, newDaemon: false, mainCaddyfileChanged: false }));
      return;
    }
    if (values['site-only']) {
      const identity = sourceIdentity();
      if (identity.sourceDirty || !/^[a-f0-9]{40}$/.test(identity.commit)) throw new Error('Homepage deployment requires a clean committed source tree');
      const catalog = validateCatalog(JSON.parse(await smallBody(await request(`${origin}/catalog.json`))));
      await publishHomepage({ origin, catalog, server, command });
      console.log(JSON.stringify({ homepagePublished: true, version: catalog.version, commit: identity.commit, origin }));
      return;
    }
    if (remote) initialStable = (await command('current', '', '', true)).stdout.trim();
    let catalog;
    if (values.activate) {
      catalog = validateCatalog(JSON.parse(await smallBody(await request(`${origin}/releases/${version}/catalog.json`))));
      if (catalog.version !== version) throw new Error('Historical catalog version mismatch');
    } else {
      const identity = sourceIdentity();
      if (identity.sourceDirty || !/^[a-f0-9]{40}$/.test(identity.commit)) throw new Error('Publishing requires a clean committed source tree and acceptance of the final installer bytes');
      const commit = values.commit ?? identity.commit;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
      const sourceRelease = JSON.parse(execFileSync('git', ['show', `${commit}:release.config.json`], { encoding: 'utf8', windowsHide: true }));
      if (sourceRelease.version !== version || sourceRelease.distribution.targets.slice().sort().join() !== [...DOWNLOAD_TARGETS].sort().join()) throw new Error('Source commit does not describe the requested four-target release');
      const directory = resolve(values.directory ?? join('release', 'offline', version));
      await verifyAcceptance({ version, root: directory, targets: DOWNLOAD_TARGETS, expectedCommit: commit,
        requireFinalWindows: true, requireInstalledUpgrade: true, requireNativeArchitecture: true,
        expectedProfileSha256: releaseProfileDigest(release) });
      catalog = await buildDownloadCatalog(directory, version, commit);
      const output = resolve('build', 'downloads', version);
      await rm(output, { recursive: true, force: true });
      let notes;
      try { notes = await readFile(`docs/release-notes-${version}.md`, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; notes = `Team DevSpace ${version}\nSource commit: ${commit}\nRetained accepted release. See catalog.json and acceptance-*.json for exact artifact identity and validation limitations.\n`; }
      await prepareSite(directory, output, catalog, origin, notes);
      const after = sourceIdentity();
      if (after.sourceDirty || after.commit !== identity.commit) throw new Error('Source tree changed while preparing the release');
      console.log(JSON.stringify({ prepared: true, version, commit, origin,
        totalBytes: Object.values(catalog.targets).reduce((sum, item) => sum + item.size, 0), output, publish: Boolean(values.publish) }));
      if (!values.publish) return;
      uploadId = randomUUID().replaceAll('-', '');
      await command('stage', version, uploadId);
      await run('scp', ['-q', '-r', `${relative(process.cwd(), output).replaceAll('\\', '/')}/.`, `${server.sshHost}:${server.serverRoot}/.incoming/${uploadId}/`], { timeout: 1800000 });
      await command('publish', version, uploadId);
      uploadId = null;
    }
    // Signed metadata is independent of the HTTPS host. Never infer trust from
    // a checksum hosted beside an executable. Legacy manual recovery remains possible.
    const signatureResponse = await request(`${origin}/releases/${version}/update.json`);
    const hasSignature = signatureResponse.status === 200;
    if (hasSignature) {
      const signed = await verifySignedCatalog(JSON.parse(await smallBody(signatureResponse)), release.distribution.updatePublicKey, version);
      if (JSON.stringify(signed) !== JSON.stringify(catalog)) throw new Error('Signed update catalog differs from published package metadata');
    } else {
      await signatureResponse.body?.cancel();
      if (!values.activate || signatureResponse.status !== 404) throw new Error('Published update signature is missing');
    }
    // Verify final server bytes before bounded public HTTPS delivery probes.
    // No pruning happens until activation, scripts AND homepage verify successfully.
    await command('verify', version);
    await verifyRemote(origin, catalog, { full: Boolean(values['full-https-verify']) });
    operator = await administrator();
    if (operator.gateway !== release.gateway) throw new Error('The administrator belongs to a different Gateway');
    publicationToken = randomUUID();
    const beforeActivation = await lease('begin');
    validateUpdatePolicy({ ...beforeActivation.policy, stable: version });
    await command('activate', version, initialStable);
    await stableCheck(origin, catalog);
    await publishHomepage({ origin, catalog, server, command });
    // Renew only around the short activation/cleanup operation, not during upload.
    // The same existing D1 row prevents admin promotion from racing release deletion.
    const beforePrune = await lease('begin');
    validateUpdatePolicy({ ...beforePrune.policy, stable: version });
    const retained = retainedReleaseVersions(version, beforePrune.policy);
    await command('prune', version, `${Math.floor(beforePrune.expiresAt / 1000)}:${retained.join(',')}`);
    console.log(JSON.stringify({ activated: true, version, commit: catalog.commit, origin,
      previous: initialStable, rollbackChangesInstalledClients: false, verifiedAllFourHttpsDeliveryPaths: true,
      fullHttpsHash: Boolean(values['full-https-verify']), homepagePublished: true, signedUpdates: hasSignature,
      retainedPolicyVersions: retained, retainedAcceptanceBaselines: Object.keys(UPGRADE_BASELINES),
      retainedKnownGoodPredecessor: true }));
  } finally {
    if (publicationToken && operator) await lease('end').catch(() => console.error('Publication lease will expire automatically; policy edits may be temporarily unavailable.'));
    if (uploadId && command) await command('discard', version, uploadId).catch(() => console.error(`Staging cleanup needs inspection: ${uploadId}`));
    if (remoteScript && server) await run('ssh', ['-o', 'BatchMode=yes', server.sshHost, `rm -f -- ${quote(remoteScript)}`]).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
