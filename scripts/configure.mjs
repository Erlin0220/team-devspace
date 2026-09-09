import * as prompts from '@clack/prompts';
import { join, resolve } from 'node:path';
import { atomicJson, readJson, secureStateDirectory } from '../client/state.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Run npm run configure in your own interactive terminal. Never paste Cloudflare tokens into a chat.');
}
const directory = resolve('.runtime');
await secureStateDirectory(directory);
const release = await readJson('release.config.json');
const answer = async promise => {
  const value = await promise;
  if (prompts.isCancel(value)) { prompts.cancel('No credentials were changed.'); process.exit(1); }
  return value;
};
prompts.note(`Deployment target comes only from release.config.json:\n${release.gateway}\nAccount: ${release.cloudflare.accountId}\nZone: ${release.cloudflare.zoneId}\nChange that declaration deliberately before moving infrastructure.`);
const token = message => answer(prompts.password({ message,
  validate: value => typeof value === 'string' && value.trim().length >= 32 ? undefined : 'Paste the token into this local protected field' }));
prompts.note('Deployment token: Account Workers Scripts Edit + D1 Edit + Access Apps and Policies Write; Zone Workers Routes Edit + DNS Edit + Zone Read.\nRuntime token: Account Cloudflare Tunnel Edit; Zone DNS Edit.\nRestrict both tokens to the selected account and zone. Tokens remain local/Worker secrets, never in installers or Git.');
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
