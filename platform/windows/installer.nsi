Unicode True
RequestExecutionLevel user
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrRep}

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
!ifndef PLATFORM_DIR
!error "PLATFORM_DIR must point to platform/windows"
!endif
!ifndef OUTPUT
!error "OUTPUT must be set"
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
VIAddVersionKey "FileDescription" "Team DevSpace verified offline bootstrapper"
VIAddVersionKey "FileVersion" "${APP_VERSION}"

Var Dialog
Var KeyControl
Var RootControl
Var AccessKey
Var ProjectRoot
Var RequestFile
Var PreviousEnrollment
Var ResultCode
Var Arguments
Var NoStartup
Var ProgressStyle

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
Page custom EnrollmentPage EnrollmentLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!insertmacro BootstrapProgressFunctions ""
!insertmacro BootstrapProgressFunctions "un."

Function .onInit
  SetShellVarContext current
  StrCpy $PreviousEnrollment "0"
  IfFileExists "$LOCALAPPDATA\TeamDevSpace\state.json" 0 +2
    StrCpy $PreviousEnrollment "1"
  ReadEnvStr $RequestFile "TEAM_DEVSPACE_SETUP_REQUEST_FILE"
  ReadEnvStr $NoStartup "TEAM_DEVSPACE_SETUP_NO_STARTUP"
  ${If} $RequestFile == ""
    ${GetParameters} $Arguments
    ${GetOptions} $Arguments "/REQUEST=" $RequestFile
  ${EndIf}
FunctionEnd

Function EnrollmentPage
  ${If} $PreviousEnrollment == "1"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Enter the Access Key issued by your administrator. The installer uses only the supplied fixed release package and verifies every artifact before activation."
  Pop $0
  ${NSD_CreatePassword} 0 28u 100% 14u ""
  Pop $KeyControl
  ${NSD_CreateLabel} 0 52u 100% 14u "Project directory to allow:"
  Pop $0
  ${NSD_CreateDirRequest} 0 70u 80% 14u ""
  Pop $RootControl
  ${NSD_CreateBrowseButton} 82% 70u 18% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseProject
  ${NSD_CreateLabel} 0 100u 100% 48u "File tools use the selected directory. Shell commands run with your Windows user permissions; this is not a sandbox. Enrollment stays outside application versions and survives upgrades."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function BrowseProject
  nsDialogs::SelectFolderDialog "Choose your project directory" "$PROFILE"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RootControl $0
  ${EndIf}
FunctionEnd

Function EnrollmentLeave
  ${NSD_GetText} $KeyControl $AccessKey
  ${NSD_GetText} $RootControl $ProjectRoot
  StrLen $0 $AccessKey
  StrCpy $1 $AccessKey 4
  ${If} $0 != 47
  ${OrIf} $1 != "tds_"
    MessageBox MB_ICONEXCLAMATION "Enter your complete administrator-issued Access Key."
    Abort
  ${EndIf}
  IfFileExists "$ProjectRoot\*.*" +3 0
    MessageBox MB_ICONEXCLAMATION "Choose an existing project directory."
    Abort
FunctionEnd

Section "Install"
  SetShellVarContext current
  ${If} ${Silent}
  ${AndIf} $PreviousEnrollment != "1"
  ${AndIf} $RequestFile == ""
    SetErrorLevel 2
    Abort "A fresh unattended installation requires /REQUEST=<private setup JSON file>."
  ${EndIf}

  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /oname=bootstrap.ps1 "${BOOTSTRAP}"
  File /oname=release-manifest.json "${MANIFEST}"
  File /oname=command.ps1 "${PLATFORM_DIR}\command.ps1"
  File /oname=repair.cmd "${PLATFORM_DIR}\repair.cmd"
  File /oname=status.cmd "${PLATFORM_DIR}\status.cmd"

  ${If} $RequestFile == ""
  ${AndIf} $PreviousEnrollment != "1"
    InitPluginsDir
    StrCpy $RequestFile "$PLUGINSDIR\team-devspace-request.json"
    ${StrRep} $ProjectRoot $ProjectRoot '\' '\\'
    ${StrRep} $AccessKey $AccessKey '\' '\\'
    ${StrRep} $AccessKey $AccessKey '$\"' '\$\"'
    FileOpen $0 $RequestFile w
    FileWrite $0 '{"accessKey":"$AccessKey","roots":["$ProjectRoot"]}'
    FileClose $0
  ${EndIf}

  StrCpy $Arguments '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$INSTDIR\bootstrap.ps1$\" -Mode Install -InstallPath $\"$INSTDIR$\" -ManifestPath $\"$INSTDIR\release-manifest.json$\" -OfflineRoot $\"$EXEDIR$\"'
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
  StrCpy $AccessKey ""
  ${If} $ResultCode != 0
    SetErrorLevel 4
    MessageBox MB_OK|MB_ICONEXCLAMATION "Offline payload verification or startup failed. The previously active version and Enrollment were retained. Re-run setup from the complete package supplied by your administrator." /SD IDOK
    Abort
  ${EndIf}

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
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Status.lnk" "$INSTDIR\status.cmd" "" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Repair connection.lnk" "$INSTDIR\repair.cmd"
  CreateShortcut "$SMPROGRAMS\${START_MENU_FOLDER}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  DetailPrint "Team DevSpace installation is complete."
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
  RMDir /r "$INSTDIR\versions"
  RMDir /r "$INSTDIR\staging"
  RMDir /r "$INSTDIR\v"
  RMDir /r "$INSTDIR\s"
  RMDir /r "$INSTDIR\cache"
  RMDir /r "$INSTDIR\a"
  Delete "$INSTDIR\active.json"
  Delete "$INSTDIR\distribution.lock"
  Delete "$INSTDIR\release-manifest.json"
  Delete "$INSTDIR\bootstrap.ps1"
  Delete "$INSTDIR\command.ps1"
  Delete "$INSTDIR\repair.cmd"
  Delete "$INSTDIR\status.cmd"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  DetailPrint "Project files and Enrollment data were retained. Ask the administrator to revoke access when retiring this device."
SectionEnd
