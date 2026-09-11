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
const retiredPackageWorkflow = await readFile('.github/workflows/build-installers.yml', 'utf8');
const codemagic = await readFile('codemagic.yaml', 'utf8');
const deployWorkflow = await readFile('.github/workflows/deploy.yml', 'utf8');
const binaries = JSON.parse(await readFile('scripts/binaries.json', 'utf8'));
const windowsSigning = await readFile('scripts/sign-internal-windows.ps1', 'utf8');
const windowsPlatformFiles = await readdir('platform/windows');
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
if (!wrangler.observability?.enabled || !wrangler.observability?.logs?.enabled || !wrangler.observability?.redact_query_string) {
  throw new Error('Gateway must keep privacy-aware Workers Logs enabled');
}
if (wrangler.workers_dev !== false || wrangler.preview_urls !== false) {
  throw new Error('Gateway must remain Access-only without workers.dev or preview URLs');
}

if (manifest.packageManager !== `npm@${manifest.devDependencies.npm}`) {
  throw new Error('Build npm must match packageManager');
}
const allowedRuntimeDependencies = ['@waishnav/devspace', 'jose', 'proper-lockfile'].sort();
const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
if (JSON.stringify(runtimeDependencies) !== JSON.stringify(allowedRuntimeDependencies)) {
  throw new Error(`Employee runtime dependencies must stay thin: ${allowedRuntimeDependencies.join(', ')}`);
}

if (retiredPackageWorkflow.includes('npm run package') || retiredPackageWorkflow.includes('macos-15') ||
    retiredPackageWorkflow.includes('windows-2022') || retiredPackageWorkflow.includes('linux-x64')) {
  throw new Error('GitHub Actions native packaging must remain retired; macOS builds on Codemagic and Windows/Linux build locally');
}
if (!codemagic.includes('instance_type: mac_mini_m2') || !codemagic.includes('npm run package') ||
    codemagic.includes('npm run package -- --reuse-dependencies') || codemagic.includes('npm ci') ||
    codemagic.includes('rustup') || codemagic.includes('TEAM_DEVSPACE_TRAY_') ||
    codemagic.includes('/usr/sbin/installer -verboseR') || codemagic.includes('acceptance:platform') ||
    codemagic.includes('triggering:')) {
  throw new Error('Codemagic must remain a manual, macOS-only thin package build');
}

if (windowsPlatformFiles.includes('launch.ps1') || windowsPlatformFiles.includes('process-job.ps1')) {
  throw new Error('Windows background startup must not restore retired script launchers');
}
if (manifest.scripts['acceptance:platform'] !== 'node scripts/platform-acceptance.mjs' ||
    !manifest.scripts['acceptance:local']?.includes('npm run acceptance:platform')) {
  throw new Error('Platform acceptance must remain part of the explicit local release gate');
}

if (!/^[a-f0-9]{64}$/.test(binaries.zig?.['win32-x64']?.executableSha256 ?? '')) {
  throw new Error('Cached Windows Zig executable must have an exact SHA-256 pin');
}
const officialActionRefs = [...deployWorkflow.matchAll(/uses:\s+(actions\/[A-Za-z0-9_.-]+)@([^\s#]+)/g)];
if (officialActionRefs.length === 0 || officialActionRefs.some(([, , reference]) => !/^[a-f0-9]{40}$/.test(reference))) {
  throw new Error('Every GitHub-owned Action must remain pinned to a full 40-character commit SHA');
}
for (const required of [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
]) {
  if (!deployWorkflow.includes(required)) throw new Error(`GitHub Action must stay on its reviewed Node 24 pin: ${required}`);
}

if (!picoLicense.includes('MIT License')) throw new Error('Vendored Pico CSS must keep its MIT license');
if (!windowsSigning.includes('Set-AuthenticodeSignature') || !windowsSigning.includes('Get-AuthenticodeSignature') ||
    /addstore|X509Store|TrustedPublisher/i.test(windowsSigning)) {
  throw new Error('Windows release signing must verify Authenticode without mutating runner trust stores');
}
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
console.log('Syntax, release pins, thin dependency/build policy, gateway metadata, supply-chain pins, and diff whitespace checks passed.');
