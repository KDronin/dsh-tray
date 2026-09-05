#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "shlwapi.lib")

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmdLine, int nShow) {
    (void)hInst; (void)hPrev; (void)lpCmdLine; (void)nShow;
    char self[MAX_PATH];
    char dir[MAX_PATH];
    char runtime[MAX_PATH];
    char asar[MAX_PATH];
    char cmdline[2048];
    char mode[16];

    GetModuleFileNameA(NULL, self, MAX_PATH);
    PathRemoveFileSpecA(self);
    strncpy(dir, self, MAX_PATH - 1);
    dir[MAX_PATH - 1] = 0;

    PathCombineA(runtime, dir, "DeepSeek Harness Runtime.exe");
    PathCombineA(asar, dir, "resources\app.asar");

    char exe_name[MAX_PATH];
    GetModuleFileNameA(NULL, exe_name, MAX_PATH);
    PathStripPathA(exe_name);
    if (strstr(exe_name, "Window") != NULL) {
        strcpy(mode, "window");
    } else {
        strcpy(mode, "tray");
    }

    SetEnvironmentVariableA("DSH_APP_MODE", mode);

    snprintf(cmdline, sizeof(cmdline), "\"%s\" \"%s\"", runtime, asar);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);

    BOOL ok = CreateProcessA(runtime, cmdline, NULL, NULL, FALSE,
                             CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                             NULL, dir, &si, &pi);
    if (!ok) {
        char msg[512];
        snprintf(msg, sizeof(msg), "Failed to start %s.\nError: %lu", runtime, (unsigned long)GetLastError());
        MessageBoxA(NULL, msg, "DeepSeek Harness Launcher", MB_OK | MB_ICONERROR);
        return 1;
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
