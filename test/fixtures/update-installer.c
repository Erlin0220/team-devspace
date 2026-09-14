#include <windows.h>
#include <wchar.h>

/* Test-only installer: no registry, services or real application changes. */
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
  (void)instance; (void)previous; (void)arguments; (void)show;
  wchar_t home[32768], output[32768];
  if (!GetEnvironmentVariableW(L"TEAM_DEVSPACE_HOME", home, 32000) ||
      !wcsstr(home, L"tds update handoff ")) return 91;
  Sleep(6000); /* Must outlive the initiating GUI launcher's kill-on-close job. */
  if (_snwprintf(output, 32767, L"%ls\\installer-proof.txt", home) < 0) return 92;
  HANDLE file = CreateFileW(output, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 93;
  char utf8[32768];
  int length = WideCharToMultiByte(CP_UTF8, 0, GetCommandLineW(), -1, utf8, sizeof(utf8), NULL, NULL);
  DWORD written;
  BOOL success = length > 0 && WriteFile(file, utf8, (DWORD)(length - 1), &written, NULL);
  CloseHandle(file);
  return success ? 0 : 94;
}
