const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoded secret');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function encryptionKey(secret) {
  const raw = decode64(secret);
  if (raw.length !== 32) throw new Error('MASTER_KEY must encode 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Bind each ciphertext to its enrollment, so swapping database rows cannot swap credentials.
export async function seal(value, secret, bindingId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(bindingId) },
    await encryptionKey(secret), encoder.encode(value),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(cipher))}`;
}

export async function unseal(value, secret, bindingId) {
  const [iv, cipher, extra] = String(value).split('.');
  if (!iv || !cipher || extra) throw new Error('Invalid encrypted credential');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode64(iv), additionalData: encoder.encode(bindingId) },
    await encryptionKey(secret), decode64(cipher),
  );
  return decoder.decode(plain);
}
