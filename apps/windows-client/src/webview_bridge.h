#pragma once

#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 检测 WebView2 Runtime 是否可用（读注册表） */
int kcw_webview_is_available(void);

/* 在 parent HWND 内创建 WebView2，导航到 initialUrl */
/* 返回 0 成功，非 0 失败 */
int kcw_webview_create(HWND parent, const wchar_t *initial_url);

/* 销毁 WebView2 并释放资源 */
void kcw_webview_destroy(void);

/* 调整 WebView2 位置和大小（相对 parent 客户区） */
void kcw_webview_resize(int x, int y, int width, int height);

/* 导航到新 URL */
void kcw_webview_navigate(const wchar_t *url);

/* 是否已创建 */
int kcw_webview_is_created(void);

/* 获取 WebView2 的顶层 HWND（父窗口为创建时传入的 parent） */
HWND kcw_webview_get_hwnd(void);

#ifdef __cplusplus
}
#endif
