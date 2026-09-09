import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './build-utils.mjs';

const SOURCE_NAMES = ['MACOS_SIGNING_P12_BASE64', 'MACOS_SIGNING_P12_PASSWORD',
  'MACOS_APPLICATION_IDENTITY', 'MACOS_INSTALLER_IDENTITY', 'MACOS_NOTARY_KEY_P8_BASE64',
  'MACOS_NOTARY_KEY_ID', 'MACOS_NOTARY_ISSUER_ID'];

export function macosSigningConfiguration(env = process.env) {
  const sourceValues = SOURCE_NAMES.map(name => env[name]);
  if (sourceValues.every(value => !value)) {
    const prepared = ['TEAM_DEVSPACE_MACOS_APPLICATION_IDENTITY', 'TEAM_DEVSPACE_MACOS_INSTALLER_IDENTITY',
      'TEAM_DEVSPACE_MACOS_NOTARY_KEY', 'TEAM_DEVSPACE_MACOS_NOTARY_KEY_ID',
      'TEAM_DEVSPACE_MACOS_NOTARY_ISSUER_ID'].map(name => env[name]);
    if (prepared.every(value => !value)) return null;
    if (prepared.some(value => !value)) throw new Error('Prepared macOS signing configuration is incomplete');
    return { applicationIdentity: prepared[0], installerIdentity: prepared[1], notaryKey: prepared[2],
      notaryKeyId: prepared[3], notaryIssuerId: prepared[4] };
  }
  if (sourceValues.some(value => !value)) throw new Error('macOS signing credentials are partially configured; provide all fields or none');
  return { source: true };
}

function safeIdentity(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\x00]/.test(value)) throw new Error(`Invalid ${name}`);
  return value.trim();
}

export async function prepareMacosSigning(env = process.env) {
  const config = macosSigningConfiguration(env);
  if (!config) return { configured: false };
  if (process.platform !== 'darwin' || !config.source) throw new Error('Prepare macOS signing only on a macOS CI runner');
  if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is required for protected CI signing setup');
  const directory = await mkdtemp(join(resolve(env.RUNNER_TEMP ?? tmpdir()), 'tds-macos-signing-'));
  const p12 = join(directory, 'signing.p12');
  const notaryKey = join(directory, 'AuthKey.p8');
  const keychain = join(directory, 'signing.keychain-db');
  const keychainPassword = randomBytes(32).toString('base64url');
  await writeFile(p12, Buffer.from(env.MACOS_SIGNING_P12_BASE64, 'base64'), { mode: 0o600 });
  await writeFile(notaryKey, Buffer.from(env.MACOS_NOTARY_KEY_P8_BASE64, 'base64'), { mode: 0o600 });
  await run('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain]);
  await run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
  await run('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain]);
  await run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', env.MACOS_SIGNING_P12_PASSWORD,
    '-T', '/usr/bin/codesign', '-T', '/usr/bin/security', '-T', '/usr/bin/pkgbuild']);
  await run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
    '-s', '-k', keychainPassword, keychain]);
  const existing = await run('/usr/bin/security', ['list-keychains', '-d', 'user'], { capture: true });
  const keychains = [...existing.stdout.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...keychains]);
  const lines = {
    TEAM_DEVSPACE_MACOS_SIGNING: '1', TEAM_DEVSPACE_MACOS_KEYCHAIN: keychain,
    TEAM_DEVSPACE_MACOS_SIGNING_DIRECTORY: directory,
    TEAM_DEVSPACE_MACOS_ORIGINAL_KEYCHAINS: Buffer.from(JSON.stringify(keychains)).toString('base64url'),
    TEAM_DEVSPACE_MACOS_APPLICATION_IDENTITY: safeIdentity(env.MACOS_APPLICATION_IDENTITY, 'application identity'),
    TEAM_DEVSPACE_MACOS_INSTALLER_IDENTITY: safeIdentity(env.MACOS_INSTALLER_IDENTITY, 'installer identity'),
    TEAM_DEVSPACE_MACOS_NOTARY_KEY: notaryKey,
    TEAM_DEVSPACE_MACOS_NOTARY_KEY_ID: safeIdentity(env.MACOS_NOTARY_KEY_ID, 'notary key ID'),
    TEAM_DEVSPACE_MACOS_NOTARY_ISSUER_ID: safeIdentity(env.MACOS_NOTARY_ISSUER_ID, 'notary issuer ID'),
  };
  await appendFile(env.GITHUB_ENV, Object.entries(lines).map(([name, value]) => `${name}=${value}\n`).join(''));
  return { configured: true };
}

export async function signMacApplication(path, config = macosSigningConfiguration()) {
  if (!config) return false;
  await run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign',
    config.applicationIdentity, path], { timeout: 300000 });
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path], { timeout: 120000 });
  return true;
}

export async function notarizeMacPackage(path, config = macosSigningConfiguration()) {
  if (!config) return false;
  await run('/usr/bin/xcrun', ['notarytool', 'submit', path, '--key', config.notaryKey,
    '--key-id', config.notaryKeyId, '--issuer', config.notaryIssuerId, '--wait'], { timeout: 1800000 });
  await run('/usr/bin/xcrun', ['stapler', 'staple', path], { timeout: 300000 });
  await run('/usr/sbin/pkgutil', ['--check-signature', path]);
  await run('/usr/bin/xcrun', ['stapler', 'validate', path]);
  return true;
}

export async function cleanupMacosSigning(env = process.env) {
  if (process.platform !== 'darwin') return;
  if (env.TEAM_DEVSPACE_MACOS_ORIGINAL_KEYCHAINS) {
    try {
      const keychains = JSON.parse(Buffer.from(env.TEAM_DEVSPACE_MACOS_ORIGINAL_KEYCHAINS, 'base64url').toString());
      if (Array.isArray(keychains) && keychains.length && keychains.every(value => typeof value === 'string')) {
        await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...keychains]);
      }
    } catch {}
  }
  if (env.TEAM_DEVSPACE_MACOS_KEYCHAIN) {
    await run('/usr/bin/security', ['delete-keychain', env.TEAM_DEVSPACE_MACOS_KEYCHAIN]).catch(() => {});
  }
  if (env.TEAM_DEVSPACE_MACOS_SIGNING_DIRECTORY) {
    await rm(env.TEAM_DEVSPACE_MACOS_SIGNING_DIRECTORY, { recursive: true, force: true });
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/macos-signing.mjs')) {
  const action = process.argv[2];
  if (action === 'prepare') console.log(JSON.stringify(await prepareMacosSigning()));
  else if (action === 'cleanup') await cleanupMacosSigning();
  else throw new Error('Use macos-signing.mjs prepare or cleanup');
}
