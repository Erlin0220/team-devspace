import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { validateDistributionConfig } from './distribution.mjs';

async function check(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.mjs')) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}
for (const directory of ['gateway', 'client', 'scripts', 'test']) await check(directory);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const deployment = JSON.parse(await readFile('deployment.config.json', 'utf8'));
const wrangler = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const releaseWorkflow = await readFile('.github/workflows/build-installers.yml', 'utf8');
const deployWorkflow = await readFile('.github/workflows/deploy.yml', 'utf8');
const workflows = `${releaseWorkflow}\n${deployWorkflow}`;
const packageScript = await readFile('scripts/package.mjs', 'utf8');
const binaries = JSON.parse(await readFile('scripts/binaries.json', 'utf8'));
const windowsInstaller = await readFile('platform/windows/installer.nsi', 'utf8');
const windowsBootstrap = await readFile('platform/windows/bootstrap.ps1', 'utf8');
const windowsSigning = await readFile('scripts/sign-internal-windows.ps1', 'utf8');
const clientSetup = await readFile('client/setup.mjs', 'utf8');
const unixBootstrap = await readFile('platform/unix/bootstrap.sh', 'utf8');
const macosPreinstall = await readFile('platform/macos/preinstall', 'utf8');
const macosPostinstall = await readFile('platform/macos/postinstall', 'utf8');
const macosLaunchApp = await readFile('platform/macos/launch-app.sh', 'utf8');
const windowsLauncher = await readFile('platform/windows/tds-launcher.c', 'utf8');
const windowsPlatformFiles = await readdir('platform/windows');
const trayCargo = await readFile('native/tray/Cargo.toml', 'utf8');
const trayLock = await readFile('native/tray/Cargo.lock', 'utf8');
const trayToolchain = await readFile('native/tray/rust-toolchain.toml', 'utf8');
const trayBuild = await readFile('scripts/tray-build.mjs', 'utf8');
const trayMain = await readFile('native/tray/src/main.rs', 'utf8');
const nativeSmoke = await readFile('scripts/native-smoke.mjs', 'utf8');
const platformAcceptance = await readFile('scripts/platform-acceptance.mjs', 'utf8');
const acceptanceVerifier = await readFile('scripts/verify-acceptance.mjs', 'utf8');
const adminWeb = await readFile('gateway/admin-web.mjs', 'utf8');
const picoLicense = await readFile('assets/admin/PICO-LICENSE.md', 'utf8');
if (manifest.dependencies['@waishnav/devspace'] !== release.devspaceVersion) {
  throw new Error('Unexpected upstream DevSpace version pin');
}
if (manifest.version !== release.version) throw new Error('Package and release versions differ');
if (!Number.isInteger(release.controlApiVersion) || release.controlApiVersion < 1) {
  throw new Error('Release controlApiVersion must be a positive integer');
}
validateDistributionConfig(release);
if (Object.keys(deployment).some(key => !['databaseId', 'accessApplicationId'].includes(key)) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deployment.databaseId ?? '') ||
    (deployment.accessApplicationId !== null &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deployment.accessApplicationId ?? ''))) {
  throw new Error('deployment.config.json stores only owned D1 and Access Application resource IDs');
}
if (wrangler.assets?.binding !== 'ASSETS' || wrangler.assets?.run_worker_first !== true) {
  throw new Error('The single gateway Worker must serve static assets through its ASSETS binding');
}
if (manifest.packageManager !== `npm@${manifest.devDependencies.npm}`) {
  throw new Error('Build npm must match packageManager');
}
if (!wrangler.observability?.enabled || !wrangler.observability?.logs?.enabled || !wrangler.observability?.redact_query_string) {
  throw new Error('Gateway must keep privacy-aware Workers Logs enabled');
}
if (!releaseWorkflow.includes('gh release create') || !releaseWorkflow.includes("--jq '.private'") ||
    !releaseWorkflow.includes('healthMatches') ||
    /\brclone\b|cloudflarestorage\.com|RCLONE_CONFIG_RELEASES/i.test(releaseWorkflow)) {
  throw new Error('Release workflow must verify the live Gateway and publish only to a verified private GitHub Release');
}
if (!windowsInstaller.includes('nsExec::ExecToLog') || /ExecWait[^\r\n]*powershell/i.test(windowsInstaller)) {
  throw new Error('Windows install/uninstall bootstrap must use no-console NSIS execution');
}
if (!windowsInstaller.includes('PBM_SETMARQUEE') || !windowsInstaller.includes('StartBootstrapProgress') ||
    !windowsInstaller.includes('StopBootstrapProgress') ||
    !windowsInstaller.includes('$mui.InstFilesPage.ProgressBar') || windowsInstaller.includes('GetDlgItem $ProgressControl') ||
    windowsInstaller.includes('Var ProgressControl') || !windowsBootstrap.includes('function Write-Step')) {
  throw new Error('Windows bootstrap must show indeterminate progress and readable installation stages');
}
if (!windowsBootstrap.includes("@('startup', 'install', '--runtime-root', [string]$Previous.path)") ||
    !windowsBootstrap.includes("Write-AtomicJson $activeFile $next") ||
    !windowsBootstrap.includes("ValidateSet('Install', 'Uninstall')") ||
    !windowsBootstrap.includes('Remove-KnownStartupEntries') || !windowsBootstrap.includes('Invoke-LegacyTaskCleanupIfNeeded') ||
    !windowsBootstrap.includes("Start-Process -FilePath $cmd -Verb RunAs") ||
    !windowsBootstrap.includes('exit 10') ||
    !windowsInstaller.includes('$ResultCode == 10') ||
    !windowsInstaller.includes('File /r "${OFFLINE_OBJECTS}\\*.*"') ||
    !windowsInstaller.includes('$PLUGINSDIR\\offline') ||
    windowsBootstrap.includes('$cacheRoot') || windowsBootstrap.includes('$legacyRoot')) {
  throw new Error('Windows Installer V2 must embed its payload, keep local A/B recovery, and treat first-run connection failure as post-install state');
}
if (!clientSetup.includes('Existing Enrollment found. Reusing the current Device Binding...') ||
    !clientSetup.includes("const remoteAccess = previous.remoteAccess === 'suspended' ? 'suspended' : 'active'") ||
    clientSetup.includes("Recovered a legacy stopped state. Restoring normal connection startup...") ||
    !clientSetup.includes("'/v1/enrollment/preflight'") || !clientSetup.includes("'/v1/device/release'") ||
    !clientSetup.includes("connection: startup ? 'starting' : 'not-started'")) {
  throw new Error('Existing Enrollment must preserve explicit pause intent, and Access Key replacement must validate before releasing the current Device Binding');
}
if (!unixBootstrap.includes('invoke_client "$candidate" uninstall') ||
    !unixBootstrap.includes('invoke_client "$candidate" startup install --runtime-root "$current"') ||
    !unixBootstrap.includes('candidate startup cleanup and previous startup restoration both failed')) {
  throw new Error('Unix failed candidate activation must still restore the previous local version');
}
if (macosPreinstall.includes('cli.mjs" stop') || !macosPreinstall.includes('/usr/bin/ditto')) {
  throw new Error('macOS preinstall must preserve a recoverable legacy copy without stopping the active user session');
}
const macosMinimumKey = '<key>LSMinimumSystemVersion</key><string>${release.distribution.macosMinimumVersion}</string>';
if (release.distribution.macosMinimumVersion !== '12.0' || packageScript.split(macosMinimumKey).length - 1 !== 2 ||
    !trayBuild.includes('MACOSX_DEPLOYMENT_TARGET: release.distribution.macosMinimumVersion') ||
    !packageScript.includes("process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: release.distribution.macosMinimumVersion } : {}") ||
    !packageScript.includes('`:macos-${release.distribution.macosMinimumVersion}`') ||
    !macosPreinstall.includes('__TEAM_DEVSPACE_MACOS_ARCH__') ||
    !macosPreinstall.includes('__TEAM_DEVSPACE_MACOS_MINIMUM_VERSION__') ||
    !macosPreinstall.includes('code=UNSUPPORTED_ARCH') || !macosPreinstall.includes('code=UNSUPPORTED_MACOS') ||
    !macosPostinstall.startsWith('#!/bin/sh\nset -u\n') || macosPostinstall.includes('set -eu') ||
    !macosPostinstall.includes('if ! /bin/launchctl asuser') ||
    !macosLaunchApp.includes('setup.log') || !macosLaunchApp.includes('>> "$LOG" 2>&1') ||
    !releaseWorkflow.includes('/usr/bin/lipo -archs') || !releaseWorkflow.includes('/usr/bin/otool -l') ||
    !releaseWorkflow.includes('macOS deployment target mismatch: $file') ||
    !releaseWorkflow.includes('/usr/sbin/installer -verboseR') ||
    !releaseWorkflow.includes("\\[postinstall\\] skip auto-open")) {
  throw new Error('macOS packaging must share one minimum-OS source, keep postinstall fail-open, capture setup diagnostics, scan final Mach-O compatibility, and execute a real Installer transaction');
}
if (!windowsLauncher.includes('CREATE_NO_WINDOW') || !windowsLauncher.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE') ||
    windowsPlatformFiles.includes('launch.ps1') || windowsPlatformFiles.includes('process-job.ps1')) {
  throw new Error('Windows background startup must use only the precompiled no-console launcher');
}
if (!trayCargo.includes('tray-icon = { version = "=0.24.2"') || !trayCargo.includes('winit = "=0.30.12"') ||
    !trayCargo.includes('windows-sys = { version = "=0.61.2"') || !trayCargo.includes('libc = "=0.2.189"') ||
    !trayToolchain.includes('channel = "1.85.1"') || !trayLock.includes('name = "tray-icon"') ||
    !trayBuild.includes("'test', '--release', '--locked'") || !trayBuild.includes("'build', '--release', '--locked'") ||
    !trayMain.includes('CreateMutexW') || !trayMain.includes('libc::flock') || !trayMain.includes('emit("duplicate", None)') ||
    !trayMain.includes('include_bytes!("../assets/team-devspace-32.rgba")') ||
    !trayMain.includes('Submenu::new("故障排查"') || !trayMain.includes('MenuItem::new("更换 Access Key…"') ||
    !releaseWorkflow.includes('npm run package')) {
  throw new Error('Native tray must stay single-instance, use the branded embedded icon, expose the compact troubleshooting/key lifecycle menu, and enter the native package matrix');
}
if (manifest.scripts['acceptance:platform'] !== 'node scripts/platform-acceptance.mjs' ||
    !manifest.scripts['acceptance:local']?.includes('npm run acceptance:platform') ||
    !releaseWorkflow.includes('Run final platform acceptance gate') || !releaseWorkflow.includes('npm run acceptance:platform') ||
    !releaseWorkflow.includes('npm run verify:acceptance') || !platformAcceptance.includes('finalEntrypointTransaction') ||
    !platformAcceptance.includes('traySingleInstance') || !platformAcceptance.includes('sourceDirty') ||
    !nativeSmoke.includes('scopedStaleTaskMigration') ||
    !acceptanceVerifier.includes('published entrypoint differs from the accepted bytes') ||
    !acceptanceVerifier.includes('acceptance was produced from a dirty source checkout')) {
  throw new Error('Release publication must be gated by one auditable platform acceptance path bound to clean source and the final entrypoint bytes');
}
if (!releaseWorkflow.includes('Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4') ||
    !releaseWorkflow.includes('build/tray-target-${{ matrix.target }}') ||
    !releaseWorkflow.includes('actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9') ||
    !releaseWorkflow.includes('build/zig-win32-x64')) {
  throw new Error('Native package CI must reuse the pinned Rust dependency cache and verified Windows Zig toolchain cache');
}
if (!/^[a-f0-9]{64}$/.test(binaries.zig?.['win32-x64']?.executableSha256 ?? '')) {
  throw new Error('Cached Windows Zig executable must have an exact SHA-256 pin');
}
const officialActionRefs = [...workflows.matchAll(/uses:\s+(actions\/[A-Za-z0-9_.-]+)@([^\s#]+)/g)];
if (officialActionRefs.length === 0 || officialActionRefs.some(([, , reference]) => !/^[a-f0-9]{40}$/.test(reference))) {
  throw new Error('Every GitHub-owned Action must remain pinned to a full 40-character commit SHA');
}
for (const required of [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
]) {
  if (!workflows.includes(required)) throw new Error(`GitHub Action must stay on its reviewed Node 24 pin: ${required}`);
}
if (wrangler.workers_dev !== false || wrangler.preview_urls !== false ||
    !adminWeb.includes("default-src 'none'") || !adminWeb.includes('/admin/assets/admin.js') ||
    !picoLicense.includes('MIT License')) {
  throw new Error('Admin Web must remain Access-only, CSP-protected and carry the vendored Pico license');
}
if (release.distribution.trustProfile === 'internal-free' &&
    (!releaseWorkflow.includes('WINDOWS_INTERNAL_SIGNING_PFX_BASE64') ||
      !releaseWorkflow.includes('sign-internal-windows.ps1') ||
      !releaseWorkflow.includes('macos-signing.mjs prepare') ||
      !releaseWorkflow.includes('macos-signing.mjs cleanup'))) {
  throw new Error('Internal-free publication must keep fixed Windows signing and an optional, non-gating protected macOS signing path');
}
if (!windowsSigning.includes('Set-AuthenticodeSignature') || !windowsSigning.includes('Get-AuthenticodeSignature') ||
    /addstore|X509Store|TrustedPublisher/i.test(windowsSigning)) {
  throw new Error('Windows release signing must verify Authenticode without mutating runner trust stores');
}
if (manifest.dependencies['@clack/prompts']) throw new Error('Administrator-only prompts must not ship as an employee runtime dependency');
if (!/^[a-f0-9]{32}$/.test(release.cloudflareZoneId ?? '')) {
  throw new Error('Release Cloudflare Zone ID is incomplete');
}
if ('cloudflare' in release) {
  throw new Error('Release Cloudflare metadata must stay thin: use cloudflareZoneId only; Account and device domain are derived from the Zone');
}
const gateway = new URL(release.gateway);
if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash ||
    gateway.hostname.split('.').length < 3) {
  throw new Error('Release gateway must be a bare HTTPS single-label subdomain; deployment verifies it against the configured Zone');
}
execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
console.log('Syntax, release/upstream pins, dependency boundary, private GitHub release policy, Cloudflare gateway metadata, and diff whitespace checks passed.');
