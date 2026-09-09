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
if (manifest.dependencies['@waishnav/devspace'] !== release.devspaceVersion) {
  throw new Error('Unexpected upstream DevSpace version pin');
}
if (manifest.version !== release.version) throw new Error('Package and release versions differ');
validateDistributionConfig(release);
if (deployment.accountId !== release.cloudflare.accountId || deployment.zoneId !== release.cloudflare.zoneId ||
    deployment.gateway !== release.gateway || deployment.releaseBucket !== release.distribution.bucket ||
    deployment.releaseHostname !== release.distribution.hostname || deployment.releaseVisibility !== release.distribution.visibility) {
  throw new Error('Declarative deployment resources differ from canonical release metadata');
}
if (!wrangler.observability?.enabled || !wrangler.observability?.logs?.enabled || !wrangler.observability?.redact_query_string) {
  throw new Error('Gateway must keep privacy-aware Workers Logs enabled');
}
if (!releaseWorkflow.includes('rclone copy') || !releaseWorkflow.includes('--immutable') || releaseWorkflow.includes('r2 object put')) {
  throw new Error('Release workflow must use immutable bulk publication and cannot use overwritable per-object puts');
}
if (manifest.dependencies['@clack/prompts']) throw new Error('Administrator-only prompts must not ship as an employee runtime dependency');
if (!/^[a-f0-9]{32}$/.test(release.cloudflare?.accountId ?? '') || !/^[a-f0-9]{32}$/.test(release.cloudflare?.zoneId ?? '') ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(release.cloudflare?.deviceDomain ?? '')) {
  throw new Error('Release Cloudflare metadata is incomplete');
}
const gateway = new URL(release.gateway);
if (gateway.protocol !== 'https:' || !gateway.hostname.endsWith(`.${release.cloudflare.deviceDomain}`) || gateway.pathname !== '/') {
  throw new Error('Release gateway must be a bare HTTPS subdomain of the configured Cloudflare zone');
}
execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
console.log('Syntax, release/upstream pins, dependency boundary, Cloudflare metadata, and diff whitespace checks passed.');
