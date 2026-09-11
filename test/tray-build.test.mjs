import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../scripts/build-utils.mjs';
import { readTrayArtifactCache } from '../scripts/tray-build.mjs';

test('macOS tray final-artifact cache requires matching fingerprint, metadata and binary hash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'team-devspace-tray-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'TeamDevSpaceTray');
  const metadataPath = join(directory, 'metadata.json');
  const fingerprint = 'a'.repeat(64);
  await writeFile(binary, Buffer.from('verified-native-tray'));
  await chmod(binary, 0o755);
  const sha256 = await sha256File(binary);
  await writeFile(metadataPath, `${JSON.stringify({
    schema: 1,
    fingerprint,
    target: 'darwin-arm64',
    minimumMacOS: '12.0',
    sha256,
    rustVersion: 'rustc 1.85.1 (test)',
    metadata: { packages: [], resolve: { nodes: [] } },
  }, null, 2)}\n`);

  const cached = await readTrayArtifactCache({ binary, metadataPath, fingerprint });
  assert.equal(cached.cached, true);
  assert.equal(cached.sha256, sha256);
  assert.equal(cached.rustVersion, 'rustc 1.85.1 (test)');

  await assert.rejects(
    readTrayArtifactCache({ binary, metadataPath, fingerprint: 'b'.repeat(64) }),
    /metadata differs from the current build contract/,
  );
  await writeFile(binary, Buffer.from('tampered-native-tray'));
  await assert.rejects(
    readTrayArtifactCache({ binary, metadataPath, fingerprint }),
    /binary hash differs from its metadata/,
  );
});
