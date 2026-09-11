#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { approvedRoots, atomicJson, DEVSPACE_VERSION, loadState, readJson, RELEASE_VERSION,
  stateHome, writeUpstreamConfig } from './state.mjs';
import { configureDevice, deviceStatus, macSetupDialog, repairDevice, requestFromFile } from './setup.mjs';
import { enabledStartupComponents, installServices, serviceAction } from './platform.mjs';
import { runComponent } from './runtime.mjs';
import { diagnosticReport, openLogs, restartTeamDevSpace,
  resumeRemoteAccess, suspendRemoteAccess } from './control.mjs';
import { runTray } from './tray.mjs';
import { withDeviceOperation } from './operation.mjs';

const HELP = `Team DevSpace
  setup --credential-file <file.json> --root <project-directory> [--root <another-directory>]
  setup --request-file <private-installer-request.json>
  setup-gui                         Native macOS first-run setup
  status                            Show local and gateway health (no secrets)
  repair                            Recreate local startup or resume pending Enrollment
  start | stop | restart            Control your user-session runtime
  suspend | resume                  Fail-closed remote access safety switch
  diagnostics                       Print stable redacted diagnostics
  logs [--follow]                   Show Linux journal logs or open the desktop log directory
  roots list | add <path> | remove <path>
  startup install | remove          Manage native user-login startup
  uninstall                         Stop/remove startup; retain Enrollment for repair
  run runtime | tray                Foreground native startup component
  --home <directory>                Isolated local state (advanced)

Use the same Access Key when connecting the Team DevSpace workspace app.
Allowed Roots constrain file tools, not shell commands: shell executes with your user permissions.
`;

export async function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string' }, gateway: { type: 'string' }, root: { type: 'string', multiple: true },
    'credential-file': { type: 'string' }, 'request-file': { type: 'string' },
    'runtime-root': { type: 'string' },
    'no-startup': { type: 'boolean' }, follow: { type: 'boolean' },
    'installer-progress': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.home) process.env.TEAM_DEVSPACE_HOME = resolve(values.home);
  const home = stateHome();
  const [command, action, argument] = positionals;
  if (values.help || !command) { console.log(HELP); return; }
  if (command === 'run') {
    if (action === 'tray') await runTray(home);
    else await runComponent(action, home);
    return;
  }
  const execute = () => executeCommand(command, action, argument, values, home);
  const readOnly = ['status', 'diagnostics', 'logs', 'setup-gui'].includes(command) || (command === 'roots' && action === 'list');
  return readOnly ? execute() : withDeviceOperation(home, execute);
}

async function executeCommand(command, action, argument, values, home) {
  let result;
  if (command === 'setup') {
    const input = values['request-file'] ? await requestFromFile(values['request-file'], true)
      : values['credential-file'] ? await requestFromFile(values['credential-file']) : {};
    if (values.root) input.roots = values.root;
    if (values.gateway) input.gateway = values.gateway;
    result = await configureDevice(input, { home, startup: !values['no-startup'],
      onProgress: values['installer-progress'] ? message => console.log(`[Team DevSpace] ${message}`) : undefined });
  } else if (command === 'setup-gui') result = await macSetupDialog(home);
  else if (command === 'status') result = await deviceStatus(home);
  else if (command === 'repair') result = await repairDevice(home);
  else if (command === 'suspend') result = await suspendRemoteAccess(home);
  else if (command === 'resume') result = await resumeRemoteAccess(home);
  else if (command === 'diagnostics') result = await diagnosticReport(home);
  else if (command === 'logs') {
    const logs = await openLogs(home, { follow: values.follow });
    if (process.platform === 'linux') return;
    result = { logs };
  }
  else {
    const state = await loadState(home);
    if (['start', 'stop', 'restart'].includes(command)) {
      if (command === 'restart') result = await restartTeamDevSpace(home);
      else { await serviceAction(command, state, home); result = { action: command, deviceId: state.deviceId }; }
    } else if (command === 'startup') {
      if (action === 'install') {
        const runtimeRoot = values['runtime-root'] ? await realpath(resolve(values['runtime-root'])) : undefined;
        const runtimeRelease = runtimeRoot ? await readJson(join(runtimeRoot, 'release.config.json')) : undefined;
        if (runtimeRelease && (typeof runtimeRelease.version !== 'string' || typeof runtimeRelease.devspaceVersion !== 'string')) {
          throw new Error('The requested startup runtime has invalid release metadata');
        }
        const startupState = { ...state, releaseVersion: runtimeRelease?.version ?? RELEASE_VERSION,
          devspaceVersion: runtimeRelease?.devspaceVersion ?? DEVSPACE_VERSION };
        await installServices(startupState, home, runtimeRoot);
        await atomicJson(join(home, 'state.json'), startupState);
        const startComponents = enabledStartupComponents(startupState);
        if (startComponents.length) await serviceAction('start', startupState, home, startComponents);
      }
      else if (action === 'remove') await serviceAction('remove', state, home);
      else throw new Error('Use startup install or startup remove');
      result = { startup: action };
    } else if (command === 'uninstall') {
      await serviceAction('remove', state, home);
      result = { startup: 'removed', retainedEnrollment: home,
        note: 'Project files are never deleted. Ask the administrator to revoke this Access Key when retiring the device.' };
    } else if (command === 'roots') {
      if (action === 'list') result = { roots: state.roots };
      else {
        if (!argument) throw new Error('Provide an absolute project directory');
        let roots;
        if (action === 'add') roots = await approvedRoots([...state.roots, argument]);
        else if (action === 'remove') {
          const path = await realpath(argument).catch(() => resolve(argument));
          const same = value => process.platform === 'win32' ? value.toLowerCase() === path.toLowerCase() : value === path;
          roots = state.roots.filter(value => !same(value));
          if (roots.length === state.roots.length) throw new Error('This directory is not an Allowed Root');
          if (roots.length === 0) throw new Error('Add another project directory before removing the last Allowed Root');
        } else throw new Error('Use roots list, roots add, or roots remove');
        await serviceAction('stop', state, home, ['runtime']);
        const next = { ...state, roots };
        await writeUpstreamConfig(next, home);
        await atomicJson(join(home, 'state.json'), next);
        const paused = next.remoteAccess === 'suspended';
        if (!paused) await serviceAction('start', next, home, ['runtime']);
        result = { roots, note: paused ? 'Project directories updated; remote access remains suspended.'
          : 'DevSpace restarted; existing MCP sessions must reconnect.' };
      }
    } else throw new Error('Unknown command; run team-devspace --help');
  }
  if (values['installer-progress']) {
    const message = command === 'setup' ? (result.remoteAccess === 'suspended'
      ? 'Device setup is complete; remote access remains suspended.'
      : 'Device setup is complete; connection starts independently.')
      : command === 'uninstall' ? 'Current-user startup entries were removed.'
      : `${command[0].toUpperCase()}${command.slice(1)} complete.`;
    console.log(`[Team DevSpace] ${message}`);
  } else console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Team DevSpace: ${error.message}`); process.exitCode = 1; });
}
