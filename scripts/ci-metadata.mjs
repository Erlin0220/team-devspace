import { appendFile, readFile } from 'node:fs/promises';

const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const metadata = {
  version: release.version,
  node: release.nodeVersion,
  npm: pkg.packageManager,
};
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
}
console.log(JSON.stringify(metadata));
