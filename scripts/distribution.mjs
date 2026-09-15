import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { run, sha256File } from './build-utils.mjs';
import { httpsOrigin } from './download-catalog.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const TARGET = /^(win32|darwin|linux)-(x64|arm64)$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function validateDistributionConfig(release) {
  const distribution = release?.distribution;
  if (!distribution || distribution.mode !== 'static-https') {
    throw new Error('release.config.json distribution.mode must be static-https');
  }
  httpsOrigin(distribution.origin);
  if (distribution.trustProfile !== 'internal-free') {
    throw new Error('release.config.json distribution.trustProfile must be internal-free');
  }
  if (!Array.isArray(distribution.targets) || distribution.targets.length === 0 ||
      distribution.targets.some(target => !TARGET.test(target)) || new Set(distribution.targets).size !== distribution.targets.length) {
    throw new Error('release.config.json distribution.targets must contain unique supported OS/architecture targets');
  }
  if (distribution.targets.some(target => target.startsWith('darwin-')) &&
      !/^\d+\.\d+$/.test(distribution.macosMinimumVersion ?? '')) {
    throw new Error('release.config.json distribution.macosMinimumVersion must be an explicit macOS major.minor baseline');
  }
  if (distribution.targets.some(target => target.startsWith('darwin-')) &&
      (!/^[a-f0-9]{40}$/.test(release.cloudflaredSourceCommit ?? '') || !/^\d+\.\d+\.\d+$/.test(release.cloudflaredGoVersion ?? ''))) {
    throw new Error('macOS cloudflared source builds require an immutable upstream commit and explicit Go version');
  }
  if (!VERSION.test(release.version ?? '')) throw new Error('Release version must be explicit semver, never latest');
  return distribution;
}

async function componentArchive({ name, version, bundle, paths, tar, staging, layout, required = true, condition, exclude = [] }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error(`Component ${name} has no payload paths`);
  const temporary = join(staging, `${name}.tar.gz`);
  await rm(temporary, { force: true });
  // Windows/macOS bsdtar embeds wall-clock time in the gzip header by default.
  // Disable that metadata; GNU tar pipes to gzip and already omits it.
  const options = process.platform === 'linux' ? [] : ['--options', 'gzip:!timestamp'];
  const exclusions = exclude.flatMap(pattern => ['--exclude', pattern]);
  await run(tar, [...options, ...exclusions, '-czf', temporary, '-C', bundle, ...paths], { timeout: 600000 });
  return componentArtifact({ name, version, archive: temporary, layout, required, condition });
}

async function componentArtifact({ name, version, archive, layout, required = true, condition, format = 'tar.gz' }) {
  const sha256 = await sha256File(archive);
  if (!SHA256.test(sha256)) throw new Error(`Component ${name} did not produce a SHA-256 digest`);
  const size = (await stat(archive)).size;
  const filename = `${name}.${format === '7z-sfx' ? '7z.exe' : 'tar.gz'}`;
  const relativePath = `objects/sha256/${sha256}/${filename}`;
  const destination = join(layout, ...relativePath.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await cp(archive, destination);
  return {
    name, version, required, ...(condition ? { condition } : {}),
    format, path: relativePath, sha256, size,
  };
}

export async function buildReleaseLayout({ bundle, target, release, tar, outputDirectory = 'release', gitFallbackArchive }) {
  if (!TARGET.test(target)) throw new Error(`Unsupported release target: ${target}`);
  const distribution = validateDistributionConfig(release);
  if (!distribution.targets.includes(target)) throw new Error(`Target ${target} is not enabled in release.config.json`);
  const root = resolve(outputDirectory);
  const layout = join(root, 'offline', release.version, target);
  const staging = join(layout, '.staging');
  await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(layout, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await mkdir(staging, { recursive: true });
  await mkdir(layout, { recursive: true });

  try {
  const appPaths = [
    'client', 'platform', 'package.json', 'release.config.json', 'README.md',
    'sbom.cdx.json', 'THIRD-PARTY-NOTICES.txt', 'release-provenance.json', 'LICENSE', 'NOTICE', 'LICENSES',
    ...(target === 'win32-x64' ? ['bin/team-devspace.cmd'] : []),
  ];
  const cloudflaredPath = target === 'win32-x64' ? 'bin/cloudflared.exe' : 'bin/cloudflared';
  // Source maps and TypeScript declarations are development metadata, not employee runtime inputs.
  // Exclude them consistently on every platform to reduce archive work and final offline package size.
  const runtimeExcludes = ['*.map', '*.d.ts', '*.d.mts', '*.d.cts'];
  const components = [
    await componentArchive({ name: 'app', version: release.version, bundle, paths: appPaths, tar, staging, layout }),
    await componentArchive({ name: 'devspace-runtime', version: release.devspaceVersion, bundle,
      paths: ['node_modules'], tar, staging, layout, exclude: runtimeExcludes }),
    await componentArchive({ name: 'node', version: release.nodeVersion, bundle, paths: ['runtime'], tar, staging, layout }),
    await componentArchive({ name: 'cloudflared', version: release.cloudflaredVersion, bundle,
      paths: [cloudflaredPath], tar, staging, layout }),
  ];
  if (target === 'win32-x64') {
    if (!gitFallbackArchive) throw new Error('Windows requires the pinned official PortableGit self-extractor');
    components.push(await componentArtifact({ name: 'git-fallback', version: release.gitFallbackVersion,
      archive: gitFallbackArchive, layout, format: '7z-sfx', required: false, condition: 'git-unavailable' }));
  }

  const manifest = {
    schema: 1,
    trust: 'bootstrap-embedded-manifest',
    release: release.version,
    target,
    installMode: 'offline',
    runtime: {
      devspaceVersion: release.devspaceVersion,
      nodeVersion: release.nodeVersion,
      cloudflaredVersion: release.cloudflaredVersion,
      ...(target === 'win32-x64' ? { gitFallbackVersion: release.gitFallbackVersion } : {}),
    },
    components,
  };
  const manifestPath = join(layout, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = await sha256File(manifestPath);
  await writeFile(join(layout, 'manifest.json.sha256'), `${manifestSha256}  manifest.json\n`);
  return { layout, manifest, manifestPath, manifestSha256, components };
  } finally { await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
