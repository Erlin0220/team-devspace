import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('assets/download-site.js', 'utf8');
function resolve(browser, hints = {}) {
  const context = { navigator: browser, document: { querySelector: () => null, getElementById: () => null, addEventListener() {} } };
  vm.runInNewContext(source, context);
  return context.resolveDownloadTarget(browser, hints);
}
const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36';

test('Mac only selects a chip from explicit high-entropy hints, not the Intel UA', () => {
  assert.equal(resolve(mac).target, null);
  assert.equal(resolve(mac).platform, 'darwin');
  assert.equal(resolve(mac, { platform: 'macOS', architecture: 'arm', bitness: '64' }).target, 'darwin-arm64');
  assert.equal(resolve(mac, { platform: 'macOS', architecture: 'x86', bitness: '64' }).target, 'darwin-x64');
  assert.equal(resolve(mac, { architecture: 'x86' }).target, null);
  assert.equal(resolve(mac, { architecture: 'unknown', bitness: '64' }).target, null);
});

test('Windows/Linux prefer hints and do not mistake frozen Chromium x64 for hardware', () => {
  const windows = { userAgent: chrome, userAgentData: { platform: 'Windows', mobile: false } };
  assert.equal(resolve(windows).target, null);
  assert.equal(resolve(windows, { architecture: 'x86', bitness: '64' }).target, 'win32-x64');
  assert.equal(resolve(windows, { architecture: 'arm', bitness: '64' }).target, null);
  assert.equal(resolve(windows, { architecture: 'x86', bitness: '32' }).target, null);
  const linux = { userAgent: chrome, userAgentData: { platform: 'Linux' } };
  assert.equal(resolve(linux, { architecture: 'x86', bitness: '64' }).target, 'linux-x64');
  assert.equal(resolve(linux, { architecture: 'arm', bitness: '64' }).target, null);
  assert.equal(resolve({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/143.0' }).target, 'win32-x64');
  assert.equal(resolve({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/143.0' }).target, 'linux-x64');
});

test('mobile, desktop-mode iPad, ChromeOS and unknown platforms never get a guessed package', () => {
  for (const browser of [
    { ...mac, maxTouchPoints: 5 },
    { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/152.0.0.0' },
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (X11; CrOS x86_64) Chrome/152.0.0.0' },
    { userAgent: chrome, userAgentData: { platform: 'Android', mobile: false } },
    { userAgent: '' },
  ]) assert.ok(!resolve(browser, { architecture: 'x86', bitness: '64' }).target);
});

test('postinstall recovery alert cannot hold the native Installer open indefinitely', async () => {
  const script = await readFile('platform/macos/postinstall', 'utf8');
  assert.match(script, /display alert[^\n]+giving up after 30/);
});

test('both AppKit project pickers enable folder creation without a custom file manager', async () => {
  const swift = await readFile('native/macos/TeamDevSpaceUI.swift', 'utf8');
  const panels = swift.split('let picker = NSOpenPanel()').slice(1);
  assert.equal(panels.length, 2);
  for (const panel of panels) assert.match(panel.split('picker.message')[0], /picker\.canCreateDirectories = true/);
});
