import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureStateDirectory } from '../client/state.mjs';
import { validateCatalog } from '../client/release-catalog.mjs';
import { updateSigningBytes, verifySignedCatalog } from '../client/update-policy.mjs';
import release from './release-profile.mjs';

// Private signing material never enters the checkout, download host, Gateway or CI.
export const defaultSigningKey = join(homedir(), '.team-devspace-admin', 'update-signing', 'release-key.pem');

export async function signUpdateCatalog(catalog, { keyFile = process.env.TEAM_DEVSPACE_UPDATE_SIGNING_KEY ?? defaultSigningKey,
  publicKey = release.distribution.updatePublicKey } = {}) {
  validateCatalog(catalog);
  const key = createPrivateKey(await readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ format: 'jwk' }).x !== publicKey) {
    throw new Error('The release signing key does not match the client-embedded public key');
  }
  const payload = Buffer.from(JSON.stringify(catalog)).toString('base64url');
  const envelope = { schema: 1, payload, signature: sign(null, updateSigningBytes(payload), key).toString('base64url') };
  await verifySignedCatalog(envelope, publicKey, catalog.version);
  return envelope;
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--initialize') throw new Error('Use node scripts/sign-updates.mjs --initialize only for the first signing-key setup');
  await secureStateDirectory(dirname(defaultSigningKey));
  let key;
  try { key = createPrivateKey(await readFile(defaultSigningKey)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = generateKeyPairSync('ed25519').privateKey;
    await writeFile(defaultSigningKey, key.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  }
  const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
  if (release.distribution.updatePublicKey && release.distribution.updatePublicKey !== publicKey) {
    throw new Error('An existing client key is different; use an explicit key-rotation release, not replacement');
  }
  console.log(JSON.stringify({ publicKey, privateKeyStoredOutsideRepository: true, algorithm: 'Ed25519' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
