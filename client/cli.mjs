#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { atomicJson, DEVSPACE_VERSION, loadState, readJson, RELEASE_VERSION, stateHome } from './state.mjs';
import { changeProjectRoot, configureDevice, deviceStatus, macSetupDialog, repairDevice, replaceAccessKey, requestFromFile } from './setup.mjs';
import { interactiveInput } from './interactive-setup.mjs';
import { enabledStartupComponents, installServices, serviceAction } from './platform.mjs';
import { runComponent } from './runtime.mjs';
import { diagnosticReport, openLogs, restartTeamDevSpace,
  resumeRemoteAccess, suspendRemoteAccess } from './control.mjs';
import { runTray } from './tray.mjs';
import { desktopErrorText } from './desktop.mjs';
import { withDeviceOperation } from './operation.mjs';
import { checkForUpdates, applyUpdate, updateStatus, setAutomaticUpdates } from './updates.mjs';

const HELP = `Team DevSpace
  setup                             Enter Access Key privately and choose a project
  access-key change                 Change Access Key without reinstalling
  setup --credential-file <file.json> --root <project-directory>
  setup --request-file <private-installer-request.json>
  setup-gui                         Native macOS first-run setup
  status                            Show local and gateway health (no secrets)
  update check | apply | status     Discover, install or inspect trusted updates
  update repair                    Reinstall this version from its signed package
  update auto on | off              Set automatic approved-version updates
  repair                            Recreate local startup or resume pending Enrollment
  start | stop | restart            Control your user-owned runtime
  suspend | resume                  Fail-closed remote access safety switch
  diagnostics                       Print stable redacted diagnostics
  logs [--follow]                   Show Linux journal/file logs or open desktop logs
  project-root show | set <path>      Show or change this Device's current project
  startup install | remove          Manage native or standalone component startup
  uninstall                         Stop/remove startup; retain Enrollment for repair
  run runtime | tray                Foreground native startup component
  --home <directory>                Isolated local state (advanced)

Use the same Access Key when connecting the Team DevSpace workspace app.
The Current Project Root constrains file tools, not shell commands: shell executes with your user permissions.
Linux without systemctl uses standalone supervision. After host/container recreation,
run repair from the host's startup hook or terminal; standalone is not a boot hook.
`;

export async function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string' }, gateway: { type: 'string' }, root: { type: 'string' },
    'credential-file': { type: 'string' }, 'request-file': { type: 'string' },
    'runtime-root': { type: 'string' },
    'no-startup': { type: 'boolean' }, follow: { type: 'boolean' },
    'installer-progress': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.home) process.env.TEAM_DEVSPACE_HOME = resolve(values.home);
  const home = stateHome();
  const [command, action, argument] = positionals;
  if (values.help || !command) { console.log(HELP); return; }
  if (command === 'start' && process.platform === 'win32' && !(await readJson(join(home, 'state.json'), null))?.bindingId) {
    // An installed, unconfigured app still opens. No device identity or remote
    // service is created until the user submits setup in the existing control UI.
    return runTray(home, { openSettings: true });
  }
  const changingKey = command === 'access-key' && action === 'change';
  if (command === 'access-key' && !changingKey) throw new Error('Use team-devspace access-key change');
  if ((command === 'setup' || changingKey) && !values['credential-file'] && !values['request-file'] && !values['installer-progress']) {
    const previous = await readJson(join(home, 'state.json'), null);
    // Enrolled unattended upgrades retain their existing setup behavior. A new
    // interactive setup/change prompts before acquiring the device transaction lock.
    if (changingKey || !previous?.accessKey || process.stdin.isTTY) {
      values.interactiveInput = await interactiveInput(previous, { root: values.root, changeKey: changingKey });
    }
  }
  if (command === 'update') {
    let result;
    if (action === 'check' || !action) result = await checkForUpdates(home, { force: true });
    else if (action === 'status') result = await updateStatus(home);
    else if (action === 'apply') result = await applyUpdate(home, { onProgress: message => console.error(message) });
    else if (action === 'auto' && ['on', 'off'].includes(argument)) result = await setAutomaticUpdates(argument === 'on', home);
    else if (action === 'repair') result = await applyUpdate(home, { repair: true });
    else throw new Error('Use update check, apply, repair, status, or auto on|off');
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'run') {
    if (action === 'tray') await runTray(home);
    else await runComponent(action, home);
    return;
  }
  const execute = () => executeCommand(command, action, argument, values, home);
  const readOnly = ['status', 'diagnostics', 'logs', 'setup-gui'].includes(command) ||
    (command === 'project-root' && (!action || action === 'show'));
  return readOnly ? execute() : withDeviceOperation(home, execute);
}

async function executeCommand(command, action, argument, values, home) {
  let result;
  if (command === 'setup') {
    const input = values['request-file'] ? await requestFromFile(values['request-file'], true)
      : values['credential-file'] ? await requestFromFile(values['credential-file']) : values.interactiveInput ?? {};
    if (values.root) input.currentProjectRoot = values.root;
    if (values.gateway) input.gateway = values.gateway;
    result = await configureDevice(input, { home, startup: !values['no-startup'],
      onProgress: values['installer-progress'] ? message => console.log(`[Team DevSpace] ${message}`) : undefined });
  } else if (command === 'access-key') {
    const input = values['credential-file'] ? await requestFromFile(values['credential-file'])
      : values['request-file'] ? await requestFromFile(values['request-file'], true) : values.interactiveInput;
    result = await replaceAccessKey(input?.accessKey, home, { startup: !values['no-startup'], onProgress: message => console.log(message) });
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
      else {
        // Opening the desktop is not consent to resume remote access. Reuse the
        // existing login jobs and their single-instance policy, never reinstall.
        const components = command === 'start' ? enabledStartupComponents(state) : undefined;
        const startup = !components || components.length
          ? await serviceAction(command, state, home, components, { allowTrayFailure: command === 'start' }) : undefined;
        result = { action: command, deviceId: state.deviceId, ...startup };
      }
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
    } else if (command === 'project-root') {
      if (!action || action === 'show') result = { currentProjectRoot: state.currentProjectRoot };
      else if (action === 'set') {
        if (!argument) throw new Error('Provide an absolute project directory');
        result = await changeProjectRoot(argument, home);
      } else throw new Error('Use project-root show or project-root set <path>');
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

if (process.argv[1]) {
  const invoked = resolve(process.argv[1]);
  const module = fileURLToPath(import.meta.url);
  const [invokedReal, moduleReal] = await Promise.all([
    realpath(invoked).catch(() => invoked),
    realpath(module).catch(() => module),
  ]);
  // Node resolves import.meta.url through directory symlinks while argv keeps the
  // invoked path. Treat both paths as the same executable entrypoint.
  if (invokedReal === moduleReal) {
    main().catch(error => {
      const message = ['win32', 'darwin'].includes(process.platform) ? desktopErrorText(error) : error.message;
      console.error(`Team DevSpace: ${message}`);
      process.exitCode = 1;
    });
  }
}
