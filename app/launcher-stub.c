/*
 * Launcher stub for Steam on Whisky.
 *
 * Steam's launch target for Skyrim Special Edition (appid 489830) is
 * SkyrimSELauncher.exe, and the game engine only agrees to run when Steam is
 * the process that started its tree. So the way to start the game without the
 * launcher UI is to put this stub where the launcher was: Steam starts the
 * stub, the stub starts the real game as its child, and the game inherits the
 * Steam launch context it insists on.
 *
 * The original launcher is kept next to it as SkyrimSELauncher.exe.orig, so
 * replacing this file with that one restores the stock behaviour.
 *
 * Build (see build.sh):
 *   zig cc -target x86_64-windows-gnu -O2 -mwindows -o SkyrimSELauncher.exe launcher-stub.c
 */

#include <windows.h>

#define DEFAULT_TARGET L"SkyrimSE.exe"

static void directory_of(const wchar_t *path, wchar_t *out, DWORD size)
{
    lstrcpynW(out, path, (int)size);
    wchar_t *slash = wcsrchr(out, L'\\');
    if (slash) *(slash + 1) = L'\0';
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command, int show)
{
    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    wchar_t self[MAX_PATH];
    if (!GetModuleFileNameW(NULL, self, MAX_PATH)) return 1;

    wchar_t dir[MAX_PATH];
    directory_of(self, dir, MAX_PATH);

    // Allow overriding the target, so another game can reuse this stub later.
    const wchar_t *target = DEFAULT_TARGET;
    const wchar_t *line = GetCommandLineW();
    if (line && wcsstr(line, L"-- ")) target = wcsstr(line, L"-- ") + 3;

    wchar_t path[MAX_PATH];
    lstrcpynW(path, dir, MAX_PATH);
    lstrcatW(path, target);

    if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) {
        // The real launcher is still available next to us; hand over to it
        // rather than failing silently if the game binary is missing.
        lstrcpynW(path, dir, MAX_PATH);
        lstrcatW(path, L"SkyrimSELauncher.exe.orig");
        if (GetFileAttributesW(path) == INVALID_FILE_ATTRIBUTES) return 1;
    }

    STARTUPINFOW startup;
    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);

    PROCESS_INFORMATION process;
    ZeroMemory(&process, sizeof(process));

    if (!CreateProcessW(path, NULL, NULL, NULL, TRUE, 0, NULL, dir, &startup, &process))
        return 1;

    WaitForSingleObject(process.hProcess, INFINITE);

    DWORD code = 0;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);

    return (int)code;
}
