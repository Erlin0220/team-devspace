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
const windowsInstaller = await readFile('platform/windows/installer.nsi', 'utf8');
const windowsBootstrap = await readFile('platform/windows/bootstrap.ps1', 'utf8');
const unixBootstrap = await readFile('platform/unix/bootstrap.sh', 'utf8');
const macosPreinstall = await readFile('platform/macos/preinstall', 'utf8');
const windowsLauncher = await readFile('platform/windows/tds-launcher.c', 'utf8');
const windowsPlatformFiles = await readdir('platform/windows');
const trayCargo = await readFile('native/tray/Cargo.toml', 'utf8');
const trayLock = await readFile('native/tray/Cargo.lock', 'utf8');
const trayToolchain = await readFile('native/tray/rust-toolchain.toml', 'utf8');
const trayBuild = await readFile('scripts/tray-build.mjs', 'utf8');
const adminWeb = await readFile('gateway/admin-web.mjs', 'utf8');
const picoLicense = await readFile('assets/admin/PICO-LICENSE.md', 'utf8');
if (manifest.dependencies['@waishnav/devspace'] !== release.devspaceVersion) {
  throw new Error('Unexpected upstream DevSpace version pin');
}
if (manifest.version !== release.version) throw new Error('Package and release versions differ');
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
    /\brclone\b|cloudflarestorage\.com|RCLONE_CONFIG_RELEASES/i.test(releaseWorkflow)) {
  throw new Error('Release workflow must publish only to a verified private GitHub Release and contain no legacy object-storage publication path');
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
if (!windowsBootstrap.includes("@('uninstall')") ||
    !windowsBootstrap.includes("@('startup', 'install', '--runtime-root', [string]$Previous.path)") ||
    !unixBootstrap.includes('invoke_client "$candidate" uninstall') ||
    !unixBootstrap.includes('invoke_client "$candidate" startup install --runtime-root "$current"') ||
    !windowsBootstrap.includes('Candidate startup cleanup also failed') ||
    !unixBootstrap.includes('candidate startup cleanup and previous startup restoration both failed')) {
  throw new Error('Failed candidate activation must remove partial startup entries and restore the previous version offline');
}
if (!windowsBootstrap.includes("Join-Path $legacyRoot 'client\\cli.mjs'") ||
    !windowsBootstrap.includes('Incomplete legacy payload ignored') ||
    !windowsBootstrap.includes('Remove-Item -LiteralPath $legacyRoot -Recurse -Force')) {
  throw new Error('Windows bootstrap must ignore and retire an incomplete legacy payload instead of blocking activation');
}
if (macosPreinstall.includes('cli.mjs" stop') || !macosPreinstall.includes('/usr/bin/ditto')) {
  throw new Error('macOS preinstall must preserve a recoverable legacy copy without stopping the active user session');
}
if (!windowsLauncher.includes('CREATE_NO_WINDOW') || !windowsLauncher.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE') ||
    windowsPlatformFiles.includes('launch.ps1') || windowsPlatformFiles.includes('process-job.ps1')) {
  throw new Error('Windows background startup must use only the precompiled no-console launcher');
}
if (!trayCargo.includes('tray-icon = { version = "=0.24.2"') || !trayCargo.includes('winit = "=0.30.12"') ||
    !trayToolchain.includes('channel = "1.85.1"') || !trayLock.includes('name = "tray-icon"') ||
    !trayBuild.includes("'--release', '--locked'") || !releaseWorkflow.includes('npm run package')) {
  throw new Error('Native tray must use exact Rust/crate locks and enter the existing native package matrix');
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
