#include "app_window.h"

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous_instance, PWSTR command_line, int show_command) {
    (void)previous_instance;
    (void)command_line;
    return kcw_run_app(instance, show_command);
}

