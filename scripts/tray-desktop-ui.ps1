param(
  [ValidateSet('menu','click','prompt','cancel','submit','alert','logs','clipboard')][string]$Action = 'menu',
  [string]$Name,
  [string]$LogDirectory = "$env:LOCALAPPDATA\TeamDevSpace\logs"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TrayDesktopProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$foreground = [System.Windows.Automation.AutomationElement]::FromHandle([TrayDesktopProbe]::GetForegroundWindow())
$foregroundProcess = Get-Process -Id $foreground.Current.ProcessId
if ($foregroundProcess.ProcessName -in @('LockApp','LogonUI') -or $foreground.Current.ClassName -match 'LockScreen') {
  throw 'Windows desktop is locked. Unlock it before native tray UI acceptance; no input will be sent.'
}
$all = [System.Windows.Automation.Condition]::TrueCondition
function By-Name([string]$text) { [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $text) }
function Children($element) { $element.FindAll([System.Windows.Automation.TreeScope]::Children, $all) }
function Descendants($element) { $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $all) }
function Invoke-Control($element) {
  if (-not $element) { throw 'Requested desktop control is absent' }
  if (-not $element.Current.IsEnabled) { throw "Control is disabled: $($element.Current.Name)" }
  $rect = $element.Current.BoundingRectangle
  if ($rect.IsEmpty -or $element.Current.IsOffscreen) { throw 'Requested desktop control is not visible' }
  if (-not [TrayDesktopProbe]::SetCursorPos([int]($rect.X+$rect.Width/2), [int]($rect.Y+$rect.Height/2))) { throw 'Cannot position pointer on desktop control' }
  [TrayDesktopProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [TrayDesktopProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
}
function Get-ProductMenus {
  @(Children $root | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu -and
    ((Descendants $_ | Where-Object { $_.Current.Name -match 'Team DevSpace|Access Key|诊断信息|修复连接|重启连接' }).Count -gt 0) })
}
function Open-ProductMenu {
  $menus = @(Get-ProductMenus)
  if ($menus.Count -gt 0) { return }
  $bar = (Children $root | Where-Object { $_.Current.ClassName -eq 'Shell_TrayWnd' } | Select-Object -First 1)
  $icon = Descendants $bar | Where-Object { $_.Current.Name -like 'Team DevSpace*' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | Select-Object -First 1
  if (-not $icon) {
    $overflow = Children $root | Where-Object { $_.Current.ClassName -match 'Overflow' -and -not $_.Current.IsOffscreen } | Select-Object -First 1
    if (-not $overflow) {
      $more = Descendants $bar | Where-Object { $_.Current.Name -in @('显示隐藏的图标', 'Show hidden icons') } | Select-Object -First 1
      Invoke-Control $more
      Start-Sleep -Milliseconds 250
      $overflow = Children $root | Where-Object { $_.Current.ClassName -match 'Overflow' -and -not $_.Current.IsOffscreen } | Select-Object -First 1
    }
    if ($overflow) { $icon = Descendants $overflow | Where-Object { $_.Current.Name -like 'Team DevSpace*' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | Select-Object -First 1 }
  }
  Invoke-Control $icon
  Start-Sleep -Milliseconds 250
}
function Find-Prompt {
  Children $root | Where-Object { $_.Current.Name -eq '更换 Access Key' -and $_.Current.ClassName -like 'WindowsForms*' } | Select-Object -First 1
}
if ($Action -in @('menu', 'click')) {
  Open-ProductMenu
  if ($Action -eq 'click') {
    $item = Get-ProductMenus | ForEach-Object { Descendants $_ } | Where-Object { $_.Current.Name -eq $Name } | Select-Object -First 1
    if (-not $item) {
      $submenu = Get-ProductMenus | ForEach-Object { Descendants $_ } | Where-Object { $_.Current.Name -eq '诊断与修复' } | Select-Object -First 1
      if ($submenu) {
        $rect = $submenu.Current.BoundingRectangle
        [void][TrayDesktopProbe]::SetCursorPos([int]($rect.X+$rect.Width/2), [int]($rect.Y+$rect.Height/2))
        [TrayDesktopProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [TrayDesktopProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        Start-Sleep -Milliseconds 250
        $item = Get-ProductMenus | ForEach-Object { Descendants $_ } | Where-Object { $_.Current.Name -eq $Name } | Select-Object -First 1
      }
    }
    Invoke-Control $item
    @{ clicked = $Name } | ConvertTo-Json -Compress
  } else {
    @(Get-ProductMenus | ForEach-Object { Descendants $_ } | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem } | ForEach-Object {
      @{ name=$_.Current.Name; enabled=$_.Current.IsEnabled }
    }) | ConvertTo-Json -Compress
  }
} elseif ($Action -in @('prompt','cancel','submit')) {
  $dialog = Find-Prompt
  if (-not $dialog) { throw 'Access Key prompt is absent' }
  if ($Action -eq 'prompt') {
    @{ visible=(-not $dialog.Current.IsOffscreen); foreground=([TrayDesktopProbe]::GetForegroundWindow() -eq [IntPtr]$dialog.Current.NativeWindowHandle); pid=$dialog.Current.ProcessId } | ConvertTo-Json -Compress
  } else {
    if ($Action -eq 'submit') {
      if (-not $env:TEAM_DEVSPACE_TEST_INPUT) { throw 'Provide test input only through TEAM_DEVSPACE_TEST_INPUT' }
      $inputBox = Descendants $dialog | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit } | Select-Object -First 1
      ([System.Windows.Automation.ValuePattern]$inputBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($env:TEAM_DEVSPACE_TEST_INPUT)
    }
    $buttonName = if ($Action -eq 'cancel') { '取消' } else { '更换' }
    Invoke-Control ($dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (By-Name $buttonName)))
    @{ action=$Action; inputRedacted=$true } | ConvertTo-Json -Compress
  }
} elseif ($Action -eq 'alert') {
  $dialog = Children $root | Where-Object { $_.Current.Name -eq 'Team DevSpace' -and $_.Current.ClassName -eq '#32770' } | Select-Object -First 1
  if (-not $dialog) { throw 'Team DevSpace error alert is absent' }
  $texts = @(Descendants $dialog | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } | ForEach-Object { $_.Current.Name -replace 'tds_[A-Za-z0-9_-]+','<REDACTED>' })
  Invoke-Control (Descendants $dialog | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -in @('确定','OK') } | Select-Object -First 1)
  @{ dismissed=$true; message=$texts } | ConvertTo-Json -Compress
} elseif ($Action -eq 'logs') {
  $shell = New-Object -ComObject Shell.Application
  @(foreach ($window in @($shell.Windows())) { try { if ($window.Document.Folder.Self.Path -eq $LogDirectory) {
    @{ directory=$LogDirectory; visible=$window.Visible; foreground=([TrayDesktopProbe]::GetForegroundWindow() -eq [IntPtr]$window.HWND); handle=$window.HWND }
  }} catch {} }) | ConvertTo-Json -Compress
} elseif ($Action -eq 'clipboard') {
  $text = Get-Clipboard -Raw
  if ($text -match 'tds_[A-Za-z0-9_-]{20,}|"(?:accessKey|deviceSecret|ownerToken|tunnelToken)"\s*:') { throw 'Clipboard diagnostics leaked credentials' }
  $report = $text | ConvertFrom-Json
  @{ valid=$true; release=$report.release; gateway=$report.gatewayHealth; runtime=$report.devspaceHealth; bridge=$report.bridgeHealth; tunnel=$report.tunnelHealth } | ConvertTo-Json -Compress
}
