import { appendFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from './build-utils.mjs';
import release from './release-profile.mjs';

if (process.platform !== 'darwin') throw new Error('Build cloudflared on a native macOS runner');
const hardware = (await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { capture: true })).stdout.trim();
if ((hardware === '1') !== (process.arch === 'arm64')) throw new Error('Translated macOS builds are not native acceptance');
const actualGo = (await run('go', ['version'], { capture: true })).stdout;
if (!actualGo.includes(`go${release.cloudflaredGoVersion} `)) throw new Error('Go version differs from the release pin');
const source = resolve('build/cloudflared-source');
const output = resolve('build/native/cloudflared');
await rm(source, { recursive: true, force: true });
await mkdir(resolve('build/native'), { recursive: true });
await run('git', ['init', '-q', source]);
await run('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/cloudflare/cloudflared.git']);
await run('git', ['-C', source, 'fetch', '--quiet', '--depth=1', 'origin', release.cloudflaredSourceCommit], { timeout: 180000 });
await run('git', ['-C', source, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
if ((await run('git', ['-C', source, 'rev-parse', 'HEAD'], { capture: true })).stdout.trim() !== release.cloudflaredSourceCommit) {
  throw new Error('cloudflared source identity mismatch');
}
await run('go', ['build', '-mod=vendor', '-trimpath', '-ldflags', `-X main.Version=${release.cloudflaredVersion}`,
  '-o', output, 'github.com/cloudflare/cloudflared/cmd/cloudflared'], {
  cwd: source, timeout: 600000, env: { CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64',
    MACOSX_DEPLOYMENT_TARGET: release.distribution.macosMinimumVersion },
});
if (!(await run(output, ['--version'], { capture: true })).stdout.includes(release.cloudflaredVersion)) throw new Error('cloudflared version mismatch');
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `TEAM_DEVSPACE_CLOUDFLARED_BINARY=${output}\n`);
console.log('Pinned cloudflared built on matching native hardware.');
