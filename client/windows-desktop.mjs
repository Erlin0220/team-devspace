import { execFile } from 'node:child_process';
import { join } from 'node:path';

// PowerShell is a short-lived desktop adapter, never a supervisor. EncodedCommand
// avoids redirected-stdin command mode; closing stdin is essential after a dialog
// is dismissed. Keep credentials on stdout's private pipe, never on argv/logs.
export function runWindowsDesktop(script, { signal, timeout = 15000, env = {} } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows desktop operation on a non-Windows host');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n${script}\n`;
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, signal, timeout, maxBuffer: 64 * 1024, env: { ...process.env, ...env } }, (error, stdout) => {
      if (!error) return resolve(stdout);
      if (signal?.aborted) return reject(Object.assign(new Error('Desktop operation cancelled'), { name: 'AbortError' }));
      // execFile's default error includes the entire command/script; do not show it in the tray.
      reject(new Error(error.killed ? '桌面操作超时，请重试' : `无法完成桌面操作（${error.code ?? 'unknown'}），请重试`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

export async function openWindowsDirectory(directory) {
  await runWindowsDesktop(`
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DesktopWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$path = (Get-Item -LiteralPath $env:TEAM_DEVSPACE_OPEN_DIRECTORY).FullName
$shell = New-Object -ComObject Shell.Application
function Find-Folder {
  foreach ($window in @($shell.Windows())) {
    try { if ($window.Document.Folder.Self.Path -eq $path) { return $window } } catch {}
  }
}
$window = Find-Folder
if (-not $window) { $shell.Explore($path) }
for ($i=0; -not $window -and $i -lt 60; $i++) { Start-Sleep -Milliseconds 100; $window = Find-Folder }
if (-not $window) { throw 'Explorer did not open the requested folder' }
$window.Visible = $true
$handle = [IntPtr]$window.HWND
[void][DesktopWindow]::ShowWindow($handle, 9)
[void][DesktopWindow]::SetForegroundWindow($handle)
`, { env: { TEAM_DEVSPACE_OPEN_DIRECTORY: directory } });
}
