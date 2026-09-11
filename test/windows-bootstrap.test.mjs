import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('Windows legacy task migration uses one hidden elevated PowerShell helper, never cmd.exe', async () => {
  const script = await readFile('platform/windows/bootstrap.ps1', 'utf8');
  assert.match(script, /Join-Path \$env:SystemRoot 'Sysnative'/,
    '32-bit bootstrap should still use Sysnative for direct access to native system tools');
  assert.match(script, /\$elevatedSystemDirectory = Join-Path \$env:SystemRoot 'System32'/);
  assert.match(script, /\$elevatedPowerShell = Join-Path \$elevatedSystemDirectory 'WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(script, /\$schtasks = Join-Path \$elevatedSystemDirectory 'schtasks\.exe'/);
  assert.match(script, /-WindowStyle', 'Hidden', '-EncodedCommand'/);
  assert.match(script, /Start-Process -FilePath \$elevatedPowerShell -Verb RunAs .* -WindowStyle Hidden/);
  assert.doesNotMatch(script, /\$cmd\s*=|Start-Process -FilePath \$cmd|cmd\.exe/,
    'The installer must not flash a console window just to migrate legacy startup tasks');
});

test('Windows activation pointer failure restores previous startup ownership', async () => {
  const script = await readFile('platform/windows/bootstrap.ps1', 'utf8');
  assert.ok(script.includes('try {\n      Write-AtomicJson $activeFile $next'));
  assert.ok(script.includes('if ($active) { Restore-Previous $active $candidate }'));
  assert.ok(script.includes("$recovery = 'candidate startup was removed'"));
  assert.ok(script.includes("$recovery = 'previous version was restored'"));
  assert.ok(script.includes('Local activation pointer update failed; ${recovery}'));
});

test('Windows bootstrap parses in the 32-bit PowerShell 5 host used by NSIS', { skip: process.platform !== 'win32' }, () => {
  const powershell = join(process.env.SystemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "$errors=@();[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'platform/windows/bootstrap.ps1'),[ref]$null,[ref]$errors);if($errors.Count){$errors|Out-String|Write-Error;exit 1}";
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: process.cwd(), windowsHide: true, stdio: 'pipe' });
});

test('Windows Git fallback checks for a matching Git Bash, not git.exe alone', async () => {
  const script = await readFile('platform/windows/bootstrap.ps1', 'utf8');
  assert.ok(script.includes('function Test-NeedGitFallback'));
  assert.ok(script.includes("Join-Path $directory 'git.exe'"));
  assert.ok(script.includes("'bin\\bash.exe'"));
  assert.ok(!script.includes('return -not (Get-Command git.exe -ErrorAction SilentlyContinue)'));
});
