import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function terminalQuestion(label, { secret = false, defaultValue = '', input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Interactive setup needs a terminal. Use --credential-file for explicit unattended setup.');
  return new Promise((resolve, reject) => {
    // Readline owns editing, paste, Ctrl-C and raw-mode restoration. Only its echo
    // is muted for a secret; no extra prompt dependency enters employee packages.
    const sink = new Writable({ write(chunk, encoding, callback) {
      if (!secret) output.write(chunk, encoding);
      callback();
    } });
    const rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true; reject(new Error('Setup cancelled; configuration was not changed.')); rl.close();
    };
    rl.once('SIGINT', cancel);
    rl.once('close', cancel);
    output.write(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `);
    rl.question('', value => {
      settled = true;
      rl.close();
      if (secret) output.write('\n');
      resolve(value.trim() || defaultValue);
    });
  });
}

export async function interactiveInput(previous, { root, changeKey = false, ask = terminalQuestion } = {}) {
  const accessKey = !changeKey && previous?.accessKey ? previous.accessKey
    : await ask(changeKey ? 'New Access Key' : 'Access Key', { secret: true });
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(accessKey ?? '')) throw new Error('Enter the complete Access Key assigned by your administrator.');
  if (changeKey) return { accessKey };
  const currentProjectRoot = root || await ask('Project directory', { defaultValue: previous?.currentProjectRoot ?? process.cwd() });
  return { accessKey, currentProjectRoot };
}
