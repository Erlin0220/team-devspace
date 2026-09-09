import { readFile, readdir, rm } from 'node:fs/promises';
import { run as runCommand, sha256File } from './build-utils.mjs';
import { restoreDeployment, waitForReadiness } from './deploy-checks.mjs';
import { resolve, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { atomicJson, normalizeGateway, randomSecret, readJson, secureStateDirectory } from '../client/state.mjs';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, ci: { type: 'boolean' }, provision: { type: 'boolean' }, config: { type: 'string' } } });
const directory = values.ci ? resolve(process.env.RUNNER_TEMP ?? 'build/deploy-ci') : resolve('.runtime');
await secureStateDirectory(directory);
const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const release = await readJson('release.config.json');
let deployment = await readJson('deployment.config.json');
const credentials = values['dry-run'] ? null : values.ci ? {
  deployToken: process.env.CLOUDFLARE_API_TOKEN,
  runtimeToken: process.env.CF_RUNTIME_API_TOKEN,
} : await readJson(values.config ?? join(directory, 'cloudflare.json'));
const config = credentials && { ...credentials, accountId: release.cloudflare.accountId,
  zoneId: release.cloudflare.zoneId, deviceDomain: release.cloudflare.deviceDomain, gateway: release.gateway };
const workerName = base.name;
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true',
  ...(config ? { CLOUDFLARE_API_TOKEN: config.deployToken, CLOUDFLARE_ACCOUNT_ID: config.accountId } : {}) };
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const run = (file, args) => runCommand(process.execPath, [file, ...args], { env: environment });
async function api(path, method = 'GET', body, { missingOk = false, token = config.deployToken } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (missingOk && response.status === 404) return null;
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(`Cloudflare operation failed (${response.status}); check the scoped deployment token permissions.`);
  return value.result;
}
await run(resolve('scripts/assets.mjs'), []);
if (values['dry-run']) {
  await run(wrangler, ['deploy', '--dry-run', '--outdir', resolve('build/gateway'), '--minify', '--autoconfig=false']);
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
  let workersSubdomain = await api(`/accounts/${config.accountId}/workers/subdomain`, 'GET', undefined, { missingOk: true });
  if (!workersSubdomain?.subdomain) {
    workersSubdomain = await api(`/accounts/${config.accountId}/workers/subdomain`, 'PUT', {
      subdomain: `tds-${config.accountId}`,
    });
    console.log(`Configured account Workers subdomain prerequisite: ${workersSubdomain.subdomain}.workers.dev`);
  }
  const domains = await api(`/accounts/${config.accountId}/workers/domains`);
  const owned = domains.find(domain => domain.hostname === hostname);
  if (owned && owned.service !== workerName) throw new Error('This hostname belongs to another Worker; it will not be changed');
  if (!owned) {
    const records = await api(`/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (records.length) throw new Error('The requested new hostname already has DNS records; existing services will not be replaced');
  }
  let database;
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
    deployment = { databaseId: database.uuid };
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
    assets: { ...base.assets, directory: resolve('assets') },
    vars: { ...base.vars, RELEASE_VERSION: release.version, DEVSPACE_VERSION: release.devspaceVersion,
      CF_ACCOUNT_ID: config.accountId, CF_ZONE_ID: config.zoneId,
      DEVICE_DOMAIN: config.deviceDomain, PUBLIC_ORIGIN: gateway },
    d1_databases: [{ binding: 'DB', database_name: workerName, database_id: database.uuid,
      migrations_dir: resolve('migrations') }],
  };
  const generatedFile = join(directory, 'wrangler.generated.json');
  await atomicJson(generatedFile, generated);
  const adminFile = values.ci ? null : join(directory, 'admin.json');
  let admin = values.ci ? { gateway, adminToken: process.env.ADMIN_TOKEN, masterKey: process.env.MASTER_KEY }
    : await readJson(adminFile, null);
  if (admin && admin.gateway !== gateway) throw new Error('Existing administrator state belongs to a different gateway');
  if (!admin) { admin = { gateway, adminToken: randomSecret(), masterKey: randomSecret() }; await atomicJson(adminFile, admin); }
  if (![admin.adminToken, admin.masterKey, config.runtimeToken].every(value => typeof value === 'string' && value.length >= 32)) {
    throw new Error('ADMIN_TOKEN, MASTER_KEY and CF_RUNTIME_API_TOKEN must come from the protected CI environment');
  }
  // Read-only scope preflight catches expired/wrong-account runtime tokens. It
  // does not pretend to prove edit permissions: real enrollment remains an E2E gate.
  await api(`/accounts/${config.accountId}/cfd_tunnel?is_deleted=false&per_page=1`, 'GET', undefined, { token: config.runtimeToken });
  await api(`/zones/${config.zoneId}/dns_records?per_page=1`, 'GET', undefined, { token: config.runtimeToken });
  const deploymentsPath = `/accounts/${config.accountId}/workers/scripts/${workerName}/deployments`;
  const snapshot = await api(deploymentsPath, 'GET', undefined, { missingOk: true });
  const previousVersions = snapshot?.deployments?.[0]?.versions ?? null;
  if (owned && !previousVersions?.length) throw new Error('Cannot record the existing Worker deployment for recovery; refusing to deploy');
  const routesPath = `/zones/${config.zoneId}/workers/routes`;
  const routes = await api(routesPath);
  const oldPattern = `${hostname}/mcp-app-assets/*`;
  const oldRoutes = routes.filter(route => route.pattern === oldPattern);
  if (oldRoutes.some(route => route.script !== `${workerName}-assets`)) {
    throw new Error('The asset route belongs to another Worker; it will not be changed');
  }
  // This contains resource identifiers only, never secrets or employee data.
  await atomicJson(join(directory, 'deployment-recovery.json'), { workerName, previousVersions, oldRoutes });
  const assetName = (await readdir('assets/mcp-app-assets', { recursive: true })).filter(name => name.endsWith('.js')).sort()[0];
  if (!assetName) throw new Error('Upstream static assets are missing');
  const asset = { path: `/mcp-app-assets/${assetName.split(sep).join('/')}`,
    sha256: await sha256File(join('assets/mcp-app-assets', assetName)) };
  const probes = { gateway, release, adminToken: admin.adminToken };
  let uploadAttempted = false;
  let readiness;
  const secretsFile = join(directory, 'worker-secrets.json');
  await atomicJson(secretsFile, { ADMIN_TOKEN: admin.adminToken, MASTER_KEY: admin.masterKey, CF_API_TOKEN: config.runtimeToken });
  try {
    // Migrations must remain backward compatible with the previous release.
    // Worker version recovery cannot undo D1 schema/data changes.
    await run(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', generatedFile]);
    uploadAttempted = true;
    await run(wrangler, ['deploy', '--config', generatedFile, '--secrets-file', secretsFile, '--minify', '--autoconfig=false']);
    await waitForReadiness(probes);
    for (const route of oldRoutes) {
      await api(`${routesPath}/${route.id}`, 'DELETE');
    }
    readiness = await waitForReadiness({ ...probes, asset });
  } catch (error) {
    const recoveryFailures = await restoreDeployment({ api, deploymentsPath, routesPath, oldRoutes,
      previousVersions, uploadAttempted });
    console.error(JSON.stringify({ deployed: false, recoveryAttempted: uploadAttempted && Boolean(previousVersions?.length),
      recoveryFailures, d1AutomaticallyRolledBack: false, previousVersions }));
    throw error;
  } finally { await rm(secretsFile, { force: true }); }
  try {
    const remaining = await api(routesPath);
    if (remaining.some(route => route.script === `${workerName}-assets`) ||
        domains.some(domain => domain.service === `${workerName}-assets`)) {
      console.warn('Retired asset Worker still has another route/domain; automatic deletion was skipped.');
    } else {
      await api(`/accounts/${config.accountId}/workers/scripts/${workerName}-assets`, 'DELETE', undefined, { missingOk: true });
    }
  } catch { console.warn('Gateway is healthy; retired asset Worker cleanup will be retried on the next deploy.'); }
  console.log(JSON.stringify({ deployed: true, gateway, databaseId: database.uuid, readiness,
    runtimeTokenReadPreflight: true, administratorConfig: adminFile ?? 'protected CI environment',
    paidPlanChanges: false }, null, 2));
}
