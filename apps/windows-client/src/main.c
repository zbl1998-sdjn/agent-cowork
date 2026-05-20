#include "app_window.h"

#include <stdbool.h>
#include <wchar.h>

#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((DPI_AWARENESS_CONTEXT)-4)
#endif

static const wchar_t *kcw_skip_spaces(const wchar_t *value) {
    while (value && (*value == L' ' || *value == L'\t')) {
        value++;
    }
    return value;
}

static void kcw_trim_trailing_spaces(wchar_t *value) {
    size_t len = wcslen(value);
    while (len > 0 && (value[len - 1] == L' ' || value[len - 1] == L'\t')) {
        value[len - 1] = L'\0';
        len--;
    }
}

static bool kcw_parse_workspace_argument(const wchar_t *command_line, wchar_t *workspace, size_t workspace_len) {
    if (!command_line || command_line[0] == L'\0') {
        return false;
    }

    const wchar_t equals_flag[] = L"--workspace=";
    const wchar_t space_flag[] = L"--workspace";
    const wchar_t *value = wcsstr(command_line, equals_flag);
    if (value) {
        value += wcslen(equals_flag);
    } else {
        value = wcsstr(command_line, space_flag);
        if (!value) {
            return false;
        }
        value += wcslen(space_flag);
        value = kcw_skip_spaces(value);
    }

    if (!value || value[0] == L'\0') {
        return false;
    }

    if (value[0] == L'"') {
        value++;
        const wchar_t *end = wcschr(value, L'"');
        if (end) {
            size_t len = (size_t)(end - value);
            if (len >= workspace_len) {
                len = workspace_len - 1;
            }
            wcsncpy_s(workspace, workspace_len, value, len);
            workspace[len] = L'\0';
            return workspace[0] != L'\0';
        }
    }

    wcsncpy_s(workspace, workspace_len, value, _TRUNCATE);
    kcw_trim_trailing_spaces(workspace);
    return workspace[0] != L'\0';
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous_instance, PWSTR command_line, int show_command) {
    (void)previous_instance;

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    wchar_t workspace[MAX_PATH] = L"";
    if (kcw_parse_workspace_argument(command_line, workspace, sizeof(workspace) / sizeof(workspace[0]))) {
        return kcw_run_app_with_workspace(instance, show_command, workspace);
    }
    if (kcw_parse_workspace_argument(GetCommandLineW(), workspace, sizeof(workspace) / sizeof(workspace[0]))) {
        return kcw_run_app_with_workspace(instance, show_command, workspace);
    }
    if (GetEnvironmentVariableW(L"KIMI_COWORK_WORKSPACE", workspace, (DWORD)(sizeof(workspace) / sizeof(workspace[0]))) > 0) {
        return kcw_run_app_with_workspace(instance, show_command, workspace);
    }

    return kcw_run_app(instance, show_command);
}
