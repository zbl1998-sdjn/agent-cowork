#include "webview_bridge.h"
#include "webview2/WebView2.h"
#include <wrl/client.h>
#include <wrl/implements.h>
#include <string>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::Make;

static struct {
    ComPtr<ICoreWebView2Environment> env;
    ComPtr<ICoreWebView2Controller> ctrl;
    ComPtr<ICoreWebView2> view;
    HWND parent = NULL;
    HWND hwnd = NULL;
    bool created = false;
} g_wv;

/* ---------- registry check ---------- */
static LONG kcw_reg_read_value(HKEY root, const wchar_t *subkey,
                                const wchar_t *value, wchar_t *out, DWORD *out_len) {
    HKEY hkey = NULL;
    LONG r = RegOpenKeyExW(root, subkey, 0, KEY_QUERY_VALUE | KEY_WOW64_32KEY, &hkey);
    if (r != ERROR_SUCCESS) return r;
    DWORD type = 0;
    r = RegQueryValueExW(hkey, value, NULL, &type, (LPBYTE)out, out_len);
    RegCloseKey(hkey);
    return r;
}

int kcw_webview_is_available(void) {
    wchar_t buf[512];
    DWORD len = sizeof(buf);
    if (kcw_reg_read_value(HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\"
        L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        L"pv", buf, &len) == ERROR_SUCCESS) {
        return 1;
    }
    len = sizeof(buf);
    if (kcw_reg_read_value(HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\"
        L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        L"pv", buf, &len) == ERROR_SUCCESS) {
        return 1;
    }
    return 0;
}

/* ---------- COM callback helpers ---------- */
class EnvCompletedHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                          ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Environment *env) override {
        if (SUCCEEDED(result) && env) {
            g_wv.env = env;
        }
        return S_OK;
    }
};

class CtrlCompletedHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                          ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
public:
    HRESULT STDMETHODCALLTYPE Invoke(HRESULT result, ICoreWebView2Controller *ctrl) override {
        if (SUCCEEDED(result) && ctrl) {
            g_wv.ctrl = ctrl;
            ctrl->get_CoreWebView2(&g_wv.view);
        }
        return S_OK;
    }
};

/* ---------- public API ---------- */
int kcw_webview_create(HWND parent, const wchar_t *initial_url) {
    if (g_wv.created) return 0;
    if (!kcw_webview_is_available()) return -1;
    if (!parent) return -2;

    g_wv.parent = parent;

    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    (void)hr;

    SetWindowLongPtrW(parent, GWL_STYLE,
        GetWindowLongPtrW(parent, GWL_STYLE) | WS_CLIPCHILDREN);

    auto envHandler = Make<EnvCompletedHandler>();
    auto ctrlHandler = Make<CtrlCompletedHandler>();

    hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, nullptr, nullptr, envHandler.Get());
    if (FAILED(hr)) return -3;

    DWORD t0 = GetTickCount();
    while (!g_wv.env && GetTickCount() - t0 < 10000) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(10);
    }
    if (!g_wv.env) return -4;

    hr = g_wv.env->CreateCoreWebView2Controller(parent, ctrlHandler.Get());
    if (FAILED(hr)) return -5;

    t0 = GetTickCount();
    while (!g_wv.ctrl && GetTickCount() - t0 < 10000) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(10);
    }
    if (!g_wv.ctrl) return -6;

    g_wv.hwnd = parent;
    g_wv.created = true;

    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(g_wv.view->get_Settings(&settings))) {
        settings->put_IsScriptEnabled(TRUE);
        settings->put_AreDefaultScriptDialogsEnabled(TRUE);
        settings->put_IsWebMessageEnabled(TRUE);
        settings->put_AreDevToolsEnabled(FALSE);
    }

    RECT rc;
    GetClientRect(parent, &rc);
    g_wv.ctrl->put_Bounds(rc);

    if (initial_url && initial_url[0]) {
        g_wv.view->Navigate(initial_url);
    }

    return 0;
}

void kcw_webview_destroy(void) {
    if (!g_wv.created) return;
    g_wv.view.Reset();
    if (g_wv.ctrl) {
        g_wv.ctrl->Close();
        g_wv.ctrl.Reset();
    }
    g_wv.env.Reset();
    g_wv.parent = NULL;
    g_wv.hwnd = NULL;
    g_wv.created = false;
}

void kcw_webview_resize(int x, int y, int width, int height) {
    if (!g_wv.ctrl) return;
    RECT rc = { x, y, x + width, y + height };
    g_wv.ctrl->put_Bounds(rc);
}

void kcw_webview_navigate(const wchar_t *url) {
    if (!g_wv.view || !url) return;
    g_wv.view->Navigate(url);
}

int kcw_webview_is_created(void) {
    return g_wv.created ? 1 : 0;
}

HWND kcw_webview_get_hwnd(void) {
    return g_wv.hwnd;
}
