import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DOWNLOAD_TARGETS, packageName } from '../client/release-catalog.mjs';
import { updateSigningBytes } from '../client/update-policy.mjs';

// Ephemeral test keys ONLY. Synthetic fixtures must never be signed with the real release key.
const keys = generateKeyPairSync('ed25519');
export const updateTestPublicKey = keys.publicKey.export({ format: 'jwk' }).x;
export const updateTestBytes = Buffer.from('synthetic-update-payload-not-an-installer');
export function updateTestCatalog(version = '0.2.5', bytes = updateTestBytes) {
  return { schema: 1, version, commit: 'a'.repeat(40), targets: Object.fromEntries(DOWNLOAD_TARGETS.map(target =>
    [target, { file: packageName(version, target), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) };
}
export async function signUpdateFixture(catalog) {
  const payload = Buffer.from(JSON.stringify(catalog)).toString('base64url');
  return { schema: 1, payload, signature: sign(null, updateSigningBytes(payload), keys.privateKey).toString('base64url') };
}
