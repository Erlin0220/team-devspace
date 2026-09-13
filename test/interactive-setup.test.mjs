import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { interactiveInput, terminalQuestion } from '../client/interactive-setup.mjs';

const key = `tds_${'a'.repeat(43)}`;

test('setup prompts for a hidden credential only when needed; change does not ask for a project', async () => {
  const calls = [];
  const ask = async (label, options) => { calls.push({ label, options }); return options.secret ? key : '/workspace'; };
  assert.deepEqual(await interactiveInput(null, { ask }), { accessKey: key, currentProjectRoot: '/workspace' });
  assert.equal(calls[0].options.secret, true);
  calls.length = 0;
  assert.deepEqual(await interactiveInput({ accessKey: key }, { ask, root: '/existing' }), { accessKey: key, currentProjectRoot: '/existing' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await interactiveInput({ accessKey: key }, { ask, changeKey: true }), { accessKey: key });
  assert.equal(calls.length, 1);
});

test('non-TTY setup fails before reading input, and invalid/cancelled input cannot configure anything', async () => {
  assert.throws(() => terminalQuestion('Key', { input: { isTTY: false }, output: { isTTY: true } }), /terminal/);
  await assert.rejects(interactiveInput(null, { ask: async () => '' }), /complete Access Key/);
  await assert.rejects(interactiveInput(null, { ask: async () => { throw new Error('cancelled'); } }), /cancelled/);
});

test('readline secret editing never echoes the secret and restores terminal mode', async () => {
  const input = new PassThrough(); input.isTTY = true;
  const modes = []; input.setRawMode = value => modes.push(value);
  let rendered = '';
  const output = new Writable({ write(chunk, encoding, done) { rendered += chunk.toString(); done(); } }); output.isTTY = true;
  const promise = terminalQuestion('Access Key', { secret: true, input, output });
  input.write(`${key}\r`);
  assert.equal(await promise, key);
  assert.equal(rendered, 'Access Key: \n');
  assert.equal(modes.at(-1), false);
  input.destroy(); output.destroy();
});

test('Ctrl-C and terminal EOF cancel hidden input rather than hanging', async () => {
  for (const eof of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    const output = new Writable({ write(chunk, encoding, done) { done(); } }); output.isTTY = true;
    const promise = terminalQuestion('Key', { secret: true, input, output });
    const rejected = assert.rejects(promise, /cancelled/);
    if (eof) input.end(); else input.write('\u0003');
    await rejected;
    input.destroy(); output.destroy();
  }
});
