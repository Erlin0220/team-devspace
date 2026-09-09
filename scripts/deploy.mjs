import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { atomicJson, normalizeGateway, randomSecret, readJson, secureStateDirectory } from '../client/state.mjs';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, ci: { type: 'boolean' }, provision: { type: 'boolean' }, config: { type: 'string' } } });
const directory = values.ci ? resolve(process.env.RUNNER_TEMP ?? 'build/deploy-ci') : resolve('.runtime');
await secureStateDirectory(directory);
const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const assetsBase = JSON.parse(await readFile('wrangler.assets.jsonc', 'utf8'));
const release = await readJson('release.config.json');
let deployment = await readJson('deployment.config.json');
const config = values['dry-run'] ? null : values.ci ? {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  zoneId: process.env.CLOUDFLARE_ZONE_ID,
  gateway: release.gateway,
  deviceDomain: release.cloudflare.deviceDomain,
  deployToken: process.env.CLOUDFLARE_API_TOKEN,
  runtimeToken: process.env.CF_RUNTIME_API_TOKEN,
} : await readJson(values.config ?? join(directory, 'cloudflare.json'));
const workerName = 'team-devspace';
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true',
  ...(config ? { CLOUDFLARE_API_TOKEN: config.deployToken, CLOUDFLARE_ACCOUNT_ID: config.accountId } : {}) };
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
function run(file, args, env = environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Command failed with exit code ${code}`)));
  });
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${config.deployToken}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(`Cloudflare operation failed (${response.status}); check the scoped deployment token permissions.`);
  return value.result;
}
await run(resolve('scripts/assets.mjs'), []);
if (values['dry-run']) {
  await run(wrangler, ['deploy', '--dry-run', '--outdir', resolve('build/gateway'), '--minify', '--autoconfig=false']);
  await run(wrangler, ['deploy', '--dry-run', '--config', resolve('wrangler.assets.jsonc'),
    '--outdir', resolve('build/assets-gateway'), '--minify', '--autoconfig=false']);
  console.log('Gateway bundle validated locally. No Cloudflare resources were created or changed.');
} else {
  if (!/^[a-f0-9]{32}$/.test(config.accountId ?? '') || !/^[a-f0-9]{32}$/.test(config.zoneId ?? '') ||
      typeof config.deployToken !== 'string' || typeof config.runtimeToken !== 'string') {
    throw new Error('Run npm run configure in your local terminal first.');
  }
  const gateway = normalizeGateway(config.gateway);
  if (new URL(gateway).protocol !== 'https:') throw new Error('A deployed gateway must use HTTPS');
  const hostname = new URL(gateway).hostname;
  if (gateway !== normalizeGateway(release.gateway)) throw new Error('Gateway differs from the installer release configuration. Update release.config.json deliberately before deployment.');
  const zone = await api(`/zones/${config.zoneId}`);
  if (zone.account.id !== config.accountId || zone.name !== config.deviceDomain || !hostname.endsWith(`.${zone.name}`)) {
    throw new Error('Account, zone, device domain and gateway hostname do not match');
  }
  const domains = await api(`/accounts/${config.accountId}/workers/domains`);
  const owned = domains.find(domain => domain.hostname === hostname);
  if (owned && owned.service !== workerName) throw new Error('This hostname belongs to another Worker; it will not be changed');
  if (!owned) {
    const records = await api(`/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (records.length) throw new Error('The requested new hostname already has DNS records; existing services will not be replaced');
  }
  let database;
  if (deployment.gateway !== gateway || deployment.accountId !== config.accountId || deployment.zoneId !== config.zoneId ||
      deployment.databaseName !== workerName) {
    throw new Error('deployment.config.json does not match the canonical release and Cloudflare resources');
  }
  if (deployment.databaseId !== '00000000-0000-0000-0000-000000000000') {
    database = await api(`/accounts/${config.accountId}/d1/database/${deployment.databaseId}`);
    if (database.name !== workerName) throw new Error('Recorded D1 database no longer belongs to Team DevSpace');
  } else {
    if (values.ci && !values.provision) throw new Error('Run the CI provisioning step before deployment so deployment.config.json records the canonical D1 database ID');
    const databases = await api(`/accounts/${config.accountId}/d1/database?name=${workerName}`);
    if (databases.some(db => db.name === workerName)) {
      throw new Error('A same-named D1 database already exists but is not recorded by this checkout. Restore the private deployment/admin backup instead of adopting an unknown database.');
    }
    database = await api(`/accounts/${config.accountId}/d1/database`, 'POST', { name: workerName });
    deployment = { ...deployment, databaseId: database.uuid };
    await atomicJson('deployment.config.json', deployment);
    console.log(`Recorded non-secret D1 database ID in deployment.config.json: ${database.uuid}`);
  }
  if (values.provision) {
    console.log(JSON.stringify({ provisioned: true, gateway, databaseId: database.uuid, paidPlanChanges: false }, null, 2));
    process.exit(0);
  }
  const generated = { ...base, account_id: config.accountId, name: workerName,
    main: resolve('gateway/index.mjs'), workers_dev: false, preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    vars: { ...base.vars, RELEASE_VERSION: release.version, DEVSPACE_VERSION: release.devspaceVersion,
      CF_ACCOUNT_ID: config.accountId, CF_ZONE_ID: config.zoneId,
      DEVICE_DOMAIN: config.deviceDomain, PUBLIC_ORIGIN: gateway },
    d1_databases: [{ binding: 'DB', database_name: workerName, database_id: database.uuid,
      migrations_dir: resolve('migrations') }],
  };
  const generatedFile = join(directory, 'wrangler.generated.json');
  await atomicJson(generatedFile, generated);
  const assetsGenerated = { ...assetsBase, account_id: config.accountId, name: `${workerName}-assets`,
    main: resolve('gateway/assets.mjs'), workers_dev: false, preview_urls: false,
    assets: { ...assetsBase.assets, directory: resolve('assets') },
    routes: [{ pattern: `${hostname}/mcp-app-assets/*`, zone_id: config.zoneId }],
  };
  const assetsGeneratedFile = join(directory, 'wrangler.assets.generated.json');
  await atomicJson(assetsGeneratedFile, assetsGenerated);
  const adminFile = values.ci ? null : join(directory, 'admin.json');
  let admin = values.ci ? { gateway, adminToken: process.env.ADMIN_TOKEN, masterKey: process.env.MASTER_KEY }
    : await readJson(adminFile, null);
  if (admin && admin.gateway !== gateway) throw new Error('Existing administrator state belongs to a different gateway');
  if (!admin) { admin = { gateway, adminToken: randomSecret(), masterKey: randomSecret() }; await atomicJson(adminFile, admin); }
  if (![admin.adminToken, admin.masterKey, config.runtimeToken].every(value => typeof value === 'string' && value.length >= 32)) {
    throw new Error('ADMIN_TOKEN, MASTER_KEY and CF_RUNTIME_API_TOKEN must come from the protected CI environment');
  }
  const secretsFile = join(directory, 'worker-secrets.json');
  await atomicJson(secretsFile, { ADMIN_TOKEN: admin.adminToken, MASTER_KEY: admin.masterKey, CF_API_TOKEN: config.runtimeToken });
  try {
    await run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', generatedFile]);
    await run(wrangler, ['deploy', '--config', generatedFile, '--secrets-file', secretsFile, '--minify', '--autoconfig=false']);
    await run(wrangler, ['deploy', '--config', assetsGeneratedFile, '--minify', '--autoconfig=false']);
  } finally { await rm(secretsFile, { force: true }); }
  let result;
  const healthDeadline = Date.now() + 90000;
  do {
    try {
      const health = await fetch(`${gateway}/health`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (health.ok) {
        const candidate = await health.json();
        if (candidate.service === 'team-devspace' && candidate.devspace === '1.0.8') { result = candidate; break; }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < healthDeadline);
  if (!result) throw new Error('Deployment finished but the dedicated public HTTPS health check did not become ready within 90 seconds');
  console.log(JSON.stringify({ deployed: true, gateway, databaseId: database.uuid,
    administratorConfig: adminFile ?? 'protected CI environment', paidPlanChanges: false }, null, 2));
}
