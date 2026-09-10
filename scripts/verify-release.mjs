import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateDistributionConfig } from './distribution.mjs';
import { sha256File } from './build-utils.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, target: { type: 'string' } } });
const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const distribution = validateDistributionConfig(release);
const root = resolve(values.root ?? join('release', 'offline', release.version));
const targets = values.target ? [values.target] : distribution.targets;
if (targets.some(target => !distribution.targets.includes(target))) throw new Error('Requested release target is not enabled');

for (const target of targets) {
  const directory = join(root, target);
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.trust, 'bootstrap-embedded-manifest');
  assert.equal(manifest.release, release.version);
  assert.equal(manifest.target, target);
  assert.equal(manifest.installMode, 'offline');
  assert.equal('sourceBase' in manifest, false);

  const expectedManifestHash = (await readFile(join(directory, 'manifest.json.sha256'), 'utf8')).trim().split(/\s+/)[0];
  assert.equal(await sha256File(manifestPath), expectedManifestHash);

  for (const component of manifest.components) {
    const artifact = join(directory, ...component.path.split('/'));
    assert.equal((await stat(artifact)).size, component.size, `${target}/${component.name} size differs from manifest`);
    assert.equal(await sha256File(artifact), component.sha256, `${target}/${component.name} SHA-256 differs from manifest`);
  }

  const entries = await readdir(directory);
  const entrypoints = entries.filter(name => name.startsWith('Team-DevSpace-') && !name.endsWith('.sha256'));
  assert.ok(entrypoints.length > 0, `${target} has no administrator handoff entrypoint`);
  for (const name of entrypoints) {
    const checksumPath = join(directory, `${name}.sha256`);
    const expected = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0].toLowerCase();
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(await sha256File(join(directory, name)), expected, `${target}/${name} SHA-256 differs from its checksum file`);
  }
  console.log(JSON.stringify({ verified: true, target, components: manifest.components.length, entrypoints: entrypoints.length }));
}
