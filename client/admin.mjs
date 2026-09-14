#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { atomicJson, normalizeGateway, randomSecret, readJson, secureStateDirectory } from './state.mjs';
import { control } from './http.mjs';

export async function administrator(configPath) {
  const configured = configPath ?? process.env.TEAM_DEVSPACE_ADMIN_CONFIG;
  const projectDefault = resolve(fileURLToPath(new URL('..', import.meta.url)), '.runtime', 'admin.json');
  const candidates = configured
    ? [resolve(configured)]
    : [projectDefault, join(homedir(), '.team-devspace-admin', 'config.json')];
  for (const path of candidates) {
    const config = await readJson(path, null);
    if (!config) continue;
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.adminToken ?? '')) throw new Error('Invalid administrator credential file');
    return { ...config, gateway: normalizeGateway(config.gateway), directory: dirname(path) };
  }
  throw new Error(`Administrator configuration not found. Deploy locally once or provide --config/TEAM_DEVSPACE_ADMIN_CONFIG.`);
}

export async function createAccessKey(config, label, output) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100 || /[\x00-\x1f]/.test(label)) throw new Error('Provide a nonempty employee label (up to 100 characters)');
  label = label.trim();
  const directory = join(config.directory, 'issued-keys');
  await secureStateDirectory(directory);
  const file = join(directory, `${createHash('sha256').update(label).digest('hex')}.json`);
  const freshRecord = () => ({ schema: 2, id: randomUUID(), label,
    accessKey: `tds_${randomSecret()}`, gateway: config.gateway, confirmed: false });
  const issue = value => control(config.gateway, '/v1/admin/keys', config.adminToken, {
    body: { id: value.id, label, keyHash: createHash('sha256').update(value.accessKey).digest('hex') },
  });
  let record = await readJson(file, null);
  if (record && (record.gateway !== config.gateway || record.label !== label)) throw new Error('Existing issuance belongs to another gateway');
  if (!record) {
    record = freshRecord();
    // Save before POST: a timeout can be retried without creating an inaccessible orphan key.
    const created = await atomicJson(file, record, { createOnly: true });
    if (!created) record = await readJson(file);
    if (record.gateway !== config.gateway || record.label !== label) throw new Error('Concurrent issuance belongs to another gateway');
  } else if (record.schema !== 2 || record.confirmed === true) {
    // Confirm that a previously issued local credential still exists remotely.
    // If the server row was intentionally deleted after revoke+cleanup, never
    // recreate it from the old bearer secret: rotate the local issuance first.
    const listed = await control(config.gateway, '/v1/admin/keys', config.adminToken, { method: 'GET' });
    const byId = listed.keys.find(item => item.id === record.id);
    const byLabel = listed.keys.find(item => item.label === label);
    if (byId) {
      if (byId.label !== label) throw new Error('Existing issuance no longer matches its employee label');
      if (byId.state === 'revoked') throw new Error('This label belongs to a revoked key; delete its revoked history before reusing the label');
    } else if (byLabel) {
      throw new Error('This employee label already belongs to another Access Key');
    } else {
      record = freshRecord();
      await atomicJson(file, record);
    }
  }
  let row;
  try { row = await issue(record); }
  catch (error) {
    // A response may have been lost after a successful create. The server-side
    // deletion tombstone is authoritative: only that explicit conflict permits
    // rotating the persisted candidate and retrying once with a fresh secret.
    if (error.code !== 'deleted_key_id_cannot_be_reused') throw error;
    record = freshRecord();
    await atomicJson(file, record);
    row = await issue(record);
  }
  if (row.state === 'revoked') throw new Error('This label belongs to a revoked key; use a new employee/device label');
  if (record.schema !== 2 || record.confirmed !== true) {
    record = { ...record, schema: 2, confirmed: true };
    await atomicJson(file, record);
  }
  const credential = { id: record.id, label, accessKey: record.accessKey, gateway: record.gateway };
  if (output) {
    const target = isAbsolute(output) ? resolve(output) : resolve(config.directory, output);
    const rel = relative(resolve(config.directory), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Credential exports must stay inside the private administrator configuration directory');
    }
    await atomicJson(target, { ...credential, endpoint: `${config.gateway}/mcp` });
    return { id: record.id, label, credentialFile: target, state: row.state };
  }
  return { ...credential, endpoint: `${config.gateway}/mcp`, state: row.state };
}

export async function adminMain(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [group, action, argument] = positionals;
  if (values.help || !group) {
    console.log('Team DevSpace administrator\n  key create <employee-label> [--output private-file.json]\n  key list\n  key revoke <id-or-label>\n  device reset <id-or-label>\n  update-policy show\n  update-policy set <policy.json>\n  --config <private-admin-config.json>  Optional override\n\nUses the project .runtime/admin.json by default, with the per-user administrator config as a fallback. Never give administrator credentials to employees. Access Key is a bearer credential.');
    return;
  }
  const config = await administrator(values.config);
  let result;
  if (group === 'update-policy' && action === 'show') result = await control(config.gateway, '/v1/admin/update-policy', config.adminToken, { method: 'GET' });
  else if (group === 'update-policy' && action === 'set' && argument) result = await control(config.gateway, '/v1/admin/update-policy', config.adminToken, { body: await readJson(resolve(argument)) });
  else if (group === 'key' && action === 'create') result = await createAccessKey(config, argument, values.output);
  else {
    const listed = await control(config.gateway, '/v1/admin/keys', config.adminToken, { method: 'GET' });
    if (group === 'key' && action === 'list') result = listed;
    else if ((group === 'key' && action === 'revoke') || (group === 'device' && action === 'reset')) {
      const key = listed.keys.find(item => item.id === argument || item.label === argument);
      if (!key) throw new Error('No Access Key has that id or employee label');
      result = await control(config.gateway, `/v1/admin/keys/${key.id}/${action}`, config.adminToken, { body: {} });
    } else throw new Error('Unknown administrator command; run with --help');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  adminMain().catch(error => { console.error(`Team DevSpace administrator: ${error.message}`); process.exitCode = 1; });
}
