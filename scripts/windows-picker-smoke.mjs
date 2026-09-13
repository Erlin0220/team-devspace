import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { desktop: { type: 'boolean' }, 'runtime-root': { type: 'string' } } });
assert.ok(process.platform === 'win32' && values.desktop, 'Use --desktop on an unlocked Windows desktop; this opens and operates real folder dialogs');
const root = resolve(values['runtime-root'] ?? '.');
const { chooseWindowsProject } = await import(pathToFileURL(join(root, 'client/windows-desktop.mjs')));
const exec = promisify(execFile);
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const work = await mkdtemp(join(tmpdir(), 'tds-picker-'));
const checks = [];
async function ps(script) {
  try {
    return (await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 32768 })).stdout.trim();
  } catch (error) { throw new Error(/<S S="Error">([^<]+)/.exec(error.stderr ?? '')?.[1]?.replaceAll('_x000D__x000A_', '') ?? 'Native GUI probe failed or timed out'); }
}
const api = `
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PickerProbe{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr w,uint c);[DllImport("user32.dll")]public static extern IntPtr GetTopWindow(IntPtr w);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr w,int i);[DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr w,int id);[DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr w);[DllImport("user32.dll")]public static extern IntPtr SendMessageW(IntPtr w,uint m,IntPtr p,IntPtr l);}'
$r=[System.Windows.Automation.AutomationElement]::RootElement
$f=[System.Windows.Automation.AutomationElement]::FromHandle([PickerProbe]::GetForegroundWindow())
if((Get-Process -Id $f.Current.ProcessId).ProcessName -in @('LockApp','LogonUI')){throw 'Desktop is locked; GUI acceptance was not performed'}
`;
try {
  await ps(api);
  for (const confirm of [false, true, false, 'abort']) {
    const abort = new AbortController();
    let pick;
    try {
      pick = chooseWindowsProject(work, { signal: abort.signal });
      const result = JSON.parse(await ps(`${api}
$deadline=[DateTime]::UtcNow.AddSeconds(10);$dialog=$null;$helper=0
while(-not $dialog -and [DateTime]::UtcNow -lt $deadline){
  $children=@(Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq ${process.pid} -and $_.Name -eq 'powershell.exe'})
  foreach($child in $children){
    if($child.ProcessId -eq $PID){continue}
    $c=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$child.ProcessId)
    $items=$r.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)
    $dialog=@($items | Where-Object {$_.Current.ClassName -eq '#32770' -and $_.Current.Name -in @('浏览文件夹','Browse For Folder') -and -not $_.Current.IsOffscreen}) | Select-Object -First 1
    if($dialog){$helper=[int]$child.ProcessId;break}
  }
  if(-not $dialog){Start-Sleep -Milliseconds 100}
}
if(-not $dialog){throw 'The actual folder picker was not visible'}
$h=[IntPtr]$dialog.Current.NativeWindowHandle
$owner=[PickerProbe]::GetWindow($h,4);$caller=[PickerProbe]::GetWindow($owner,4)
$z=@();$w=[PickerProbe]::GetTopWindow([IntPtr]::Zero)
while($w-ne [IntPtr]::Zero -and $z.Count-lt 512){$z+= $w.ToInt64();$w=[PickerProbe]::GetWindow($w,2)}
$di=[Array]::IndexOf($z,$h.ToInt64());$ci=[Array]::IndexOf($z,$caller.ToInt64())
$report=@{visible=(-not $dialog.Current.IsOffscreen);foreground=([PickerProbe]::GetForegroundWindow()-eq $h);aboveCaller=($di-ge 0 -and $ci-gt $di);callerEnabled=[PickerProbe]::IsWindowEnabled($caller);owned=($owner-ne [IntPtr]::Zero);pid=$helper}
# IDOK/IDCANCEL are the real standard Win32 dialog buttons, not a fixture event.
$button=[PickerProbe]::GetDlgItem($h,${confirm ? 1 : 2})
if($button-eq [IntPtr]::Zero -or -not [PickerProbe]::IsWindowEnabled($button)){throw 'Native confirmation/cancel button is unavailable'}
$report.foreground=([PickerProbe]::GetForegroundWindow()-eq $h)
${confirm === 'abort' ? '' : '[void][PickerProbe]::SendMessageW($button,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)'}
$report | ConvertTo-Json -Compress
`));
      assert.ok(result.visible && result.owned && result.aboveCaller && result.callerEnabled,
        'The actual picker must be above its caller without disabling the foreign application');
      if (confirm === 'abort') abort.abort();
      const path = await pick;
      assert.equal(path, confirm === true ? work : null, 'Native picker returned the wrong path/cancellation result');
      checks.push({ action: confirm === 'abort' ? 'abort' : confirm ? 'confirm' : 'cancel', ...result, pathMatches: true });
    } finally { abort.abort(); await pick?.catch(() => {}); }
  }
  console.log(JSON.stringify({ passed: true, actualNativeGui: true, checks, foregroundObservedEveryTime: checks.every(check => check.foreground) }));
} finally { await rm(work, { recursive: true, force: true }); }
