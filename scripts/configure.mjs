import * as prompts from '@clack/prompts';
import { join, resolve } from 'node:path';
import { atomicJson, secureStateDirectory } from '../client/state.mjs';
import release, { requireProductionProfile } from './release-profile.mjs';
import { deploymentConfig } from './private-config.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Run npm run configure in your own interactive terminal. Never paste Cloudflare tokens into a chat.');
}
const directory = resolve('.runtime');
await secureStateDirectory(directory);
requireProductionProfile(release);
const deployment = await deploymentConfig();
if (deployment.zoneId === '0'.repeat(32)) throw new Error('Set a real Zone ID in private operator configuration, not in source');
const answer = async promise => {
  const value = await promise;
  if (prompts.isCancel(value)) { prompts.cancel('No credentials were changed.'); process.exit(1); }
  return value;
};
prompts.note('Deployment target comes from the explicit release profile and private deployment configuration. Cloudflare Account and device domain are resolved from the selected Zone during deploy.');
const token = message => answer(prompts.password({ message,
  validate: value => typeof value === 'string' && value.trim().length >= 32 ? undefined : 'Paste the token into this local protected field' }));
prompts.note('Deployment token: Account Workers Scripts Edit + D1 Edit + Access Apps and Policies Write + Access Organizations/Identity Providers/Groups Read; Zone Workers Routes Edit + DNS Edit + Zone Read + WAF Write.\nRuntime token: Account Cloudflare Tunnel Edit; Zone DNS Edit.\nRestrict both tokens to the selected account and zone. Tokens remain local/Worker secrets, never in installers or Git.');
const deployToken = await token('Deployment API token (masked)');
const runtimeToken = await token('Runtime Tunnel/DNS API token (masked)');
const adminEmails = await answer(prompts.text({ message: 'Cloudflare Access administrator emails (comma separated)',
  validate: value => {
    const emails = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
    return emails.length && emails.every(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      ? undefined : 'Enter one or more valid administrator emails';
  } }));
await atomicJson(join(directory, 'cloudflare.json'), { deployToken: deployToken.trim(), runtimeToken: runtimeToken.trim(),
  adminEmails: adminEmails.split(',').map(email => email.trim().toLowerCase()) });
prompts.outro('Cloudflare credentials saved privately. Next: npm run deploy. No paid plan is enabled by these commands.');
