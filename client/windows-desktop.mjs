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

export async function chooseWindowsProject(currentProjectRoot, { signal } = {}) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Windows.Forms;public sealed class DialogCaller : IWin32Window { [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow(); private readonly IntPtr handle = GetForegroundWindow(); public IntPtr Handle { get { return handle; } } }'
$caller = New-Object DialogCaller
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Team DevSpace'
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
# A nonmodal, caller-owned window anchors the picker above its caller without
# globally pinning it over other apps or disabling a foreign browser window.
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = '选择 Team DevSpace 项目目录'
$picker.ShowNewFolderButton = $false
if ($env:TEAM_DEVSPACE_CURRENT_PROJECT -and (Test-Path -LiteralPath $env:TEAM_DEVSPACE_CURRENT_PROJECT -PathType Container)) {
  $picker.SelectedPath = $env:TEAM_DEVSPACE_CURRENT_PROJECT
}
try {
  if ($caller.Handle -eq [IntPtr]::Zero) { $owner.Show() } else { $owner.Show($caller) }
  $owner.Activate()
  if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($picker.SelectedPath) }
} finally { $picker.Dispose(); $owner.Dispose() }
`;
  try {
    return (await runWindowsDesktop(script, { signal, timeout: 300000,
      env: { TEAM_DEVSPACE_CURRENT_PROJECT: currentProjectRoot ?? '' } })).trim() || null;
  } catch (error) { if (error.name === 'AbortError') return null; throw error; }
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
