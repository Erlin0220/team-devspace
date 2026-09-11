import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

const scenario = process.argv[2];
const key = `tds_${'a'.repeat(43)}`;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
assert.match(process.env.TEAM_DEVSPACE_TRAY_INSTANCE_ID, /^[a-f0-9]{64}$/);
assert.equal(process.argv.some(value => value.includes('tds_')), false);
let submitted = false;
let cancelled = false;
let errors = 0;
const submit = () => emit({ event: 'submit', accessKey: key, projectRoot: '/test/project' });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  // No stored key should ever be sent back to the view.
  assert.equal(line.includes(key), false);
  if (message.type === 'form') {
    if (scenario === 'ready-no-visible') return;
    emit({ event: 'form-visible' });
    if (scenario === 'cancel') { emit({ event: 'cancel' }); return; }
    if (scenario === 'invalid') { emit({ event: 'submit', accessKey: 'a'.repeat(257), projectRoot: '' }); return; }
    submitted = true;
    submit();
    if (scenario === 'duplicate-submit') submit();
  } else if (message.type === 'form-result') {
    if (message.phase === 'error') {
      assert.match(message.message, /无效|已隐藏/);
      assert.equal(++errors, 1);
      submit();
    } else if (message.phase === 'success') {
      assert.equal(submitted, true);
      assert.doesNotMatch(message.message, /^已连接/);
      emit({ event: 'cancel' });
    } else if (message.phase === 'busy' && !cancelled) {
      if (scenario === 'cancel-busy') { cancelled = true; emit({ event: 'cancel' }); }
      if (scenario === 'crash-busy') process.exit(2);
    }
  }
});
lines.on('close', () => process.exit(0));
if (scenario === 'no-ready') { /* Wait for the parent's startup deadline and EOF. */ }
else if (scenario === 'duplicate') emit({ event: 'duplicate' });
else if (scenario === 'bad-json') process.stdout.write(`${key}\n`);
else if (scenario === 'oversize') process.stdout.write('x'.repeat(70000));
else emit({ event: 'ready' });
