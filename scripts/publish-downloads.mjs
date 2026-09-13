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
import release from '../release.config.json' with { type: 'json' };

const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function buildDownloadCatalog(directory, version, commit) {
  const targets = {};
  for (const target of DOWNLOAD_TARGETS) {
    const file = packageName(version, target);
    const path = join(directory, target, file);
    targets[target] = { file, size: (await stat(path)).size, sha256: await sha256File(path) };
  }
  return validateCatalog({ schema: 1, version, commit, targets });
}

export async function prepareSite(directory, output, catalog, origin, notes) {
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
    const { schema, passed, release: version, commit, sourceDirty, entrypoint, checks, limitations } = evidence;
    await writeFile(join(output, `acceptance-${target}.json`), `${JSON.stringify({ schema, passed, release: version,
      target, commit, sourceDirty, entrypoint, checks, limitations }, null, 2)}\n`);
  }
  const scripts = installScripts(catalog, origin);
  await writeFile(join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
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
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const page = downloadPage(catalog, origin, { stable: true });
  await writeFile(join(output, 'index.html'), page);
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

export async function verifyRemote(origin, catalog) {
  const urls = packageUrls(catalog, origin);
  const remoteText = await smallBody(await request(`${origin}/releases/${catalog.version}/catalog.json`));
  if (remoteText !== `${JSON.stringify(catalog, null, 2)}\n`) throw new Error('Published catalog differs from the staged catalog');
  for (const target of DOWNLOAD_TARGETS) {
    const item = catalog.targets[target];
    const response = await request(urls[target]);
    if (response.status !== 200 || Number(response.headers.get('Content-Length')) !== item.size) throw new Error(`Download failed or has an unexpected size: ${target}`);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > item.size) throw new Error(`Oversized download: ${target}`);
      hash.update(chunk);
    }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error(`HTTPS package checksum mismatch: ${target}`);
    const head = await request(urls[target], { method: 'HEAD' });
    if (head.status !== 200 || Number(head.headers.get('Content-Length')) !== item.size || !head.headers.get('ETag')) throw new Error(`HEAD/ETag verification failed: ${target}`);
    const partial = await request(urls[target], { headers: { Range: 'bytes=0-15', 'Accept-Encoding': 'identity' } });
    if (partial.status !== 206 || partial.headers.get('Content-Range') !== `bytes 0-15/${item.size}` || (await partial.arrayBuffer()).byteLength !== 16) throw new Error(`Resumable download failed: ${target}`);
    console.log(JSON.stringify({ httpsVerified: true, target, size, sha256: item.sha256, head: true, range: true }));
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
    await run('scp', ['-q', relative(process.cwd(), join(output, 'index.html')).replaceAll('\\', '/'),
      `${server.sshHost}:${server.serverRoot}/.incoming/site-${uploadId}/index.html`], { timeout: 120000 });
    await command('site-publish', uploadId);
  } catch (error) {
    await command('site-discard', uploadId).catch(() => {});
    throw error;
  }
  const response = await request(`${origin}/`);
  if (!/no-store/.test(response.headers.get('Cache-Control') ?? '')) throw new Error('Homepage must not be cached');
  if (await smallBody(response) !== page) throw new Error('Published homepage differs from generated homepage');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    publish: { type: 'boolean' }, activate: { type: 'string' }, 'init-server': { type: 'boolean' }, 'site-only': { type: 'boolean' },
    config: { type: 'string', default: 'downloads.config.json' }, version: { type: 'string' },
    commit: { type: 'string' }, directory: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Prepare accepted release: npm run downloads:publish\nInitialize existing Caddy site (DNS must be ready): npm run downloads:deploy\nPublish + verify HTTPS + activate: npm run downloads:publish -- --publish\nRefresh only the public homepage: npm run downloads:site\nRollback: npm run downloads:publish -- --activate <version>\nImport accepted historical artifacts: add --version <version> --commit <source-commit> --directory <four-target-directory>\nNo Access Key, download ticket, R2 or HTTP publishing credentials. Uses existing SSH.');
    return;
  }
  const origin = httpsOrigin(release.distribution.origin);
  const version = values.activate ?? values.version ?? release.version;
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  if (values.activate && (values.commit || values.directory || values.version || values.publish || values['init-server'] || values['site-only'])) throw new Error('Activation is a separate operation');
  if (values['site-only'] && (values.publish || values['init-server'] || values.commit || values.directory || values.version)) throw new Error('Homepage refresh is a separate operation');
  const remote = values.publish || values.activate || values['init-server'] || values['site-only'];
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
  let uploadId;
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
      await verifyAcceptance({ version, root: directory, targets: DOWNLOAD_TARGETS, expectedCommit: commit, requireFinalWindows: true });
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
    // Never activate merely because SCP succeeded. Read all four final files back
    // through public HTTPS from the operator's current network, then change one pointer.
    await verifyRemote(origin, catalog);
    await command('activate', version, initialStable);
    await stableCheck(origin, catalog);
    await publishHomepage({ origin, catalog, server, command });
    console.log(JSON.stringify({ activated: true, version, commit: catalog.commit, origin,
      previous: initialStable, rollbackChangesInstalledClients: false, verifiedAllFourHttpsPackages: true, homepagePublished: true }));
  } finally {
    if (uploadId && command) await command('discard', version, uploadId).catch(() => console.error(`Staging cleanup needs inspection: ${uploadId}`));
    if (remoteScript && server) await run('ssh', ['-o', 'BatchMode=yes', server.sshHost, `rm -f -- ${quote(remoteScript)}`]).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
