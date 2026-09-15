import { cp, chmod, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve, delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { downloadPinned, run, sha256File } from './build-utils.mjs';
import { buildReleaseLayout } from './distribution.mjs';
import { dependencyFingerprint, pruneRuntime, RUNTIME_PROFILE } from './runtime-profile.mjs';
import { buildWindowsLauncher } from './windows-launcher.mjs';
import { buildTray } from './tray-build.mjs';
import { macosSigningConfiguration, notarizeMacPackage, signMacApplication } from './macos-signing.mjs';
import release, { releaseProfileDigest } from './release-profile.mjs';
import { collectRustNotices } from './native-notices.mjs';

const { values } = parseArgs({ options: {
  'prepare-only': { type: 'boolean' }, 'reuse-dependencies': { type: 'boolean' },
  output: { type: 'string' },
} });
const target = `${process.platform}-${process.arch}`;
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
const macosSigning = process.platform === 'darwin' ? macosSigningConfiguration() : null;
if (!release.distribution.targets.includes(target)) {
  throw new Error('Build release payloads on an enabled native target host; native dependencies must not be cross-copied');
}
const binaries = JSON.parse(await readFile('scripts/binaries.json', 'utf8'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const author = packageJson.author;
if (!author || typeof author.name !== 'string' || !author.name.trim() ||
    typeof author.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email)) {
  throw new Error('package.json must define the Team DevSpace author name and email');
}
const plistText = value => String(value).replace(/[<>&"']/g, character =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
const macBundleMetadata = `<key>CFBundleShortVersionString</key><string>${release.version}</string>
<key>CFBundleVersion</key><string>${release.version}</string><key>LSUIElement</key><true/>
<key>TeamDevSpaceDevSpaceVersion</key><string>${plistText(release.devspaceVersion)}</string>
<key>TeamDevSpaceAuthorName</key><string>${plistText(author.name)}</string>
<key>TeamDevSpaceAuthorEmail</key><string>${plistText(author.email)}</string>
<key>LSMinimumSystemVersion</key><string>${release.distribution.macosMinimumVersion}</string>`;
if (packageJson.dependencies['@waishnav/devspace'] !== release.devspaceVersion) {
  throw new Error('Release manifest and upstream runtime pin disagree');
}
const cache = resolve('build/cache');
const bundle = resolve(`build/bundle-${target}`);
const outputDirectory = resolve(values.output ?? 'release');
async function maximumRelativePathLength(directory, base = directory) {
  let maximum = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) maximum = Math.max(maximum, await maximumRelativePathLength(path, base));
    else maximum = Math.max(maximum, path.slice(base.length + 1).length);
  }
  return maximum;
}
async function buildMacAppIcon(source, destination) {
  const iconset = resolve(`build/TeamDevSpace-${process.arch}.iconset`);
  const images = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  try {
    for (const [name, size] of images) {
      await run('/usr/bin/sips', ['-z', String(size), String(size), resolve(source), '--out', join(iconset, name)],
        { capture: true, timeout: 30000 });
    }
    await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', destination], { timeout: 30000 });
  } finally { await rm(iconset, { recursive: true, force: true }); }
}
// Only the fingerprint-verified dependency tree is reusable. Generated files are
// rebuilt even with --reuse-dependencies; an existing directory is not a cache key.
await mkdir(bundle, { recursive: true });
for (const entry of await readdir(bundle)) {
  if (values['reuse-dependencies'] && ['node_modules', '.dependency-fingerprint'].includes(entry)) continue;
  await rm(join(bundle, entry), { recursive: true, force: true });
}
await rm(join(cache, 'PortableGit'), { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(join(bundle, 'bin'), { recursive: true });
const macosCloudflared = process.platform === 'darwin' ? process.env.TEAM_DEVSPACE_CLOUDFLARED_BINARY : undefined;
if (process.platform === 'darwin' && !macosCloudflared) {
  throw new Error('macOS packaging requires TEAM_DEVSPACE_CLOUDFLARED_BINARY built from the pinned cloudflared source commit');
}
const downloadKinds = ['node', ...(process.platform === 'darwin' ? [] : ['cloudflared']), ...(process.platform === 'win32' ? ['git'] : [])];
const downloads = Object.fromEntries(await Promise.all(downloadKinds.map(async kind => [kind, await downloadPinned(binaries[kind][target], cache)])));
const runtime = join(bundle, 'runtime');
let trayBuild;
const extracted = resolve(`build/node-${target}`);
await rm(extracted, { recursive: true, force: true });
await mkdir(extracted, { recursive: true });
try {
  await run(tar, ['-xf', downloads.node, '-C', extracted]);
  const directories = (await readdir(extracted, { withFileTypes: true })).filter(entry => entry.isDirectory());
  if (directories.length !== 1) throw new Error('Unexpected Node archive layout');
  await cp(join(extracted, directories[0].name), runtime, { recursive: true });
} finally { await rm(extracted, { recursive: true, force: true }); }
// Employees need the Node executable, not a second bundled npm/corepack toolchain.
// The builder uses its own pinned npm below; preserve upstream runtime licenses.
const unusedRuntimePaths = process.platform === 'win32'
  ? ['node_modules', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'install_tools.bat', 'nodevars.bat']
  : ['lib/node_modules', 'include', 'share', 'bin/npm', 'bin/npx', 'bin/corepack'];
for (const path of unusedRuntimePaths) await rm(join(runtime, path), { recursive: true, force: true });
if (process.platform === 'win32') {
  await cp(downloads.cloudflared, join(bundle, 'bin', 'cloudflared.exe'));
  // Keep the pinned official PortableGit SFX intact. The isolated installer test
  // extracts and executes it using the same code path employees use.
  await cp('platform/windows/command.cmd', join(bundle, 'bin', 'team-devspace.cmd'));
} else if (process.platform === 'darwin') {
  await access(macosCloudflared);
  await cp(resolve(macosCloudflared), join(bundle, 'bin', 'cloudflared'));
  await chmod(join(bundle, 'bin', 'cloudflared'), 0o755);
} else {
  await cp(downloads.cloudflared, join(bundle, 'bin', 'cloudflared'));
  await chmod(join(bundle, 'bin', 'cloudflared'), 0o755);
}
// This is a positive allow-list. No local credentials, developer configuration, or gateway state enter installers.
for (const directory of ['client', 'platform']) {
  await rm(join(bundle, directory), { recursive: true, force: true });
  await cp(directory, join(bundle, directory), { recursive: true });
}
if (process.platform === 'win32') {
  await buildWindowsLauncher(join(bundle, 'platform', 'windows', 'tds-launcher.exe'));
  trayBuild = await buildTray(join(bundle, 'platform', 'windows', 'team-devspace-tray.exe'));
  await rm(join(bundle, 'platform', 'windows', 'tds-launcher.c'));
} else if (process.platform === 'darwin') {
  const trayContents = join(bundle, 'platform', 'macos', 'Team DevSpace Tray.app', 'Contents');
  await mkdir(join(trayContents, 'MacOS'), { recursive: true });
  await mkdir(join(trayContents, 'Resources'), { recursive: true });
  await cp('platform/macos/team-devspace-template.png', join(trayContents, 'Resources', 'TeamDevSpaceTemplate.png'));
  trayBuild = await buildTray(join(trayContents, 'MacOS', 'TeamDevSpaceTray'));
  await chmod(join(trayContents, 'MacOS', 'TeamDevSpaceTray'), 0o755);
  await writeFile(join(trayContents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.teamdevspace.tray</string>
<key>CFBundleName</key><string>Team DevSpace</string><key>CFBundleExecutable</key><string>TeamDevSpaceTray</string>
<key>CFBundlePackageType</key><string>APPL</string>${macBundleMetadata}</dict></plist>\n`);
  await signMacApplication(dirname(trayContents), macosSigning);
  // Exercise this exact native app in the builder's GUI session. Headless
  // --self-test cannot catch a pipe that blocks before showing the setup form.
  await run(process.execPath, [resolve('scripts/tray-smoke.mjs'),
    join(trayContents, 'MacOS', 'TeamDevSpaceTray')], { timeout: 45000 });
}
for (const file of ['package.json', 'package-lock.json', '.npmrc', 'README.md', 'LICENSE', 'NOTICE']) await cp(file, join(bundle, file));
await cp('LICENSES', join(bundle, 'LICENSES'), { recursive: true });
await writeFile(join(bundle, 'release.config.json'), `${JSON.stringify(release, null, 2)}\n`);
const node = process.platform === 'win32' ? join(runtime, 'node.exe') : join(runtime, 'bin', 'node');
// The pinned modern npm honors security overrides instead of dependency-published shrinkwrap trees.
// Prefer the exact npm that invoked this script so hosted macOS packaging does not need a redundant
// repository-wide npm ci. Local development may fall back to the pinned devDependency when the
// developer's global npm is older.
const expectedNpm = packageJson.packageManager.replace(/^npm@/, '');
const npmCandidates = [...new Set([process.env.npm_execpath, resolve('node_modules/npm/bin/npm-cli.js')].filter(Boolean))];
let npmCli;
let npmVersion;
for (const candidate of npmCandidates) {
  try {
    await access(candidate);
    const candidateVersion = (await run(process.execPath, [candidate, '--version'], { capture: true, timeout: 30000 })).stdout.trim();
    if (candidateVersion === expectedNpm) { npmCli = candidate; npmVersion = candidateVersion; break; }
  } catch {}
}
if (!npmCli) {
  throw new Error(`Build requires ${packageJson.packageManager}; invoke package with that npm version or install the pinned devDependency first`);
}
const version = (await run(node, ['--version'], { capture: true })).stdout.trim();
if (version !== `v${release.nodeVersion}`) throw new Error('Bundled Node version differs from release manifest');
const buildEnvironment = {
  PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}`,
  NODE_OPTIONS: '', npm_config_fund: 'false', npm_config_audit: 'false',
  ...(process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: release.distribution.macosMinimumVersion } : {}),
};
const lockSha256 = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
// DevSpace uses node-pty for Unix TTY sessions, but its Windows shell path always uses pipes.
// Windows also disables subagents, so the platform Claude binary and Pi clipboard helpers are unused.
const omitOptionalDependencies = process.platform === 'win32';
const dependencyInstallProfile = `${RUNTIME_PROFILE}:${omitOptionalDependencies ? 'omit-dev-optional' : 'omit-dev'}` +
  (process.platform === 'darwin' ? `:macos-${release.distribution.macosMinimumVersion}` : '');
const dependencyOmissions = ['--omit=dev', ...(omitOptionalDependencies ? ['--omit=optional'] : [])];
const fingerprint = dependencyFingerprint({ lockfile: JSON.parse(await readFile('package-lock.json', 'utf8')),
  packageJson, npmrc: await readFile('.npmrc', 'utf8'), target, nodeVersion: version, npmVersion,
  profile: dependencyInstallProfile });
const dependencyMarker = join(bundle, '.dependency-fingerprint');
let previousFingerprint;
try { previousFingerprint = (await readFile(dependencyMarker, 'utf8')).trim(); } catch {}
if (!values['reuse-dependencies'] || previousFingerprint !== fingerprint) {
  await rm(dependencyMarker, { force: true });
  await run(node, [npmCli, 'ci', ...dependencyOmissions, '--no-fund', '--no-audit'],
    { cwd: bundle, env: buildEnvironment, timeout: 600000 });
}
await pruneRuntime(bundle, target);
if (process.platform === 'darwin') {
  // microsoft/node-pty#850: stable 1.1.0 ships its macOS spawn-helper as 0644.
  // Fix executable metadata only; keep upstream code and the pinned version.
  const helper = join(bundle, 'node_modules', 'node-pty', 'prebuilds', target, 'spawn-helper');
  await chmod(helper, 0o755);
  await access(helper, 1); // X_OK; the real PTY test below must still pass.
}
const installed = JSON.parse(await readFile(join(bundle, 'node_modules', '@waishnav', 'devspace', 'package.json'), 'utf8'));
if (installed.version !== release.devspaceVersion) throw new Error('Installed upstream package differs from release pin');
if (omitOptionalDependencies) {
  // These optional packages are large enough that accidentally restoring them would materially
  // regress every Windows release artifact. The real package build is the enforcement gate.
  const excludedOptionalPayloads = [
    join(bundle, 'node_modules', 'node-pty'),
    ...((await readdir(join(bundle, 'node_modules', '@anthropic-ai'), { withFileTypes: true }))
      .filter(entry => entry.name.startsWith('claude-agent-sdk-'))
      .map(entry => join(bundle, 'node_modules', '@anthropic-ai', entry.name))),
  ];
  for (const path of excludedOptionalPayloads) {
    try {
      await access(path);
      throw new Error(`Optional runtime payload must not ship: ${path.slice(bundle.length + 1)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
await run(node, ['--input-type=module', '-e',
  "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close(); console.log('Bundled native SQLite loaded.');"],
{ cwd: bundle, env: buildEnvironment });
if (process.platform !== 'win32') {
  // Loading is insufficient: exercise a real native PTY after target pruning.
  await run(node, ['--input-type=module', '-e', `
    import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url), pty=require('node-pty');
    const child=pty.spawn('/bin/sh',['-c','printf team-devspace-pty'],{name:'xterm',cols:80,rows:24,env:process.env});
    let output=''; child.onData(data=>{output+=data});
    const timer=setTimeout(()=>{child.kill();process.exit(1)},10000);
    child.onExit(({exitCode})=>{clearTimeout(timer);setTimeout(()=>{
      if(exitCode!==0||!output.includes('team-devspace-pty'))process.exit(1);
      console.log('Bundled native PTY executed.');
    },50)});
  `], { cwd: bundle, env: buildEnvironment, timeout: 15000 });
}
await writeFile(dependencyMarker, fingerprint);
const cloudflared = join(bundle, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const cfVersion = (await run(cloudflared, ['--version'], { capture: true })).stdout;
if (!cfVersion.includes(release.cloudflaredVersion)) throw new Error('Bundled cloudflared version differs from release pin');
const cloudflaredSha256 = await sha256File(cloudflared);
// The employee manifest describes installed runtime dependencies, not this
// repository's build tools. This also lets npm inspect the real tree for SBOM
// generation without reporting deliberately omitted devDependencies as missing.
const { devDependencies: buildDependencies, ...runtimePackage } = packageJson;
await writeFile(join(bundle, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
const sbom = await run(node, [npmCli, 'sbom', '--sbom-format=cyclonedx', ...dependencyOmissions],
  { cwd: bundle, env: buildEnvironment, capture: true });
const sbomDocument = JSON.parse(sbom.stdout);
if (trayBuild?.implementation === 'rust') {
  await collectRustNotices(trayBuild.metadata, join(bundle, 'LICENSES', 'rust'));
  const rustPackages = trayBuild.metadata.packages.filter(package_ =>
    trayBuild.metadata.resolve.nodes.some(node => node.id === package_.id));
  sbomDocument.components.push(...rustPackages.map(package_ => ({ type: 'library', name: package_.name,
    version: package_.version, ...(package_.license ? { licenses: [{ expression: package_.license }] } : {}),
    purl: `pkg:cargo/${encodeURIComponent(package_.name)}@${package_.version}` })));
}
await writeFile(join(bundle, 'sbom.cdx.json'), `${JSON.stringify(sbomDocument, null, 2)}\n`);
// npm's hidden install metadata is not runtime code and carries app-level data.
await rm(join(bundle, 'node_modules', '.package-lock.json'), { force: true });
await writeFile(join(bundle, 'THIRD-PARTY-NOTICES.txt'), [
  `Team DevSpace includes @waishnav/devspace ${release.devspaceVersion} and its locked npm dependency versions; employee runtime archives omit source maps and TypeScript declaration files only.`,
  'Each dependency retains its own copyright and license files in node_modules. The SBOM lists package licenses.',
  `Node.js ${release.nodeVersion}: https://nodejs.org/ (license and notices in runtime/LICENSE)`,
  `cloudflared ${release.cloudflaredVersion}: Apache-2.0, https://github.com/cloudflare/cloudflared`,
  ...(trayBuild?.implementation === 'appkit' ? ['The macOS UI uses system AppKit/Foundation, with no third-party UI dependencies.'] : []),
  ...(trayBuild?.implementation === 'rust' ? ['The native tray dependency graph is recorded in Cargo.lock and sbom.cdx.json; original Cargo dependency license and notice files are retained in LICENSES/rust/.',
    'tray-icon 0.24.2: MIT OR Apache-2.0, https://github.com/tauri-apps/tray-icon'] : []),
  ...(process.platform === 'win32' ? [`Git for Windows ${release.gitFallbackVersion}: GPL-2.0 and bundled component licenses retained under git/.`,
    `Corresponding sources and redistribution notices: https://github.com/git-for-windows/git/releases/tag/v${release.gitFallbackVersion}`] : []),
  'This distribution does not grant a license to employee project files or credentials.', '',
].join('\n'));
if (process.platform === 'win32') {
  const maximumRelative = await maximumRelativePathLength(bundle);
  const worstCasePrefix = `C:\\Users\\${'x'.repeat(20)}\\AppData\\Local\\TDS\\v\\0\\`.length;
  if (maximumRelative + worstCasePrefix >= 260) {
    throw new Error(`Windows package contains a path that can exceed MAX_PATH (${maximumRelative + worstCasePrefix}); shorten/remove the dependency instead of shipping a fragile installer`);
  }
}
await writeFile(join(bundle, 'release-provenance.json'), JSON.stringify({
  releaseProfileSha256: releaseProfileDigest(release),
  release: release.version, target, upstream: { package: '@waishnav/devspace', version: installed.version },
  binaries: Object.fromEntries(downloadKinds.map(kind => [kind, binaries[kind][target]])), lockSha256,
  dependencyFingerprint: fingerprint, dependencyInstallProfile, npmVersion,
  ...(process.platform === 'darwin' ? { cloudflaredBuild: {
    version: release.cloudflaredVersion, sourceCommit: release.cloudflaredSourceCommit,
    goVersion: release.cloudflaredGoVersion, minimumMacOS: release.distribution.macosMinimumVersion,
    sha256: cloudflaredSha256, reusedFromBuildCache: process.env.TEAM_DEVSPACE_CLOUDFLARED_CACHE_HIT === '1',
  } } : {}),
  ...(trayBuild ? { tray: { implementation: trayBuild.implementation,
    ...(trayBuild.implementation === 'rust' ? {
      crate: 'tray-icon', version: '0.24.2', rustVersion: trayBuild.rustVersion,
      lockSha256: createHash('sha256').update(await readFile('native/tray/Cargo.lock')).digest('hex'),
    } : { toolchain: trayBuild.toolchain, minimumMacOS: release.distribution.macosMinimumVersion }),
    sha256: await sha256File(process.platform === 'darwin'
      ? join(bundle, 'platform', 'macos', 'Team DevSpace Tray.app', 'Contents', 'MacOS', 'TeamDevSpaceTray')
      : join(bundle, 'platform', 'windows', 'team-devspace-tray.exe')),
  } } : {}),
}, null, 2));
console.log(JSON.stringify({ prepared: true, target, bundle, devspace: installed.version, node: version }));
if (!values['prepare-only']) {
  const distribution = await buildReleaseLayout({ bundle, target, release, tar, outputDirectory, gitFallbackArchive: downloads.git });
  let artifact;
  if (process.platform === 'win32') {
    const nsisZip = await downloadPinned(binaries.nsis, cache);
    const compilerRoot = resolve('build/nsis');
    await rm(compilerRoot, { recursive: true, force: true });
    await mkdir(compilerRoot, { recursive: true });
    await run(tar, ['-xf', nsisZip, '-C', compilerRoot]);
    const entries = await readdir(compilerRoot, { withFileTypes: true });
    const directory = entries.find(entry => entry.isDirectory() && entry.name.startsWith('nsis-'));
    if (!directory) throw new Error('Unexpected NSIS archive layout');
    artifact = join(outputDirectory, `Team-DevSpace-${release.version}-windows-x64-setup.exe`);
    await run(join(compilerRoot, directory.name, 'makensis.exe'), ['/V2', '/NOCD',
      `/DBOOTSTRAP=${resolve('platform/windows/bootstrap.ps1')}`, `/DMANIFEST=${distribution.manifestPath}`,
      `/DOFFLINE_OBJECTS=${join(distribution.layout, 'objects')}`, `/DPLATFORM_DIR=${resolve('platform/windows')}`,
      `/DLAUNCHER=${join(bundle, 'platform', 'windows', 'tds-launcher.exe')}`,
      `/DAPP_ICON=${join(bundle, 'platform', 'windows', 'team-devspace.ico')}`,
      `/DAPP_VERSION=${release.version}`,
      `/DAPP_VERSION_NUM=${release.version.split('-')[0]}.0`, `/DDEVSPACE_VERSION=${release.devspaceVersion}`, `/DOUTPUT=${artifact}`,
      resolve('platform/windows/installer.nsi')], { timeout: 600000 });
  } else if (process.platform === 'darwin') {
    const pkgRoot = resolve(`build/pkg-root-${target}`);
    await rm(pkgRoot, { recursive: true, force: true });
    const contents = join(pkgRoot, 'Applications', 'Team DevSpace.app', 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await cp('platform/unix/bootstrap.sh', join(contents, 'Resources', 'bootstrap.sh'));
    await buildMacAppIcon('platform/macos/devspace-logo-light.png', join(contents, 'Resources', 'TeamDevSpace.icns'));
    await cp(distribution.manifestPath, join(contents, 'Resources', 'release-manifest.json'));
    await cp(join(distribution.layout, 'objects'), join(contents, 'Resources', 'objects'), { recursive: true });
    await chmod(join(contents, 'Resources', 'bootstrap.sh'), 0o755);
    await cp('platform/macos/launch-app.sh', join(contents, 'MacOS', 'TeamDevSpace'));
    await chmod(join(contents, 'MacOS', 'TeamDevSpace'), 0o755);
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.teamdevspace.app</string>
<key>CFBundleName</key><string>Team DevSpace</string><key>CFBundleExecutable</key><string>TeamDevSpace</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIconFile</key><string>TeamDevSpace.icns</string>
<key>LSMultipleInstancesProhibited</key><true/>
${macBundleMetadata}</dict></plist>\n`);
    await signMacApplication(dirname(contents), macosSigning);
    await mkdir(join(pkgRoot, 'usr', 'local', 'bin'), { recursive: true });
    await cp('platform/macos/command.sh', join(pkgRoot, 'usr', 'local', 'bin', 'team-devspace'));
    await chmod(join(pkgRoot, 'usr', 'local', 'bin', 'team-devspace'), 0o755);
    const packageScripts = resolve(`build/pkg-scripts-${target}`);
    await mkdir(packageScripts, { recursive: true });
    for (const name of ['preinstall', 'postinstall']) {
      const source = join('platform', 'macos', name);
      const targetScript = join(packageScripts, name);
      if (name === 'preinstall') {
        const template = await readFile(source, 'utf8');
        const rendered = template
          .replaceAll('__TEAM_DEVSPACE_MACOS_ARCH__', process.arch)
          .replaceAll('__TEAM_DEVSPACE_MACOS_MINIMUM_VERSION__', release.distribution.macosMinimumVersion);
        if (rendered.includes('__TEAM_DEVSPACE_')) throw new Error('macOS preinstall template was not fully rendered');
        await writeFile(targetScript, rendered);
      } else await cp(source, targetScript);
      await chmod(targetScript, 0o755);
    }
    const components = resolve(`build/pkg-components-${target}.plist`);
    await writeFile(components, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><array><dict><key>RootRelativeBundlePath</key><string>Applications/Team DevSpace.app</string>
<key>BundleIsRelocatable</key><false/><key>BundleHasStrictIdentifier</key><true/>
<key>BundleIsVersionChecked</key><true/><key>BundleOverwriteAction</key><string>upgrade</string></dict></array></plist>`);
    artifact = join(outputDirectory, `Team-DevSpace-${release.version}-macos-${process.arch}.pkg`);
    await run('/usr/bin/pkgbuild', ['--root', pkgRoot, '--identifier', 'com.teamdevspace.installer',
      '--version', release.version, '--install-location', '/', '--component-plist', components,
      '--scripts', packageScripts, ...(macosSigning ? ['--sign', macosSigning.installerIdentity] : []), artifact],
    { timeout: 600000 });
    await notarizeMacPackage(artifact, macosSigning);
  } else {
    const bootstrapRoot = resolve(`build/bootstrap-${target}`);
    await rm(bootstrapRoot, { recursive: true, force: true });
    await mkdir(bootstrapRoot, { recursive: true });
    await cp('platform/unix/bootstrap.sh', join(bootstrapRoot, 'install.sh'));
    await cp(distribution.manifestPath, join(bootstrapRoot, 'release-manifest.json'));
    await cp(join(distribution.layout, 'objects'), join(bootstrapRoot, 'objects'), { recursive: true });
    await chmod(join(bootstrapRoot, 'install.sh'), 0o755);
    artifact = join(outputDirectory, `Team-DevSpace-${release.version}-linux-${process.arch}-offline.tar.gz`);
    await run(tar, ['-czf', artifact, '-C', bootstrapRoot, 'install.sh', 'release-manifest.json', 'objects']);
  }
  await cp(artifact, join(distribution.layout, artifact.split(/[\\/]/).pop()));
  const checksum = await sha256File(artifact);
  await writeFile(`${artifact}.sha256`, `${checksum}  ${artifact.split(/[\\/]/).pop()}\n`);
  await cp(`${artifact}.sha256`, join(distribution.layout, `${artifact.split(/[\\/]/).pop()}.sha256`));
  // Native smoke tests still use bundle/ and the NSIS compiler; expanded
  // packaging intermediates are neither caches nor release outputs.
  for (const path of [`build/distribution-${target}`, `build/pkg-root-${target}`, `build/pkg-scripts-${target}`,
    `build/pkg-components-${target}.plist`, `build/bootstrap-${target}`]) {
    await rm(resolve(path), { recursive: true, force: true });
  }
  console.log(JSON.stringify({ artifact, sha256: checksum, signed: false }));
}
