#include "app_window.h"
#include "native_bridge.h"

static const wchar_t *KCW_CLASS_NAME = L"KimiCoworkWindow";

static LRESULT CALLBACK kcw_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_CREATE:
        kcw_native_bridge_init(window);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wparam, lparam);
    }
}

int kcw_run_app(HINSTANCE instance, int show_command) {
    WNDCLASSW window_class = {0};
    window_class.lpfnWndProc = kcw_window_proc;
    window_class.hInstance = instance;
    window_class.lpszClassName = KCW_CLASS_NAME;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);

    if (!RegisterClassW(&window_class)) {
        return 1;
    }

    HWND window = CreateWindowExW(
        0,
        KCW_CLASS_NAME,
        L"Kimi Cowork",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1200,
        800,
        NULL,
        NULL,
        instance,
        NULL);

    if (!window) {
        return 1;
    }

    ShowWindow(window, show_command);
    UpdateWindow(window);

    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    return (int)message.wParam;
}

