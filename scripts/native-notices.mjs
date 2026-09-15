import { cp, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Cargo's SBOM license expressions do not replace the notices of statically
// linked crates. Reuse the exact sources Cargo already resolved, without a new
// license service or an unpinned dependency download during packaging.
export async function collectRustNotices(metadata, destination) {
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
  const packages = metadata.packages.filter(item => item.source && resolved.has(item.id));
  const inventory = [];
  for (const item of packages.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.name) || !/^[A-Za-z0-9.+_-]+$/.test(item.version)) {
      throw new Error('Invalid Cargo package identity for notices');
    }
    const root = await realpath(dirname(item.manifest_path));
    const files = new Set();
    const include = async path => {
      const actual = await realpath(path);
      const name = relative(root, actual);
      if (!name || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) {
        throw new Error(`License path escapes Cargo package ${item.name}`);
      }
      files.add(name);
    };
    if (item.license_file) await include(resolve(root, item.license_file));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (/^(?:licen[sc]e|copying|notice|copyright|authors)(?:[._-].*)?$/i.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Unexpected notice entry in Cargo package ${item.name}`);
        await include(join(root, entry.name));
      }
      if (entry.isDirectory() && /^(?:licenses|licences)$/i.test(entry.name)) {
        for (const notice of await readdir(join(root, entry.name), { withFileTypes: true })) {
          if (!notice.isFile()) throw new Error(`Review nested Cargo notices for ${item.name}`);
          await include(join(root, entry.name, notice.name));
        }
      }
    }
    if (!files.size) throw new Error(`No original license notice found for Cargo package ${item.name}@${item.version}`);
    const name = `${item.name}-${item.version}`;
    if (inventory.some(entry => entry.directory === name)) throw new Error(`Ambiguous Cargo notice identity: ${name}`);
    for (const file of [...files].sort()) {
      const output = join(destination, name, file);
      await mkdir(dirname(output), { recursive: true });
      await cp(join(root, file), output);
    }
    inventory.push({ name: item.name, version: item.version, license: item.license,
      directory: name, files: [...files].sort().map(file => file.split(sep).join('/')) });
  }
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'index.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}
