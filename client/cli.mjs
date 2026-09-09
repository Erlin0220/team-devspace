#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { approvedRoots, atomicJson, loadState, stateHome, writeUpstreamConfig } from './state.mjs';
import { configureDevice, deviceStatus, macSetupDialog, requestFromFile } from './setup.mjs';
import { installServices, serviceAction } from './platform.mjs';
import { runComponent } from './runtime.mjs';

const HELP = `Team DevSpace
  setup --credential-file <file.json> --root <project-directory> [--root <another-directory>]
  setup --request-file <private-installer-request.json>
  setup-gui                         Native macOS first-run setup
  status                            Show local and gateway health (no secrets)
  start | stop | restart            Control your user-session runtime
  roots list | add <path> | remove <path>
  startup install | remove          Manage native user-login startup
  uninstall                         Stop/remove startup; retain Enrollment for repair
  run runtime                       Foreground DevSpace + bridge (native startup uses this)
  --home <directory>                Isolated local state (advanced)

Use the same Access Key when connecting the Team DevSpace workspace app.
Allowed Roots constrain file tools, not shell commands: shell executes with your user permissions.
`;

export async function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string' }, gateway: { type: 'string' }, root: { type: 'string', multiple: true },
    'credential-file': { type: 'string' }, 'request-file': { type: 'string' },
    'no-startup': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.home) process.env.TEAM_DEVSPACE_HOME = resolve(values.home);
  const home = stateHome();
  const [command, action, argument] = positionals;
  if (values.help || !command) { console.log(HELP); return; }
  if (command === 'run') { await runComponent(action, home); return; }
  let result;
  if (command === 'setup') {
    const input = values['request-file'] ? await requestFromFile(values['request-file'], true)
      : values['credential-file'] ? await requestFromFile(values['credential-file']) : {};
    if (values.root) input.roots = values.root;
    if (values.gateway) input.gateway = values.gateway;
    result = await configureDevice(input, { home, startup: !values['no-startup'] });
  } else if (command === 'setup-gui') result = await macSetupDialog(home);
  else if (command === 'status') result = await deviceStatus(home);
  else {
    const state = await loadState(home);
    if (['start', 'stop', 'restart'].includes(command)) {
      await serviceAction(command, state, home); result = { action: command, deviceId: state.deviceId };
    } else if (command === 'startup') {
      if (action === 'install') { await installServices(state, home); await serviceAction('start', state, home); }
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
        await serviceAction('start', next, home, ['runtime']);
        result = { roots, note: 'DevSpace restarted; existing MCP sessions must reconnect.' };
      }
    } else throw new Error('Unknown command; run team-devspace --help');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Team DevSpace: ${error.message}`); process.exitCode = 1; });
}
