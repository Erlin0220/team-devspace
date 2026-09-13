Unicode True
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
!error "APP_VERSION must be generated from release.config.json"
!endif
!ifndef APP_VERSION_NUM
!error "APP_VERSION_NUM must be generated from release.config.json"
!endif
!ifndef DEVSPACE_VERSION
!error "DEVSPACE_VERSION must be generated from release.config.json"
!endif
!ifndef BOOTSTRAP
!error "BOOTSTRAP must point to bootstrap.ps1"
!endif
!ifndef MANIFEST
!error "MANIFEST must point to the embedded immutable release manifest"
!endif
!ifndef OFFLINE_OBJECTS
!error "OFFLINE_OBJECTS must point to the verified component object tree"
!endif
!ifndef PLATFORM_DIR
!error "PLATFORM_DIR must point to platform/windows"
!endif
!ifndef OUTPUT
!error "OUTPUT must be set"
!endif
!ifndef LAUNCHER
!error "LAUNCHER must point to the built no-console launcher"
!endif
!ifndef APP_ICON
!error "APP_ICON must point to the product shortcut icon"
!endif
!ifndef PRODUCT_KEY
!define PRODUCT_KEY "Software\TeamDevSpace"
!endif
!ifndef UNINSTALL_KEY
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TeamDevSpace"
!endif
!ifndef START_MENU_FOLDER
!define START_MENU_FOLDER "Team DevSpace"
!endif

Name "Team DevSpace"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\TDS"
InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallDir"
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show
BrandingText "Team DevSpace offline installer - official DevSpace ${DEVSPACE_VERSION}"
VIProductVersion "${APP_VERSION_NUM}"
VIAddVersionKey "ProductName" "Team DevSpace"
VIAddVersionKey "FileDescription" "Team DevSpace self-contained offline installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"

Var RequestFile
Var ResultCode
Var Arguments
Var NoStartup
Var ProgressStyle
Var SetupPending
Var SetupMessage

!define PBS_MARQUEE 0x08

!macro BootstrapProgressFunctions Prefix
Function ${Prefix}StartBootstrapProgress
  ${If} $mui.InstFilesPage.ProgressBar != 0
    System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar, i ${GWL_STYLE}) i .r0'
    StrCpy $ProgressStyle $0
    IntOp $0 $0 | ${PBS_MARQUEE}
    System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i ${GWL_STYLE}, i r0)'
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETPOS} 10 0
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETMARQUEE} 1 45
  ${EndIf}
FunctionEnd

Function ${Prefix}StopBootstrapProgress
  ${If} $mui.InstFilesPage.ProgressBar != 0
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETMARQUEE} 0 0
    System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i ${GWL_STYLE}, i $ProgressStyle)'
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETPOS} 95 0
  ${EndIf}
FunctionEnd
!macroend

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenDesktop
!define MUI_FINISHPAGE_RUN_TEXT "Open Team DevSpace (enter Access Key in the application)"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!insertmacro BootstrapProgressFunctions ""
!insertmacro BootstrapProgressFunctions "un."

Function .onInit
  SetShellVarContext current
  ReadEnvStr $RequestFile "TEAM_DEVSPACE_SETUP_REQUEST_FILE"
  ReadEnvStr $NoStartup "TEAM_DEVSPACE_SETUP_NO_STARTUP"
  ${If} $RequestFile == ""
    ${GetParameters} $Arguments
    ${GetOptions} $Arguments "/REQUEST=" $RequestFile
  ${EndIf}
FunctionEnd

Function OpenDesktop
  ${If} $NoStartup != "1"
    ExecShell "open" "$SMPROGRAMS\${START_MENU_FOLDER}\Team DevSpace.lnk"
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  StrCpy $SetupPending "0"

  InitPluginsDir
  SetOutPath "$PLUGINSDIR\offline\objects"
  File /r "${OFFLINE_OBJECTS}\*.*"

  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /oname=bootstrap.ps1 "${BOOTSTRAP}"
  File /oname=release-manifest.json "${MANIFEST}"
  File /oname=command.ps1 "${PLATFORM_DIR}\command.ps1"
  File /oname=tds-launcher.exe "${LAUNCHER}"
  File /oname=team-devspace.ico "${APP_ICON}"
  File /oname=repair.cmd "${PLATFORM_DIR}\repair.cmd"
  File /oname=status.cmd "${PLATFORM_DIR}\status.cmd"

  StrCpy $Arguments '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$INSTDIR\bootstrap.ps1$\" -Mode Install -InstallPath $\"$INSTDIR$\" -ManifestPath $\"$INSTDIR\release-manifest.json$\" -OfflineRoot $\"$PLUGINSDIR\offline$\"'
  ${If} $RequestFile != ""
    StrCpy $Arguments '$Arguments -RequestFile $\"$RequestFile$\"'
  ${EndIf}
  ${If} $NoStartup == "1"
    StrCpy $Arguments '$Arguments -NoStartup'
  ${EndIf}
  DetailPrint "Verifying and installing the offline Team DevSpace components..."
  Call StartBootstrapProgress
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" $Arguments'
  Pop $ResultCode
  Call StopBootstrapProgress
  ${If} $ResultCode == 10
    StrCpy $SetupPending "1"
    StrCpy $SetupMessage "Connection setup did not complete. Check the installer details, then use Repair connection."
    IfFileExists "$INSTDIR\onboarding-message.txt" 0 setup_message_ready
      FileOpen $0 "$INSTDIR\onboarding-message.txt" r
      FileReadUTF16LE $0 $SetupMessage
      FileClose $0
    setup_message_ready:
  ${ElseIf} $ResultCode != 0
    FileOpen $0 "$INSTDIR\bootstrap-launch-error.log" w
    FileWrite $0 "Bootstrap process result: $ResultCode$\r$\n"
    FileClose $0
    SetErrorLevel 4
    MessageBox MB_OK|MB_ICONEXCLAMATION "Local Team DevSpace installation failed before activation. The previous installed version and Enrollment were retained. Re-run this trusted installer." /SD IDOK
    Abort
  ${EndIf}
  Delete "$INSTDIR\bootstrap-launch-error.log"

  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Team DevSpace"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Team DevSpace"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  DetailPrint "Creating current-user shortcuts..."
  CreateDirectory "$SMPROGRAMS\${START_MENU_FOLDER}"
  ; Stable launcher delegates through active.json, so shortcuts survive slot upgrades.
  ; Use the same folder identity for the Desktop link so isolated smoke never
  ; overwrites the employee's shortcut.
  StrCpy $Arguments '--cwd $\"$INSTDIR$\" --stdout $\"$LOCALAPPDATA\TeamDevSpace\logs\open.log$\" --stderr $\"$LOCALAPPDATA\TeamDevSpace\logs\open.error.log$\" --env $\"NODE_OPTIONS=$\" -- $\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$INSTDIR\command.ps1$\" -Desktop start'
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Team DevSpace.lnk" "$INSTDIR\tds-launcher.exe" "$Arguments" "$INSTDIR\team-devspace.ico" 0 SW_SHOWNORMAL "" "Open Team DevSpace in the system tray"
  CreateShortcut "$DESKTOP\${START_MENU_FOLDER}.lnk" "$INSTDIR\tds-launcher.exe" "$Arguments" "$INSTDIR\team-devspace.ico" 0 SW_SHOWNORMAL "" "Open Team DevSpace in the system tray"
  Delete "$SMPROGRAMS\${START_MENU_FOLDER}\Status.lnk"
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Repair connection.lnk" "$INSTDIR\repair.cmd"
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  DetailPrint "Team DevSpace local installation is complete. Enter or change Access Key in the application."
  ${If} $SetupPending == "1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Team DevSpace was installed successfully, but connection setup did not complete.$\r$\n$\r$\n$SetupMessage$\r$\n$\r$\nAfter resolving the issue, use 'Repair connection'. The installed application does not need to be reinstalled." /SD IDOK
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  DetailPrint "Stopping Team DevSpace and removing current-user startup entries..."
  Call un.StartBootstrapProgress
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\bootstrap.ps1" -Mode Uninstall -InstallPath "$INSTDIR"'
  Pop $ResultCode
  Call un.StopBootstrapProgress
  ${If} $ResultCode != 0
    SetErrorLevel 5
    Abort "Could not remove user-login startup. Application versions were retained for repair."
  ${EndIf}
  RMDir /r "$SMPROGRAMS\${START_MENU_FOLDER}"
  Delete "$DESKTOP\${START_MENU_FOLDER}.lnk"
  ; bootstrap.ps1 removes large payload trees before returning so NSIS does not
  ; enumerate tens of thousands of node_modules files in the uninstall UI.
  Delete "$INSTDIR\active.json"
  Delete "$INSTDIR\distribution.lock"
  Delete "$INSTDIR\release-manifest.json"
  Delete "$INSTDIR\bootstrap-error.log"
  Delete "$INSTDIR\bootstrap-launch-error.log"
  Delete "$INSTDIR\onboarding-error.log"
  Delete "$INSTDIR\onboarding-message.txt"
  Delete "$INSTDIR\bootstrap.ps1"
  Delete "$INSTDIR\command.ps1"
  Delete "$INSTDIR\tds-launcher.exe"
  Delete "$INSTDIR\team-devspace.ico"
  Delete "$INSTDIR\repair.cmd"
  Delete "$INSTDIR\status.cmd"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  DetailPrint "Project files and Enrollment data were retained. Ask the administrator to revoke access when retiring this device."
SectionEnd
