import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateDistributionConfig } from './distribution.mjs';

async function check(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.mjs') || path.endsWith('.js')) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  }
}

for (const directory of ['gateway', 'client', 'scripts', 'test']) await check(directory);

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const deployment = JSON.parse(await readFile('config/deployment.example.json', 'utf8'));
const wrangler = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const packageWorkflow = await readFile('.github/workflows/build-installers.yml', 'utf8');
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

if (deployment.zoneId !== '0'.repeat(32) || deployment.databaseId !== '00000000-0000-0000-0000-000000000000' ||
    deployment.accessApplicationId !== null || 'cloudflareZoneId' in release) {
  throw new Error('Source must contain examples only; production resource identities belong to private operator configuration');
}

if (wrangler.assets?.binding !== 'ASSETS' ||
    JSON.stringify(wrangler.assets?.run_worker_first) !== JSON.stringify(['/*', '!/mcp-app-assets/*'])) {
  throw new Error('Only public MCP assets may bypass the Worker; authenticated control routes, including status-v2, must remain Worker-first');
}
if (!wrangler.observability?.enabled || !wrangler.observability?.logs?.enabled || !wrangler.observability?.redact_query_string ||
    wrangler.observability.logs.invocation_logs !== false || wrangler.observability.logs.head_sampling_rate !== 1) {
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

for (const label of ['windows-2022', 'ubuntu-24.04', 'macos-15', 'macos-15-intel']) {
  if (!packageWorkflow.includes(label)) throw new Error(`Native candidate matrix is missing ${label}`);
}
if (/macos-accept-existing|arch -x86_64|workflow_run|pull_request_target/.test(packageWorkflow) ||
    !packageWorkflow.includes('npm run package') || !packageWorkflow.includes('acceptance:platform')) {
  throw new Error('Native candidate builds must build and accept their own final bytes without Rosetta or privileged PR triggers');
}
if (!release.distribution.targets.includes('darwin-arm64') || !release.distribution.targets.includes('darwin-x64') ||
    !/^[a-f0-9]{64}$/.test(binaries.node?.['darwin-x64']?.sha256 ?? '')) {
  throw new Error('macOS release targets must include pinned Apple Silicon and Intel runtimes');
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
for (const name of (await readdir('.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
  const workflow = await readFile(join('.github/workflows', name), 'utf8');
  const externalRefs = [...workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)];
  if (externalRefs.some(([, , reference]) => !/^[a-f0-9]{40}$/.test(reference))) {
    throw new Error(`Every external Action must use a full commit SHA: ${name}`);
  }
  if (/^\s*(?:pull_request_target|workflow_run):/m.test(workflow) || /runs-on:\s*self-hosted/.test(workflow)) {
    throw new Error(`Privileged PR follow-up and employee/self-hosted runners are not part of this release design: ${name}`);
  }
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
if ('cloudflare' in release || release.gateway !== 'https://gateway.example.com' ||
    release.distribution.origin !== 'https://downloads.example.com' || release.distribution.updatePublicKey !== 'A'.repeat(43)) {
  throw new Error('Tracked release config must remain a sample edition; inject operator endpoints and trust key via release profile');
}
const gateway = new URL(release.gateway);
if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash ||
    gateway.hostname.split('.').length < 3) {
  throw new Error('Release gateway must be a bare HTTPS single-label subdomain; deployment verifies it against the configured Zone');
}

execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
const licenseHash = createHash('sha256').update(await readFile('LICENSE')).digest('hex');
if (licenseHash !== '67530f8e9adfcc5d2e9d72b804500cebb7472ff84c34a6729a80a2a9be901ee6') {
  throw new Error('LICENSE must match the unmodified official PolyForm Shield 1.0.0 text');
}
if (!deployWorkflow.includes("github.ref == 'refs/heads/main'") ||
    !deployWorkflow.includes('contents: read') || deployWorkflow.includes('--ci --provision') ||
    deployWorkflow.includes('gh api') || deployWorkflow.includes('contents: write')) {
  throw new Error('Deployment must be main-only, read-only for repository contents, and never provision/write config back to Git');
}
console.log('Syntax, release pins, thin dependency/build policy, gateway metadata, supply-chain pins, and diff whitespace checks passed.');
