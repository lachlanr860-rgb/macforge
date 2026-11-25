/*
 * steamwebhelper-wrapper — prepend Chromium flags and delegate to the real
 * Steam webhelper binary.
 *
 * Steam's CEF (Chromium 126) paints its window black under Wine on Apple
 * Silicon: the renderer and GPU processes each create a D3D11 swapchain for a
 * window owned by another process, which winemac/DXMT cannot hand a Metal
 * layer across, so the compositor never gets a frame (DXMT issue #141, Wine
 * bug 60263). With the GPU process gone Chromium falls back to CPU (Skia)
 * rasterisation, and collapsing the renderer, GPU and network service into the
 * browser process also keeps the login request off Wine's winsock TLS path,
 * which otherwise fails with net_error -100/-107.
 *
 * The flags are prepended to every invocation: Steam starts this executable
 * once per CEF process, and each one needs them.
 *
 * Build (Homebrew mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -municode -DUNICODE -D_UNICODE -static \
 *     -o steamwebhelper.exe steamwebhelper-wrapper.c -lshell32 -mwindows
 *
 * Derived from notpop/steam-on-m1-wine (MIT).
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define EXTRA_FLAGS L"--disable-gpu --single-process"
#define REAL_BINARY L"steamwebhelper_real.exe"

static FILE *dbg = NULL;

static void debug_open(const wchar_t *self_path)
{
    const wchar_t *flag = _wgetenv(L"STEAMWEBHELPER_WRAPPER_DEBUG");
    if (!flag || !*flag) return;
    if (wcslen(self_path) + 16 >= MAX_PATH) return;

    wchar_t log_path[MAX_PATH];
    wcscpy(log_path, self_path);
    wchar_t *slash = wcsrchr(log_path, L'\\');
    if (!slash) return;
    wcscpy(slash + 1, L"wrapper-debug.log");
    dbg = _wfopen(log_path, L"a");
}

static void debug_log(const wchar_t *fmt, ...)
{
    if (!dbg) return;
    va_list ap;
    va_start(ap, fmt);
    vfwprintf(dbg, fmt, ap);
    va_end(ap);
    fflush(dbg);
}

/* "<wrapper_dir>\steamwebhelper_real.exe" */
static wchar_t *resolve_real_binary(wchar_t *out_self, size_t cap)
{
    wchar_t self[MAX_PATH];
    DWORD len = GetModuleFileNameW(NULL, self, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return NULL;
    if (out_self && wcslen(self) < cap) wcscpy(out_self, self);

    wchar_t *slash = wcsrchr(self, L'\\');
    if (!slash) return NULL;
    *(slash + 1) = L'\0';

    size_t need = wcslen(self) + wcslen(REAL_BINARY) + 1;
    wchar_t *real = (wchar_t *)calloc(need, sizeof(wchar_t));
    if (!real) return NULL;
    wcscpy(real, self);
    wcscat(real, REAL_BINARY);
    return real;
}

/* Everything after the wrapper's own (possibly quoted) path. */
static const wchar_t *args_tail(void)
{
    const wchar_t *cmd = GetCommandLineW();
    if (!cmd) return L"";

    if (*cmd == L'"') {
        ++cmd;
        while (*cmd && *cmd != L'"') ++cmd;
        if (*cmd == L'"') ++cmd;
    } else {
        while (*cmd && *cmd != L' ') ++cmd;
    }
    while (*cmd == L' ') ++cmd;
    return cmd;
}

static int run(void)
{
    wchar_t self_path[MAX_PATH] = {0};
    wchar_t *real = resolve_real_binary(self_path, MAX_PATH);
    if (!real) return 1;

    debug_open(self_path);
    debug_log(L"[wrapper] self=%ls\n", self_path);

    const wchar_t *tail = args_tail();
    debug_log(L"[wrapper] args=%ls\n", tail);

    size_t cap = wcslen(real) + wcslen(EXTRA_FLAGS) + wcslen(tail) + 8;
    wchar_t *cmdline = (wchar_t *)calloc(cap, sizeof(wchar_t));
    if (!cmdline) {
        free(real);
        return 1;
    }
    _snwprintf(cmdline, cap, L"\"%ls\" %ls %ls", real, EXTRA_FLAGS, tail);
    debug_log(L"[wrapper] exec=%ls\n", cmdline);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    BOOL ok = CreateProcessW(real, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi);
    if (!ok) {
        debug_log(L"[wrapper] CreateProcessW failed: %lu\n", GetLastError());
        free(cmdline);
        free(real);
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    debug_log(L"[wrapper] exit=%lu\n", code);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    free(cmdline);
    free(real);
    if (dbg) fclose(dbg);

    return (int)code;
}

/*
 * Both entry points exist so the same file builds with mingw-w64 (-municode,
 * wmain) and with zig cc, whose Windows startup looks for WinMain.
 */
int wmain(void)
{
    return run();
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR arguments, int show)
{
    (void)instance;
    (void)previous;
    (void)arguments;
    (void)show;
    return run();
}
