import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRustNotices } from '../scripts/native-notices.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'tds-native-notices-'));
  try {
    const crate = join(root, 'crate');
    await mkdir(crate);
    const item = { id: 'demo', name: 'demo', version: '1.0.0', source: 'registry+example',
      license: 'MIT', license_file: null, manifest_path: join(crate, 'Cargo.toml') };
    const metadata = { packages: [item, { ...item, id: 'own', source: null }], resolve: { nodes: [{ id: 'demo' }, { id: 'own' }] } };
    await run({ root, crate, item, metadata, destination: join(root, 'notices') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('native notices retain exact upstream text and exclude private Cargo paths', () => fixture(async ({ crate, metadata, destination }) => {
  await writeFile(join(crate, 'LICENSE-MIT'), 'Exact upstream license\r\n');
  await writeFile(join(crate, 'NOTICE'), 'Upstream copyright\n');
  const inventory = await collectRustNotices(metadata, destination);
  assert.equal(inventory.length, 1);
  assert.equal(await readFile(join(destination, 'demo-1.0.0', 'LICENSE-MIT'), 'utf8'), 'Exact upstream license\r\n');
  const index = await readFile(join(destination, 'index.json'), 'utf8');
  assert.ok(!index.includes(crate));
  assert.deepEqual(inventory[0].files, ['LICENSE-MIT', 'NOTICE']);
}));

test('a license expression alone cannot pass native redistribution notice collection', () => fixture(async ({ metadata, destination }) => {
  await assert.rejects(collectRustNotices(metadata, destination), /No original license/);
}));

test('declared license files cannot escape their Cargo package', () => fixture(async ({ root, item, metadata, destination }) => {
  await writeFile(join(root, 'outside'), 'Must not be packaged');
  item.license_file = '../outside';
  await assert.rejects(collectRustNotices(metadata, destination), /escapes/);
}));

test('upstream declared and license-directory notices are retained', () => fixture(async ({ crate, item, metadata, destination }) => {
  await mkdir(join(crate, 'licenses'));
  await writeFile(join(crate, 'licenses', 'third-party.txt'), 'Dependency notice');
  await writeFile(join(crate, 'terms.txt'), 'Original declared terms');
  item.license_file = 'terms.txt';
  const [inventory] = await collectRustNotices(metadata, destination);
  assert.deepEqual(inventory.files, ['licenses/third-party.txt', 'terms.txt']);
}));
