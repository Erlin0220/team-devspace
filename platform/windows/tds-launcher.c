#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 0x00002000

typedef struct {
  const wchar_t *cwd;
  const wchar_t *stdout_path;
  const wchar_t *stderr_path;
  const wchar_t *executable;
  wchar_t **arguments;
  int argument_count;
} LauncherOptions;

static const wchar_t *error_path;

static void append_error(const wchar_t *message, DWORD code) {
  if (!error_path) return;
  HANDLE file = CreateFileW(error_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return;
  wchar_t wide[512];
  int length = _snwprintf(wide, 511, L"launcher: %ls (Win32 %lu)\r\n", message, (unsigned long)code);
  if (length > 0) {
    int bytes_needed = WideCharToMultiByte(CP_UTF8, 0, wide, length, NULL, 0, NULL, NULL);
    if (bytes_needed > 0) {
      char *utf8 = HeapAlloc(GetProcessHeap(), 0, (SIZE_T)bytes_needed);
      if (utf8) {
        WideCharToMultiByte(CP_UTF8, 0, wide, length, utf8, bytes_needed, NULL, NULL);
        DWORD written;
        WriteFile(file, utf8, (DWORD)bytes_needed, &written, NULL);
        HeapFree(GetProcessHeap(), 0, utf8);
      }
    }
  }
  CloseHandle(file);
}

static int fail(const wchar_t *message) {
  append_error(message, GetLastError());
  return 1;
}

static int set_environment(const wchar_t *assignment) {
  const wchar_t *separator = wcschr(assignment, L'=');
  if (!separator || separator == assignment) return 0;
  SIZE_T name_size = (SIZE_T)(separator - assignment + 1) * sizeof(wchar_t);
  wchar_t *name = HeapAlloc(GetProcessHeap(), 0, name_size);
  if (!name) return 0;
  memcpy(name, assignment, name_size - sizeof(wchar_t));
  name[name_size / sizeof(wchar_t) - 1] = L'\0';
  const wchar_t *value = separator + 1;
  BOOL result = SetEnvironmentVariableW(name, *value ? value : NULL);
  HeapFree(GetProcessHeap(), 0, name);
  return result != FALSE;
}

static int parse_options(int argc, wchar_t **argv, LauncherOptions *options) {
  ZeroMemory(options, sizeof(*options));
  int index = 1;
  for (; index < argc; index++) {
    wchar_t *option = argv[index];
    if (wcscmp(option, L"--") == 0) { index++; break; }
    if (++index >= argc) return 0;
    wchar_t *value = argv[index];
    if (wcscmp(option, L"--cwd") == 0) options->cwd = value;
    else if (wcscmp(option, L"--stdout") == 0) options->stdout_path = value;
    else if (wcscmp(option, L"--stderr") == 0) {
      options->stderr_path = value;
      error_path = value;
    } else if (wcscmp(option, L"--env") == 0) {
      if (!set_environment(value)) return 0;
    } else return 0;
  }
  if (!options->cwd || !options->stdout_path || !options->stderr_path || index >= argc) return 0;
  options->executable = argv[index++];
  options->arguments = argv + index;
  options->argument_count = argc - index;
  DWORD attributes = GetFileAttributesW(options->executable);
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) return 0;
  attributes = GetFileAttributesW(options->cwd);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static void append_quoted(wchar_t **cursor, const wchar_t *value) {
  *(*cursor)++ = L'"';
  size_t slashes = 0;
  for (; *value; value++) {
    if (*value == L'\\') { slashes++; continue; }
    if (*value == L'"') {
      for (size_t i = 0; i < slashes * 2 + 1; i++) *(*cursor)++ = L'\\';
      *(*cursor)++ = L'"';
      slashes = 0;
      continue;
    }
    for (size_t i = 0; i < slashes; i++) *(*cursor)++ = L'\\';
    slashes = 0;
    *(*cursor)++ = *value;
  }
  for (size_t i = 0; i < slashes * 2; i++) *(*cursor)++ = L'\\';
  *(*cursor)++ = L'"';
}

static wchar_t *child_command_line(const LauncherOptions *options) {
  SIZE_T characters = (wcslen(options->executable) * 2) + 3;
  for (int i = 0; i < options->argument_count; i++)
    characters += (wcslen(options->arguments[i]) * 2) + 4;
  if (characters >= 32767) return NULL;
  wchar_t *command = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, characters * sizeof(wchar_t));
  if (!command) return NULL;
  wchar_t *cursor = command;
  append_quoted(&cursor, options->executable);
  for (int i = 0; i < options->argument_count; i++) {
    *cursor++ = L' ';
    append_quoted(&cursor, options->arguments[i]);
  }
  *cursor = L'\0';
  return command;
}

static void ensure_parent_directory(const wchar_t *path) {
  wchar_t *copy = _wcsdup(path);
  if (!copy) return;
  wchar_t *separator = wcsrchr(copy, L'\\');
  if (separator) {
    *separator = L'\0';
    if (*copy) SHCreateDirectoryExW(NULL, copy, NULL);
  }
  free(copy);
}

static HANDLE open_inherited_file(const wchar_t *path, DWORD access, DWORD disposition) {
  ensure_parent_directory(path);
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE file = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    &security, disposition, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file != INVALID_HANDLE_VALUE && disposition == OPEN_ALWAYS) {
    LARGE_INTEGER size = { 0 }, position = { 0 };
    if (GetFileSizeEx(file, &size) && size.QuadPart > 5LL * 1024 * 1024 &&
        SetFilePointerEx(file, position, NULL, FILE_BEGIN)) {
      SetEndOfFile(file);
    }
    if (!SetFilePointerEx(file, position, NULL, FILE_END)) {
      CloseHandle(file);
      return INVALID_HANDLE_VALUE;
    }
  }
  return file;
}

static HANDLE create_job(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    return NULL;
  }
  return job;
}

static int run_child(const LauncherOptions *options) {
  int result = 1;
  HANDLE input = INVALID_HANDLE_VALUE, output = INVALID_HANDLE_VALUE, error = INVALID_HANDLE_VALUE, job = NULL;
  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  wchar_t *command = child_command_line(options);
  if (!command) return fail(L"Cannot build child command line");
  input = open_inherited_file(L"NUL", GENERIC_READ, OPEN_EXISTING);
  output = open_inherited_file(options->stdout_path, GENERIC_WRITE, OPEN_ALWAYS);
  error = open_inherited_file(options->stderr_path, GENERIC_WRITE, OPEN_ALWAYS);
  // Diagnostics are optional. Keep a valid inherited sink when a log is locked
  // or unavailable; process ownership and Job Object setup remain mandatory.
  if (output == INVALID_HANDLE_VALUE) {
    append_error(L"stdout log unavailable; using NUL", GetLastError());
    output = open_inherited_file(L"NUL", GENERIC_WRITE, OPEN_EXISTING);
  }
  if (error == INVALID_HANDLE_VALUE)
    error = open_inherited_file(L"NUL", GENERIC_WRITE, OPEN_EXISTING);
  job = create_job();
  if (input == INVALID_HANDLE_VALUE || output == INVALID_HANDLE_VALUE || error == INVALID_HANDLE_VALUE || !job) {
    fail(L"Cannot initialize child handles");
    goto cleanup;
  }
  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = input;
  startup.hStdOutput = output;
  startup.hStdError = error;
  if (!CreateProcessW(options->executable, command, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
      NULL, options->cwd, &startup, &process)) {
    fail(L"Cannot create child process");
    goto cleanup;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    fail(L"Cannot assign child process to cleanup job");
    TerminateProcess(process.hProcess, 1);
    goto cleanup;
  }
  if (ResumeThread(process.hThread) == (DWORD)-1) {
    fail(L"Cannot resume child process");
    TerminateProcess(process.hProcess, 1);
    goto cleanup;
  }
  if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_FAILED) {
    fail(L"Cannot wait for child process");
    TerminateProcess(process.hProcess, 1);
    goto cleanup;
  }
  DWORD exit_code;
  if (!GetExitCodeProcess(process.hProcess, &exit_code)) {
    fail(L"Cannot read child exit code");
    goto cleanup;
  }
  result = (int)exit_code;

cleanup:
  if (process.hThread) CloseHandle(process.hThread);
  if (process.hProcess) CloseHandle(process.hProcess);
  if (job) CloseHandle(job);
  if (error != INVALID_HANDLE_VALUE) CloseHandle(error);
  if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
  if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
  HeapFree(GetProcessHeap(), 0, command);
  return result;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show) {
  (void)instance;
  (void)previous;
  (void)command_line;
  (void)show;
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return fail(L"Cannot parse launcher command line");
  LauncherOptions options;
  int valid = parse_options(argc, argv, &options);
  int result = valid ? run_child(&options) : fail(L"Invalid launcher arguments");
  LocalFree(argv);
  return result;
}
