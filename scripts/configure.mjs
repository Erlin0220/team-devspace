import * as prompts from '@clack/prompts';
import { join, resolve } from 'node:path';
import { atomicJson, normalizeGateway, readJson, secureStateDirectory } from '../client/state.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Run npm run configure in your own interactive terminal. Never paste Cloudflare tokens into a chat.');
}
const directory = resolve('.runtime');
await secureStateDirectory(directory);
const previous = await readJson(join(directory, 'cloudflare.json'), {});
const release = await readJson('release.config.json');
const answer = async promise => {
  const value = await promise;
  if (prompts.isCancel(value)) { prompts.cancel('No credentials were changed.'); process.exit(1); }
  return value;
};
const id = (message, initialValue) => answer(prompts.text({ message, initialValue,
  validate: value => /^[a-f0-9]{32}$/.test(value ?? '') ? undefined : 'Enter a 32-character Cloudflare ID' }));
const accountId = await id('Cloudflare Account ID', previous.accountId ?? release.cloudflare?.accountId);
const zoneId = await id('Cloudflare Zone ID', previous.zoneId ?? release.cloudflare?.zoneId);
const gateway = normalizeGateway(await answer(prompts.text({ message: 'New Team DevSpace gateway origin',
  initialValue: previous.gateway ?? release.gateway, validate: value => { try { normalizeGateway(value); } catch { return 'Enter a bare HTTPS origin'; } } })));
const deviceDomain = await answer(prompts.text({ message: 'Base DNS zone for device hostnames (not a nested subdomain)',
  initialValue: previous.deviceDomain ?? release.cloudflare?.deviceDomain,
  validate: value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value ?? '') ? undefined : 'Enter the base DNS zone, for example example.com' }));
const token = message => answer(prompts.password({ message,
  validate: value => typeof value === 'string' && value.trim().length >= 32 ? undefined : 'Paste the token into this local protected field' }));
prompts.note('Deployment token: Account Workers Scripts Edit + D1 Edit; Zone DNS Edit + Zone Read.\nRuntime token: Account Cloudflare Tunnel Edit; Zone DNS Edit.\nRestrict both tokens to the selected account and zone. Tokens remain local/Worker secrets, never in installers or Git.');
const deployToken = await token('Deployment API token (masked)');
const runtimeToken = await token('Runtime Tunnel/DNS API token (masked)');
await atomicJson(join(directory, 'cloudflare.json'), { accountId, zoneId, gateway, deviceDomain,
  deployToken: deployToken.trim(), runtimeToken: runtimeToken.trim() });
prompts.outro('Cloudflare credentials saved privately. Next: npm run deploy. No paid plan is enabled by these commands.');
