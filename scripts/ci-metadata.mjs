import { appendFile, readFile } from 'node:fs/promises';
import { validateDistributionConfig } from './distribution.mjs';

const release = JSON.parse(await readFile('release.config.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const runners = {
  'win32-x64': 'windows-2022', 'darwin-arm64': 'macos-15', 'linux-x64': 'ubuntu-24.04',
};
const metadata = {
  version: release.version,
  node: release.nodeVersion,
  npm: pkg.packageManager,
  cloudflared_version: release.cloudflaredVersion,
  cloudflared_commit: release.cloudflaredSourceCommit,
  cloudflared_go: release.cloudflaredGoVersion,
  matrix: JSON.stringify({ include: validateDistributionConfig(release).targets.map(target => {
    if (!runners[target]) throw new Error(`No native CI runner is configured for ${target}`);
    return { target, runner: runners[target], native_startup: ['win32-x64', 'linux-x64'].includes(target) };
  }) }),
};
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
}
console.log(JSON.stringify(metadata));
