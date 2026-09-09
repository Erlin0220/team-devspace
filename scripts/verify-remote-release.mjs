import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateDistributionConfig } from './distribution.mjs';
import { sha256File } from './build-utils.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, manifests: { type: 'boolean' }, entrypoints: { type: 'boolean' } } });
const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const distribution = validateDistributionConfig(release);
const root = resolve(values.root ?? join('release', 'offline', release.version));

for (const target of distribution.targets) {
  const directory = join(root, target);
  const manifestPath = join(directory, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.release, release.version);
  assert.equal(manifest.target, target);
  if (values.manifests) {
    const response = await fetch(manifest.sourceBase + 'manifest.json', { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Remote manifest unavailable for ${target}: ${response.status}`);
    const remote = Buffer.from(await response.arrayBuffer());
    if (!remote.equals(manifestBytes)) throw new Error(`Remote immutable manifest differs for ${target}`);
    continue;
  }
  if (values.entrypoints) {
    for (const name of await readdir(directory)) {
      if (name.startsWith('manifest.json') || name === 'objects') continue;
      const localPath = join(directory, name);
      const local = await readFile(localPath);
      const response = await fetch(manifest.sourceBase + name, { redirect: 'error', signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`Remote entrypoint unavailable for ${target}/${name}: ${response.status}`);
      const remote = Buffer.from(await response.arrayBuffer());
      if (!remote.equals(local)) throw new Error(`Remote immutable entrypoint differs for ${target}/${name}`);
      console.log(JSON.stringify({ verified: true, target, entrypoint: name, size: remote.length }));
    }
    continue;
  }
  for (const component of manifest.components) {
    const response = await fetch(new URL(component.path, manifest.sourceBase), { redirect: 'error', signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`Remote artifact unavailable for ${target}/${component.name}: ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length !== component.size) throw new Error(`Remote size differs for ${target}/${component.name}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > component.size) throw new Error(`Remote artifact exceeds manifest size for ${target}/${component.name}`);
      hash.update(chunk);
    }
    if (size !== component.size || hash.digest('hex') !== component.sha256 ||
        await sha256File(join(directory, ...component.path.split('/'))) !== component.sha256) {
      throw new Error(`Remote SHA-256 verification failed for ${target}/${component.name}`);
    }
    console.log(JSON.stringify({ verified: true, target, component: component.name, size }));
  }
}
