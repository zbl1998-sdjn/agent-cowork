#pragma once

#include <windows.h>

int kcw_run_app(HINSTANCE instance, int show_command);
int kcw_run_app_with_workspace(HINSTANCE instance, int show_command, const wchar_t *initial_workspace);
