import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { loadState, stateHome, atomicJson, approvedProjectRoot } from '../client/state.mjs';

const { values } = parseArgs({ options: { home: { type: 'string' }, root: { type: 'string' } } });
const home = values.home ?? stateHome();
const state = await loadState(home);
if (!state.bindingId) throw new Error('Complete Enrollment first');
const root = await approvedProjectRoot(values.root ?? state.currentProjectRoot);
const sameRoot = process.platform === 'win32'
  ? root.toLowerCase() === state.currentProjectRoot.toLowerCase()
  : root === state.currentProjectRoot;
if (!sameRoot) throw new Error('Use the Device\'s configured Current Project Root');
const marker = randomUUID();
const fixtureName = `.team-devspace-acceptance-${marker}`;
const directory = join(root, fixtureName);
await mkdir(directory);
await writeFile(join(directory, 'marker.txt'), marker, { flag: 'wx' });
const outsideDirectory = await realpath(await mkdtemp(join(tmpdir(), 'team-devspace-outside-')));
const part = relative(state.currentProjectRoot, outsideDirectory);
const insideRoot = part === '' || (!part.startsWith('..') && !isAbsolute(part));
if (insideRoot) throw new Error('Temporary directory is inside the Current Project Root; choose a narrower project directory before preparing the boundary acceptance fixture');
const outsideMarker = randomUUID();
const outsidePath = join(outsideDirectory, 'outside-marker.txt');
await writeFile(outsidePath, outsideMarker, { flag: 'wx', mode: 0o600 });
const file = join(home, 'acceptance-device.json');
await atomicJson(file, { gateway: state.gateway, accessKey: state.accessKey, keyId: state.keyId,
  deviceId: state.deviceId, bindingId: state.bindingId, platform: process.platform,
  architecture: process.arch, root, markerPath: `${fixtureName}/marker.txt`, expectedMarker: marker, outsidePath, outsideMarker,
  releaseVersion: state.releaseVersion, devspaceVersion: state.devspaceVersion });
console.log(JSON.stringify({ credentialFile: file, temporaryFixture: directory, outsideFixture: outsideDirectory,
  note: 'Keep the credential file private. Remove the temporary fixture directory after acceptance; it contains only a random marker.' }, null, 2));
