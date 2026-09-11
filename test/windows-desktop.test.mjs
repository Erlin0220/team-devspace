import test from 'node:test';
import assert from 'node:assert/strict';
import { runWindowsDesktop } from '../client/windows-desktop.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 10000 };
test('Windows desktop adapter exits after its script and preserves UTF-8 output', windows, async () => {
  assert.equal((await runWindowsDesktop("[Console]::Out.Write('桌面操作完成')")).trim(), '桌面操作完成');
});
test('Windows desktop adapter supports cancelling a pending process', windows, async () => {
  const abort = new AbortController();
  const pending = runWindowsDesktop('Start-Sleep -Seconds 60', { signal: abort.signal });
  const timer = setTimeout(() => abort.abort(), 500);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});
test('Windows desktop adapter times out instead of blocking the controller indefinitely', windows, async () => {
  await assert.rejects(runWindowsDesktop('Start-Sleep -Seconds 60', { timeout: 500 }), /超时/);
});
