#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, PWSTR pCmdLine, int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)pCmdLine;
    (void)nCmdShow;

    wchar_t exePath[MAX_PATH];
    if (GetModuleFileNameW(NULL, exePath, MAX_PATH) == 0) {
        MessageBoxW(NULL, L"Failed to resolve launcher directory.", L"M-Stream Bridge", MB_ICONERROR | MB_OK);
        return 1;
    }

    wchar_t* lastSlash = wcsrchr(exePath, L'\\');
    if (lastSlash != NULL) {
        *(lastSlash + 1) = L'\0';
    }

    wchar_t targetPath[MAX_PATH];
    wchar_t targetDir[MAX_PATH];
    swprintf_s(targetPath, MAX_PATH, L"%s_internal\\mstream_core.exe", exePath);
    swprintf_s(targetDir, MAX_PATH, L"%s_internal", exePath);

    DWORD attrib = GetFileAttributesW(targetPath);
    if (attrib == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(
            NULL,
            L"Could not find M-Stream Bridge core runtime in '_internal'.\n\n"
            L"Please ensure all files were extracted from the release archive.",
            L"M-Stream Bridge",
            MB_ICONERROR | MB_OK
        );
        return 1;
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    BOOL success = CreateProcessW(
        targetPath,
        GetCommandLineW(),
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW,
        NULL,
        targetDir,
        &si,
        &pi
    );

    if (!success) {
        wchar_t errorBuf[256];
        swprintf_s(errorBuf, 256, L"Failed to start M-Stream Bridge core process.\nError code: %lu", GetLastError());
        MessageBoxW(NULL, errorBuf, L"M-Stream Bridge", MB_ICONERROR | MB_OK);
        return 1;
    }

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 0;
}
