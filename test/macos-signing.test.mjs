import test from 'node:test';
import assert from 'node:assert/strict';
import { macosSigningConfiguration } from '../scripts/macos-signing.mjs';

test('macOS signing remains optional but rejects partial protected credentials', () => {
  assert.equal(macosSigningConfiguration({}), null);
  assert.throws(() => macosSigningConfiguration({ MACOS_APPLICATION_IDENTITY: 'Developer ID Application' }),
    /partially configured/);
  const prepared = macosSigningConfiguration({
    TEAM_DEVSPACE_MACOS_APPLICATION_IDENTITY: 'Developer ID Application: Team',
    TEAM_DEVSPACE_MACOS_INSTALLER_IDENTITY: 'Developer ID Installer: Team',
    TEAM_DEVSPACE_MACOS_NOTARY_KEY: '/private/key.p8',
    TEAM_DEVSPACE_MACOS_NOTARY_KEY_ID: 'KEY123',
    TEAM_DEVSPACE_MACOS_NOTARY_ISSUER_ID: 'issuer',
  });
  assert.equal(prepared.installerIdentity, 'Developer ID Installer: Team');
});
