#include "app_window.h"
#include "native_bridge.h"
#include "webview_bridge.h"

#include <shlobj.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <wchar.h>

static const wchar_t *KCW_CLASS_NAME = L"AgentCoworkWindow";

#define KCW_MAX_FILES 240
#define KCW_CONTEXT_MAX_FILES 3
#define KCW_CONTEXT_SNIPPET_BYTES 768
#define KCW_TEMPLATE_COUNT 8
#define KCW_NAV_COUNT 9

#define KCW_ID_NEW_CHAT 1001
#define KCW_ID_BROWSE 1002
#define KCW_ID_RUN 1003
#define KCW_ID_APPROVE 1004
#define KCW_ID_DEVELOPER 1005
#define KCW_ID_BROWSER 1006
#define KCW_ID_PROMPT 2001
#define KCW_ID_FILE_LIST 2002
#define KCW_ID_ARTIFACT 2003
#define KCW_ID_TEMPLATE_BASE 3000

#define KCW_COLOR_BG RGB(247, 248, 250)
#define KCW_COLOR_SURFACE RGB(255, 255, 255)
#define KCW_COLOR_SIDEBAR RGB(248, 249, 251)
#define KCW_COLOR_PANEL RGB(252, 252, 253)
#define KCW_COLOR_BORDER RGB(226, 228, 232)
#define KCW_COLOR_BORDER_DARK RGB(206, 210, 216)
#define KCW_COLOR_TEXT RGB(20, 22, 26)
#define KCW_COLOR_MUTED RGB(108, 112, 120)
#define KCW_COLOR_FAINT RGB(147, 151, 158)
#define KCW_COLOR_SOFT RGB(243, 244, 246)
#define KCW_COLOR_SOFT_ACTIVE RGB(235, 237, 241)
#define KCW_COLOR_ACCENT RGB(255, 76, 64)
#define KCW_COLOR_ACCENT_SOFT RGB(255, 241, 239)
#define KCW_COLOR_BLACK RGB(14, 15, 17)

typedef struct KcwAppState {
    HFONT font_ui;
    HFONT font_ui_bold;
    HFONT font_small;
    HFONT font_micro;
    HFONT font_heading;
    HFONT font_brand;
    HFONT font_title;
    HBRUSH brush_bg;
    HBRUSH brush_surface;
    HBRUSH brush_panel;

    HWND prompt_edit;
    HWND file_list;
    HWND artifact_edit;
    HWND new_chat_button;
    HWND browse_button;
    HWND run_button;
    HWND approve_button;
    HWND developer_button;
    HWND browser_button;
    HWND template_buttons[KCW_TEMPLATE_COUNT];

    wchar_t trusted_root[MAX_PATH];
    wchar_t status_line[256];
    wchar_t last_artifact_path[MAX_PATH];
    wchar_t last_audit_path[MAX_PATH];
    wchar_t last_rollback_path[MAX_PATH];
    wchar_t file_paths[KCW_MAX_FILES][MAX_PATH];
    wchar_t pending_move_from[MAX_PATH];
    wchar_t pending_move_to[MAX_PATH];
    wchar_t pending_move_from_relative[MAX_PATH];
    wchar_t pending_move_to_relative[MAX_PATH];
    bool pending_move_ready;
    int selected_template;
    int file_count;
    bool webview_visible;
} KcwAppState;

static KcwAppState g_app;
static wchar_t g_initial_workspace[MAX_PATH];

static const wchar_t *KCW_TEMPLATES[KCW_TEMPLATE_COUNT] = {
    L"文件夹整理",
    L"会议纪要",
    L"合同摘要",
    L"发票归档",
    L"反馈分类",
    L"多文档报告",
    L"Excel 清洗",
    L"通知草稿",
};

static const wchar_t *KCW_NAV_ITEMS[KCW_NAV_COUNT] = {
    L"PPT",
    L"文档",
    L"深度研究",
    L"网站",
    L"表格",
    L"Agent 集群",
    L"Kimi Code",
    L"Kimi WebBridge",
    L"Agent Cowork",
};

static const wchar_t *KCW_NAV_ICONS[KCW_NAV_COUNT] = {
    L"▱",
    L"□",
    L"⌕",
    L"▭",
    L"▦",
    L"⌘",
    L">",
    L"↔",
    L"●",
};

static int kcw_min_int(int a, int b) {
    return a < b ? a : b;
}

static int kcw_max_int(int a, int b) {
    return a > b ? a : b;
}

static void kcw_set_status(const wchar_t *status) {
    wcsncpy_s(g_app.status_line, sizeof(g_app.status_line) / sizeof(g_app.status_line[0]), status, _TRUNCATE);
}

static const wchar_t *kcw_skip_spaces_local(const wchar_t *value) {
    while (value && (*value == L' ' || *value == L'\t')) {
        value++;
    }
    return value;
}

static void kcw_trim_trailing_spaces_local(wchar_t *value) {
    size_t len = wcslen(value);
    while (len > 0 && (value[len - 1] == L' ' || value[len - 1] == L'\t')) {
        value[len - 1] = L'\0';
        len--;
    }
}

static bool kcw_parse_workspace_from_text(const wchar_t *text, wchar_t *workspace, size_t workspace_len) {
    if (!text || text[0] == L'\0') {
        return false;
    }

    const wchar_t equals_flag[] = L"--workspace=";
    const wchar_t space_flag[] = L"--workspace";
    const wchar_t *value = wcsstr(text, equals_flag);
    if (value) {
        value += wcslen(equals_flag);
    } else {
        value = wcsstr(text, space_flag);
        if (!value) {
            return false;
        }
        value += wcslen(space_flag);
        value = kcw_skip_spaces_local(value);
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
    kcw_trim_trailing_spaces_local(workspace);
    return workspace[0] != L'\0';
}

static void kcw_detect_initial_workspace(void) {
    if (g_initial_workspace[0] != L'\0') {
        return;
    }

    wchar_t env_workspace[MAX_PATH] = L"";
    if (GetEnvironmentVariableW(L"AGENT_COWORK_WORKSPACE", env_workspace, (DWORD)(sizeof(env_workspace) / sizeof(env_workspace[0]))) > 0) {
        wcsncpy_s(g_initial_workspace, sizeof(g_initial_workspace) / sizeof(g_initial_workspace[0]), env_workspace, _TRUNCATE);
        return;
    }

    wchar_t parsed_workspace[MAX_PATH] = L"";
    if (kcw_parse_workspace_from_text(GetCommandLineW(), parsed_workspace, sizeof(parsed_workspace) / sizeof(parsed_workspace[0]))) {
        wcsncpy_s(g_initial_workspace, sizeof(g_initial_workspace) / sizeof(g_initial_workspace[0]), parsed_workspace, _TRUNCATE);
        return;
    }

    wchar_t current_dir[MAX_PATH] = L"";
    if (GetCurrentDirectoryW((DWORD)(sizeof(current_dir) / sizeof(current_dir[0])), current_dir) > 0) {
        wchar_t marker[MAX_PATH] = L"";
        swprintf_s(marker, sizeof(marker) / sizeof(marker[0]), L"%s\\agent-cowork.workspace", current_dir);
        if (GetFileAttributesW(marker) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy_s(g_initial_workspace, sizeof(g_initial_workspace) / sizeof(g_initial_workspace[0]), current_dir, _TRUNCATE);
        }
    }
}

static HFONT kcw_create_named_font(int size, int weight, const wchar_t *family) {
    return CreateFontW(
        -size,
        0,
        0,
        0,
        weight,
        FALSE,
        FALSE,
        FALSE,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        DEFAULT_PITCH | FF_DONTCARE,
        family);
}

static HFONT kcw_create_font(int size, int weight) {
    return kcw_create_named_font(size, weight, L"Microsoft YaHei UI");
}

static void kcw_draw_line(HDC dc, int x1, int y1, int x2, int y2, COLORREF color) {
    HPEN pen = CreatePen(PS_SOLID, 1, color);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    MoveToEx(dc, x1, y1, NULL);
    LineTo(dc, x2, y2);
    SelectObject(dc, old_pen);
    DeleteObject(pen);
}

static void kcw_draw_round_rect(HDC dc, RECT rect, COLORREF fill, COLORREF border, int radius) {
    HBRUSH brush = CreateSolidBrush(fill);
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HGDIOBJ old_brush = SelectObject(dc, brush);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(pen);
    DeleteObject(brush);
}

static void kcw_draw_soft_shadow(HDC dc, RECT rect, int radius) {
    RECT layer = rect;
    OffsetRect(&layer, 0, 8);
    InflateRect(&layer, 8, 8);
    kcw_draw_round_rect(dc, layer, RGB(243, 244, 246), RGB(243, 244, 246), radius + 10);

    layer = rect;
    OffsetRect(&layer, 0, 4);
    InflateRect(&layer, 4, 4);
    kcw_draw_round_rect(dc, layer, RGB(237, 239, 243), RGB(237, 239, 243), radius + 6);
}

static void kcw_draw_text(HDC dc, HFONT font, const wchar_t *text, RECT rect, COLORREF color, UINT format) {
    HFONT old_font = (HFONT)SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color);
    DrawTextW(dc, text, -1, &rect, format);
    SelectObject(dc, old_font);
}

static void kcw_draw_badge(HDC dc, RECT rect, const wchar_t *text, COLORREF fill, COLORREF border, COLORREF color) {
    kcw_draw_round_rect(dc, rect, fill, border, 12);
    kcw_draw_text(dc, g_app.font_micro, text, rect, color, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
}

static HWND kcw_create_owner_button(HWND parent, int id, const wchar_t *text) {
    HWND button = CreateWindowExW(
        0,
        L"BUTTON",
        text,
        WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP,
        0,
        0,
        1,
        1,
        parent,
        (HMENU)(INT_PTR)id,
        GetModuleHandleW(NULL),
        NULL);
    SendMessageW(button, WM_SETFONT, (WPARAM)g_app.font_ui, TRUE);
    return button;
}

static bool kcw_is_template_id(int id) {
    return id >= KCW_ID_TEMPLATE_BASE && id < KCW_ID_TEMPLATE_BASE + KCW_TEMPLATE_COUNT;
}

static void kcw_draw_button(const DRAWITEMSTRUCT *item) {
    wchar_t text[128] = L"";
    GetWindowTextW(item->hwndItem, text, (int)(sizeof(text) / sizeof(text[0])));

    int id = GetDlgCtrlID(item->hwndItem);
    bool pressed = (item->itemState & ODS_SELECTED) != 0;
    bool focused = (item->itemState & ODS_FOCUS) != 0;
    bool template_selected = kcw_is_template_id(id) && (id - KCW_ID_TEMPLATE_BASE == g_app.selected_template);

    COLORREF fill = KCW_COLOR_SURFACE;
    COLORREF border = KCW_COLOR_BORDER;
    COLORREF text_color = KCW_COLOR_TEXT;
    HFONT font = g_app.font_ui;
    UINT text_format = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS;
    int radius = 16;

    if (id == KCW_ID_RUN) {
        fill = pressed ? RGB(48, 49, 52) : KCW_COLOR_BLACK;
        border = fill;
        text_color = RGB(255, 255, 255);
        font = g_app.font_ui_bold;
    } else if (id == KCW_ID_APPROVE) {
        fill = pressed ? RGB(225, 56, 45) : KCW_COLOR_ACCENT;
        border = fill;
        text_color = RGB(255, 255, 255);
        font = g_app.font_ui_bold;
    } else if (id == KCW_ID_BROWSE || id == KCW_ID_NEW_CHAT) {
        fill = pressed ? KCW_COLOR_SOFT_ACTIVE : KCW_COLOR_SURFACE;
        text_format = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS;
        font = g_app.font_ui_bold;
    } else if (template_selected) {
        fill = KCW_COLOR_BLACK;
        border = KCW_COLOR_BLACK;
        text_color = RGB(255, 255, 255);
        font = g_app.font_small;
        radius = 18;
    } else if (id == KCW_ID_DEVELOPER) {
        fill = KCW_COLOR_ACCENT_SOFT;
        border = RGB(255, 216, 211);
        text_format = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS;
        font = g_app.font_ui_bold;
    } else if (kcw_is_template_id(id)) {
        fill = KCW_COLOR_SURFACE;
        border = RGB(221, 224, 229);
        font = g_app.font_small;
        radius = 18;
    }

    if (focused && id != KCW_ID_RUN && id != KCW_ID_APPROVE && !template_selected) {
        border = RGB(158, 166, 178);
    }

    RECT rect = item->rcItem;
    InflateRect(&rect, -1, -1);
    kcw_draw_round_rect(item->hDC, rect, fill, border, radius);

    RECT text_rect = rect;
    if (text_format & DT_LEFT) {
        text_rect.left += 18;
        text_rect.right -= 18;
        if (id == KCW_ID_NEW_CHAT) {
            text_rect.right -= 76;
        }
    }
    kcw_draw_text(item->hDC, font, text, text_rect, text_color, text_format);

    if (id == KCW_ID_NEW_CHAT) {
        RECT key = {rect.right - 76, rect.top + 8, rect.right - 16, rect.bottom - 8};
        kcw_draw_round_rect(item->hDC, key, KCW_COLOR_SOFT, KCW_COLOR_SOFT, 8);
        kcw_draw_text(item->hDC, g_app.font_micro, L"Ctrl  K", key, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    }
}

static bool kcw_has_document_extension(const wchar_t *name) {
    const wchar_t *dot = wcsrchr(name, L'.');
    if (!dot) {
        return false;
    }

    return _wcsicmp(dot, L".pdf") == 0 || _wcsicmp(dot, L".docx") == 0 || _wcsicmp(dot, L".doc") == 0 ||
           _wcsicmp(dot, L".xlsx") == 0 || _wcsicmp(dot, L".xls") == 0 || _wcsicmp(dot, L".csv") == 0 ||
           _wcsicmp(dot, L".txt") == 0 || _wcsicmp(dot, L".md") == 0 || _wcsicmp(dot, L".pptx") == 0;
}

static bool kcw_has_text_summary_extension(const wchar_t *name) {
    const wchar_t *dot = wcsrchr(name, L'.');
    if (!dot) {
        return false;
    }
    return _wcsicmp(dot, L".txt") == 0 || _wcsicmp(dot, L".md") == 0 || _wcsicmp(dot, L".csv") == 0;
}

static bool kcw_skip_directory(const wchar_t *name) {
    return _wcsicmp(name, L".git") == 0 || _wcsicmp(name, L"node_modules") == 0 ||
           _wcsicmp(name, L"build") == 0 || _wcsicmp(name, L"dist") == 0 ||
           _wcsicmp(name, L".AgentCowork") == 0;
}

static void kcw_append_text(wchar_t *out, size_t out_len, const wchar_t *text) {
    if (!out || out_len == 0 || !text) {
        return;
    }
    wcsncat_s(out, out_len, text, _TRUNCATE);
}

static void kcw_append_format(wchar_t *out, size_t out_len, const wchar_t *format, ...) {
    wchar_t line[1200];
    line[0] = L'\0';
    va_list args;
    va_start(args, format);
    vswprintf_s(line, sizeof(line) / sizeof(line[0]), format, args);
    va_end(args);
    kcw_append_text(out, out_len, line);
}

static void kcw_join_path(wchar_t *out, size_t out_len, const wchar_t *base, const wchar_t *child) {
    if (!child || child[0] == L'\0') {
        wcsncpy_s(out, out_len, base, _TRUNCATE);
        return;
    }
    swprintf_s(out, out_len, L"%s\\%s", base, child);
}

static void kcw_normalize_snippet(wchar_t *value) {
    bool previous_space = false;
    wchar_t *write = value;
    for (wchar_t *read = value; read && *read; read++) {
        wchar_t ch = *read;
        bool is_space = ch == L'\r' || ch == L'\n' || ch == L'\t' || ch == L' ';
        if (is_space) {
            if (!previous_space) {
                *write++ = L' ';
                previous_space = true;
            }
            continue;
        }
        *write++ = ch;
        previous_space = false;
    }
    *write = L'\0';
    kcw_trim_trailing_spaces_local(value);
}

static bool kcw_read_text_snippet(const wchar_t *relative, wchar_t *snippet, size_t snippet_len, DWORD *size_out) {
    if (!relative || relative[0] == L'\0' || !snippet || snippet_len == 0 || g_app.trusted_root[0] == L'\0') {
        return false;
    }
    snippet[0] = L'\0';

    wchar_t full_path[MAX_PATH];
    kcw_join_path(full_path, sizeof(full_path) / sizeof(full_path[0]), g_app.trusted_root, relative);

    WIN32_FILE_ATTRIBUTE_DATA attrs;
    if (!GetFileAttributesExW(full_path, GetFileExInfoStandard, &attrs)) {
        return false;
    }
    if ((attrs.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || attrs.nFileSizeHigh != 0) {
        return false;
    }
    if (size_out) {
        *size_out = attrs.nFileSizeLow;
    }

    HANDLE file = CreateFileW(full_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }

    char bytes[KCW_CONTEXT_SNIPPET_BYTES + 1];
    DWORD bytes_read = 0;
    BOOL ok = ReadFile(file, bytes, KCW_CONTEXT_SNIPPET_BYTES, &bytes_read, NULL);
    CloseHandle(file);
    if (!ok || bytes_read == 0) {
        return false;
    }

    for (DWORD i = 0; i < bytes_read; i++) {
        if (bytes[i] == '\0') {
            return false;
        }
    }
    bytes[bytes_read] = '\0';

    const char *input = bytes;
    int input_len = (int)bytes_read;
    if (bytes_read >= 3 && (unsigned char)bytes[0] == 0xEF && (unsigned char)bytes[1] == 0xBB && (unsigned char)bytes[2] == 0xBF) {
        input += 3;
        input_len -= 3;
    }

    int converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, input_len, snippet, (int)snippet_len - 1);
    if (converted == 0) {
        converted = MultiByteToWideChar(CP_ACP, 0, input, input_len, snippet, (int)snippet_len - 1);
    }
    if (converted <= 0) {
        snippet[0] = L'\0';
        return false;
    }
    snippet[converted] = L'\0';
    kcw_normalize_snippet(snippet);
    return snippet[0] != L'\0';
}

static void kcw_build_context_summary(wchar_t *out, size_t out_len, int *read_count_out, int *skipped_count_out) {
    if (!out || out_len == 0) {
        return;
    }
    out[0] = L'\0';
    int read_count = 0;
    int skipped_count = 0;

    kcw_append_text(out, out_len, L"本地内容摘要\r\n");
    if (g_app.trusted_root[0] == L'\0' || g_app.file_count <= 0) {
        kcw_append_text(out, out_len, L"- 尚未选择信任工作区或未扫描到可处理文件。\r\n\r\n");
        if (read_count_out) {
            *read_count_out = 0;
        }
        if (skipped_count_out) {
            *skipped_count_out = 0;
        }
        return;
    }

    for (int i = 0; i < g_app.file_count; i++) {
        const wchar_t *relative = g_app.file_paths[i];
        if (!kcw_has_text_summary_extension(relative)) {
            skipped_count++;
            continue;
        }

        wchar_t snippet[512];
        DWORD file_size = 0;
        if (!kcw_read_text_snippet(relative, snippet, sizeof(snippet) / sizeof(snippet[0]), &file_size)) {
            skipped_count++;
            continue;
        }

        kcw_append_format(out, out_len, L"- %s (%lu bytes)：%s\r\n", relative, (unsigned long)file_size, snippet);
        read_count++;
        if (read_count >= KCW_CONTEXT_MAX_FILES) {
            skipped_count += g_app.file_count - i - 1;
            break;
        }
    }

    if (read_count == 0) {
        kcw_append_text(out, out_len, L"- 已扫描文件，但当前只预览 TXT / Markdown / CSV；PDF / Office 文件会留给后续解析器处理。\r\n");
    }
    if (skipped_count > 0) {
        kcw_append_format(out, out_len, L"- 跳过：%d 个二进制、Office/PDF、不可读或超出本轮摘要上限的文件。\r\n", skipped_count);
    }
    kcw_append_text(out, out_len, L"\r\n");

    if (read_count_out) {
        *read_count_out = read_count;
    }
    if (skipped_count_out) {
        *skipped_count_out = skipped_count;
    }
}

static const wchar_t *kcw_file_name_from_relative(const wchar_t *relative) {
    const wchar_t *slash = wcsrchr(relative, L'\\');
    if (!slash) {
        return relative;
    }
    return slash + 1;
}

static void kcw_clear_pending_move(void) {
    g_app.pending_move_ready = false;
    g_app.pending_move_from[0] = L'\0';
    g_app.pending_move_to[0] = L'\0';
    g_app.pending_move_from_relative[0] = L'\0';
    g_app.pending_move_to_relative[0] = L'\0';
}

static bool kcw_build_pending_move_preview(void) {
    kcw_clear_pending_move();
    if (g_app.trusted_root[0] == L'\0' || g_app.file_count <= 0) {
        return false;
    }

    const wchar_t *source_relative = g_app.file_paths[0];
    const wchar_t *file_name = kcw_file_name_from_relative(source_relative);
    if (!source_relative || source_relative[0] == L'\0' || !file_name || file_name[0] == L'\0') {
        return false;
    }

    swprintf_s(
        g_app.pending_move_to_relative,
        sizeof(g_app.pending_move_to_relative) / sizeof(g_app.pending_move_to_relative[0]),
        L"Agent_Cowork整理\\%s\\%s",
        KCW_TEMPLATES[g_app.selected_template],
        file_name);
    kcw_join_path(g_app.pending_move_from, sizeof(g_app.pending_move_from) / sizeof(g_app.pending_move_from[0]), g_app.trusted_root, source_relative);
    kcw_join_path(g_app.pending_move_to, sizeof(g_app.pending_move_to) / sizeof(g_app.pending_move_to[0]), g_app.trusted_root, g_app.pending_move_to_relative);
    wcsncpy_s(
        g_app.pending_move_from_relative,
        sizeof(g_app.pending_move_from_relative) / sizeof(g_app.pending_move_from_relative[0]),
        source_relative,
        _TRUNCATE);

    if (GetFileAttributesW(g_app.pending_move_from) == INVALID_FILE_ATTRIBUTES) {
        kcw_clear_pending_move();
        return false;
    }
    g_app.pending_move_ready = true;
    return true;
}

static void kcw_scan_files_recursive(const wchar_t *root, const wchar_t *relative, int depth) {
    if (depth > 4 || g_app.file_count >= KCW_MAX_FILES) {
        return;
    }

    wchar_t base[MAX_PATH];
    wchar_t search[MAX_PATH];
    kcw_join_path(base, sizeof(base) / sizeof(base[0]), root, relative);
    swprintf_s(search, sizeof(search) / sizeof(search[0]), L"%s\\*", base);

    WIN32_FIND_DATAW data;
    HANDLE finder = FindFirstFileW(search, &data);
    if (finder == INVALID_HANDLE_VALUE) {
        return;
    }

    do {
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) {
            continue;
        }

        wchar_t child_relative[MAX_PATH];
        if (relative && relative[0] != L'\0') {
            swprintf_s(child_relative, sizeof(child_relative) / sizeof(child_relative[0]), L"%s\\%s", relative, data.cFileName);
        } else {
            wcsncpy_s(child_relative, sizeof(child_relative) / sizeof(child_relative[0]), data.cFileName, _TRUNCATE);
        }

        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            if (!kcw_skip_directory(data.cFileName)) {
                kcw_scan_files_recursive(root, child_relative, depth + 1);
            }
            continue;
        }

        if (kcw_has_document_extension(data.cFileName)) {
            wcsncpy_s(
                g_app.file_paths[g_app.file_count],
                sizeof(g_app.file_paths[g_app.file_count]) / sizeof(g_app.file_paths[g_app.file_count][0]),
                child_relative,
                _TRUNCATE);
            SendMessageW(g_app.file_list, LB_ADDSTRING, 0, (LPARAM)child_relative);
            g_app.file_count++;
            if (g_app.file_count >= KCW_MAX_FILES) {
                break;
            }
        }
    } while (FindNextFileW(finder, &data));

    FindClose(finder);
}

static void kcw_scan_trusted_root(void) {
    SendMessageW(g_app.file_list, LB_RESETCONTENT, 0, 0);
    g_app.file_count = 0;
    kcw_clear_pending_move();

    if (g_app.trusted_root[0] == L'\0') {
        return;
    }

    kcw_scan_files_recursive(g_app.trusted_root, L"", 0);

    wchar_t status[256];
    swprintf_s(status, sizeof(status) / sizeof(status[0]), L"已信任工作区，扫描到 %d 个可处理文件。", g_app.file_count);
    kcw_set_status(status);
}

static bool kcw_ensure_directory(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    }
    return CreateDirectoryW(path, NULL) != 0 || GetLastError() == ERROR_ALREADY_EXISTS;
}

static bool kcw_prepare_app_directories(wchar_t *artifacts_dir, size_t artifacts_len, wchar_t *audit_dir, size_t audit_len, wchar_t *rollback_dir, size_t rollback_len) {
    if (g_app.trusted_root[0] == L'\0') {
        return false;
    }

    wchar_t app_dir[MAX_PATH];
    swprintf_s(app_dir, sizeof(app_dir) / sizeof(app_dir[0]), L"%s\\.AgentCowork", g_app.trusted_root);
    swprintf_s(artifacts_dir, artifacts_len, L"%s\\artifacts", app_dir);
    swprintf_s(audit_dir, audit_len, L"%s\\audit", app_dir);
    swprintf_s(rollback_dir, rollback_len, L"%s\\rollback", app_dir);

    return kcw_ensure_directory(app_dir) && kcw_ensure_directory(artifacts_dir) && kcw_ensure_directory(audit_dir) && kcw_ensure_directory(rollback_dir);
}

static void kcw_make_batch_id(wchar_t *batch_id, size_t batch_len) {
    SYSTEMTIME now;
    GetLocalTime(&now);
    swprintf_s(
        batch_id,
        batch_len,
        L"%04u%02u%02u-%02u%02u%02u-%03u",
        now.wYear,
        now.wMonth,
        now.wDay,
        now.wHour,
        now.wMinute,
        now.wSecond,
        now.wMilliseconds);
}

static void kcw_json_write_string(FILE *file, const wchar_t *value) {
    fputwc(L'"', file);
    for (const wchar_t *cursor = value; cursor && *cursor; cursor++) {
        wchar_t ch = *cursor;
        if (ch == L'\\' || ch == L'"') {
            fputwc(L'\\', file);
            fputwc(ch, file);
        } else if (ch == L'\r') {
            fwprintf(file, L"\\r");
        } else if (ch == L'\n') {
            fwprintf(file, L"\\n");
        } else if (ch == L'\t') {
            fwprintf(file, L"\\t");
        } else {
            fputwc(ch, file);
        }
    }
    fputwc(L'"', file);
}

static bool kcw_write_approved_artifact(const wchar_t *plan_text, wchar_t *error, size_t error_len) {
    wchar_t artifacts_dir[MAX_PATH];
    wchar_t audit_dir[MAX_PATH];
    wchar_t rollback_dir[MAX_PATH];
    if (!kcw_prepare_app_directories(artifacts_dir, sizeof(artifacts_dir) / sizeof(artifacts_dir[0]), audit_dir, sizeof(audit_dir) / sizeof(audit_dir[0]), rollback_dir, sizeof(rollback_dir) / sizeof(rollback_dir[0]))) {
        wcsncpy_s(error, error_len, L"无法创建 .AgentCowork 本地产物目录。", _TRUNCATE);
        return false;
    }

    wchar_t batch_id[64];
    kcw_make_batch_id(batch_id, sizeof(batch_id) / sizeof(batch_id[0]));

    wchar_t artifact_path[MAX_PATH];
    wchar_t audit_path[MAX_PATH];
    wchar_t rollback_path[MAX_PATH];
    swprintf_s(artifact_path, sizeof(artifact_path) / sizeof(artifact_path[0]), L"%s\\office-plan-%s.md", artifacts_dir, batch_id);
    swprintf_s(audit_path, sizeof(audit_path) / sizeof(audit_path[0]), L"%s\\audit.jsonl", audit_dir);
    swprintf_s(rollback_path, sizeof(rollback_path) / sizeof(rollback_path[0]), L"%s\\rollback-%s.jsonl", rollback_dir, batch_id);

    if (GetFileAttributesW(artifact_path) != INVALID_FILE_ATTRIBUTES || GetFileAttributesW(rollback_path) != INVALID_FILE_ATTRIBUTES) {
        wcsncpy_s(error, error_len, L"产物文件已存在，已停止以避免覆盖。", _TRUNCATE);
        return false;
    }

    FILE *artifact = NULL;
    if (_wfopen_s(&artifact, artifact_path, L"w, ccs=UTF-8") != 0 || !artifact) {
        wcsncpy_s(error, error_len, L"无法写入 Markdown 产物。", _TRUNCATE);
        return false;
    }
    fwprintf(
        artifact,
        L"# Agent Cowork Office Mode 产物\n\n"
        L"- Batch ID: %s\n"
        L"- Trusted Workspace: %s\n"
        L"- Template: %s\n"
        L"- Scanned Files: %d\n"
        L"- Safety: approval required, no overwrite, no delete, no upload\n\n"
        L"## Approved Plan\n\n%s\n",
        batch_id,
        g_app.trusted_root,
        KCW_TEMPLATES[g_app.selected_template],
        g_app.file_count,
        plan_text);
    fclose(artifact);

    FILE *audit = NULL;
    if (_wfopen_s(&audit, audit_path, L"a, ccs=UTF-8") != 0 || !audit) {
        wcsncpy_s(error, error_len, L"产物已写入，但审计日志写入失败。", _TRUNCATE);
        return false;
    }
    fwprintf(audit, L"{\"event\":\"approval_apply\",\"batch_id\":");
    kcw_json_write_string(audit, batch_id);
    fwprintf(audit, L",\"template\":");
    kcw_json_write_string(audit, KCW_TEMPLATES[g_app.selected_template]);
    fwprintf(audit, L",\"trusted_root\":");
    kcw_json_write_string(audit, g_app.trusted_root);
    fwprintf(audit, L",\"artifact_path\":");
    kcw_json_write_string(audit, artifact_path);
    fwprintf(audit, L",\"scanned_files\":%d,\"status\":\"done\"}\n", g_app.file_count);
    fclose(audit);

    FILE *rollback = NULL;
    if (_wfopen_s(&rollback, rollback_path, L"w, ccs=UTF-8") != 0 || !rollback) {
        wcsncpy_s(error, error_len, L"产物和审计已写入，但回滚日志写入失败。", _TRUNCATE);
        return false;
    }
    fwprintf(rollback, L"{\"batch_id\":");
    kcw_json_write_string(rollback, batch_id);
    fwprintf(rollback, L",\"operation\":\"write_new_artifact\",\"artifact_path\":");
    kcw_json_write_string(rollback, artifact_path);
    fwprintf(rollback, L",\"rollback\":\"remove_created_artifact_after_user_confirmation\",\"status\":\"ready\"}\n");
    fclose(rollback);

    wcsncpy_s(g_app.last_artifact_path, sizeof(g_app.last_artifact_path) / sizeof(g_app.last_artifact_path[0]), artifact_path, _TRUNCATE);
    wcsncpy_s(g_app.last_audit_path, sizeof(g_app.last_audit_path) / sizeof(g_app.last_audit_path[0]), audit_path, _TRUNCATE);
    wcsncpy_s(g_app.last_rollback_path, sizeof(g_app.last_rollback_path) / sizeof(g_app.last_rollback_path[0]), rollback_path, _TRUNCATE);
    return true;
}

static bool kcw_apply_pending_move(wchar_t *error, size_t error_len) {
    if (!g_app.pending_move_ready) {
        wcsncpy_s(error, error_len, L"没有可执行的文件移动预览。", _TRUNCATE);
        return false;
    }
    if (g_app.last_audit_path[0] == L'\0' || g_app.last_rollback_path[0] == L'\0') {
        wcsncpy_s(error, error_len, L"缺少审计或回滚日志路径。", _TRUNCATE);
        return false;
    }
    if (GetFileAttributesW(g_app.pending_move_from) == INVALID_FILE_ATTRIBUTES) {
        wcsncpy_s(error, error_len, L"源文件不存在，文件移动已取消。", _TRUNCATE);
        return false;
    }
    if (GetFileAttributesW(g_app.pending_move_to) != INVALID_FILE_ATTRIBUTES) {
        wcsncpy_s(error, error_len, L"目标文件已存在，文件移动已取消以避免覆盖。", _TRUNCATE);
        return false;
    }

    wchar_t move_root[MAX_PATH];
    wchar_t move_template_dir[MAX_PATH];
    swprintf_s(move_root, sizeof(move_root) / sizeof(move_root[0]), L"%s\\Agent_Cowork整理", g_app.trusted_root);
    swprintf_s(move_template_dir, sizeof(move_template_dir) / sizeof(move_template_dir[0]), L"%s\\%s", move_root, KCW_TEMPLATES[g_app.selected_template]);
    if (!kcw_ensure_directory(move_root) || !kcw_ensure_directory(move_template_dir)) {
        wcsncpy_s(error, error_len, L"无法创建目标整理目录。", _TRUNCATE);
        return false;
    }

    FILE *audit = NULL;
    if (_wfopen_s(&audit, g_app.last_audit_path, L"a, ccs=UTF-8") != 0 || !audit) {
        wcsncpy_s(error, error_len, L"无法打开审计日志，文件移动已取消。", _TRUNCATE);
        return false;
    }
    FILE *rollback = NULL;
    if (_wfopen_s(&rollback, g_app.last_rollback_path, L"a, ccs=UTF-8") != 0 || !rollback) {
        fclose(audit);
        wcsncpy_s(error, error_len, L"无法打开回滚日志，文件移动已取消。", _TRUNCATE);
        return false;
    }

    if (!MoveFileExW(g_app.pending_move_from, g_app.pending_move_to, MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH)) {
        fclose(audit);
        fclose(rollback);
        swprintf_s(error, error_len, L"文件移动失败，Windows 错误码：%lu。", GetLastError());
        return false;
    }

    fwprintf(audit, L"{\"event\":\"file_move_apply\",\"from\":");
    kcw_json_write_string(audit, g_app.pending_move_from);
    fwprintf(audit, L",\"to\":");
    kcw_json_write_string(audit, g_app.pending_move_to);
    fwprintf(audit, L",\"status\":\"done\"}\n");
    fclose(audit);

    fwprintf(rollback, L"{\"operation\":\"move_file\",\"from\":");
    kcw_json_write_string(rollback, g_app.pending_move_to);
    fwprintf(rollback, L",\"to\":");
    kcw_json_write_string(rollback, g_app.pending_move_from);
    fwprintf(rollback, L",\"rollback\":\"move_back_after_user_confirmation\",\"status\":\"ready\"}\n");
    fclose(rollback);

    return true;
}

static void kcw_show_workspace_ready(void) {
    kcw_scan_trusted_root();

    wchar_t message[2048];
    swprintf_s(
        message,
        sizeof(message) / sizeof(message[0]),
        L"工作区：%s\r\n\r\nOffice Mode 已准备好。\r\n\r\n1. 选择文件或文件夹作为上下文\r\n2. 选择任务模板\r\n3. 生成计划并在审批中心确认\r\n4. 输出 Markdown / CSV / XLSX 草稿，默认不覆盖原文件",
        g_app.trusted_root);
    SetWindowTextW(g_app.artifact_edit, message);
}

static void kcw_select_workspace(HWND window) {
    BROWSEINFOW browse = {0};
    browse.hwndOwner = window;
    browse.lpszTitle = L"选择 Agent Cowork 信任工作区";
    browse.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;

    PIDLIST_ABSOLUTE list = SHBrowseForFolderW(&browse);
    if (!list) {
        return;
    }

    if (SHGetPathFromIDListW(list, g_app.trusted_root)) {
        kcw_show_workspace_ready();
    }

    CoTaskMemFree(list);
    InvalidateRect(window, NULL, TRUE);
}

static void kcw_generate_plan(HWND window) {
    wchar_t prompt[1024] = L"";
    GetWindowTextW(g_app.prompt_edit, prompt, (int)(sizeof(prompt) / sizeof(prompt[0])));

    if (prompt[0] == L'\0') {
        wcsncpy_s(prompt, sizeof(prompt) / sizeof(prompt[0]), L"总结当前工作区文档，生成可审批的整理计划。", _TRUNCATE);
    }

    const wchar_t *root = g_app.trusted_root[0] ? g_app.trusted_root : L"尚未选择";
    const wchar_t *template_name = KCW_TEMPLATES[g_app.selected_template];

    wchar_t context_summary[2500];
    int context_read_count = 0;
    int context_skipped_count = 0;
    kcw_build_context_summary(
        context_summary,
        sizeof(context_summary) / sizeof(context_summary[0]),
        &context_read_count,
        &context_skipped_count);

    wchar_t move_preview[1024];
    if (kcw_build_pending_move_preview()) {
        swprintf_s(
            move_preview,
            sizeof(move_preview) / sizeof(move_preview[0]),
            L"文件操作预览\r\n"
            L"- 类型：move\r\n"
            L"- From：%s\r\n"
            L"- To：%s\r\n"
            L"- 规则：目标存在则停止，不覆盖；审批后写 audit / rollback。\r\n\r\n",
            g_app.pending_move_from_relative,
            g_app.pending_move_to_relative);
    } else {
        swprintf_s(
            move_preview,
            sizeof(move_preview) / sizeof(move_preview[0]),
            L"文件操作预览\r\n"
            L"- 当前没有可移动文件，审批只生成安全产物、审计和回滚日志。\r\n\r\n");
    }

    wchar_t plan[12000];
    swprintf_s(
        plan,
        sizeof(plan) / sizeof(plan[0]),
        L"Agent Cowork 执行计划\r\n\r\n"
        L"模式：Office Mode\r\n"
        L"模型：Kimi API 默认，Developer Mode 可切换 OpenAI-compatible Provider\r\n"
        L"信任工作区：%s\r\n"
        L"任务模板：%s\r\n"
        L"可处理文件：%d\r\n"
        L"已读取摘要文件：%d\r\n"
        L"摘要跳过文件：%d\r\n"
        L"用户任务：%s\r\n\r\n"
        L"%s"
        L"计划步骤\r\n"
        L"1. 只读取信任工作区内的 PDF / DOCX / XLSX / CSV / TXT / Markdown 文件。\r\n"
        L"2. 提取摘要、分类、关键字段和待办事项，生成结构化中间结果。\r\n"
        L"3. 在产物区生成 Markdown / CSV / XLSX 草稿。\r\n"
        L"4. 对重命名和移动操作先生成 diff/preview，不自动执行。\r\n"
        L"5. 等待审批中心确认后再执行本地文件操作，并写入 rollback journal。\r\n\r\n"
        L"%s"
        L"安全边界\r\n"
        L"- 默认禁止 shell、删除、全盘扫描和凭据目录访问。\r\n"
        L"- 所有高风险动作必须审批、审计、可回滚。\r\n",
        root,
        template_name,
        g_app.file_count,
        context_read_count,
        context_skipped_count,
        prompt,
        context_summary,
        move_preview);

    SetWindowTextW(g_app.artifact_edit, plan);
    kcw_set_status(L"计划已生成，等待审批中心确认。");
    InvalidateRect(window, NULL, TRUE);
}

static void kcw_approve_plan(HWND window) {
    if (g_app.trusted_root[0] == L'\0') {
        SetWindowTextW(g_app.artifact_edit, L"请先选择本地信任工作区。审批执行只会写入该工作区内的 .AgentCowork 安全产物目录。");
        kcw_set_status(L"审批被阻止：尚未选择信任工作区。");
        InvalidateRect(window, NULL, TRUE);
        return;
    }

    wchar_t current[12000] = L"";
    GetWindowTextW(g_app.artifact_edit, current, (int)(sizeof(current) / sizeof(current[0])));
    if (wcsstr(current, L"Agent Cowork 执行计划") == NULL) {
        kcw_generate_plan(window);
        GetWindowTextW(g_app.artifact_edit, current, (int)(sizeof(current) / sizeof(current[0])));
    }

    wchar_t error[256] = L"";
    bool wrote_artifact = kcw_write_approved_artifact(current, error, sizeof(error) / sizeof(error[0]));
    bool had_move_preview = g_app.pending_move_ready;
    bool move_applied = false;
    wchar_t move_error[256] = L"";
    wchar_t moved_from_relative[MAX_PATH] = L"";
    wchar_t moved_to_relative[MAX_PATH] = L"";
    if (had_move_preview) {
        wcsncpy_s(moved_from_relative, sizeof(moved_from_relative) / sizeof(moved_from_relative[0]), g_app.pending_move_from_relative, _TRUNCATE);
        wcsncpy_s(moved_to_relative, sizeof(moved_to_relative) / sizeof(moved_to_relative[0]), g_app.pending_move_to_relative, _TRUNCATE);
    }
    if (wrote_artifact && had_move_preview) {
        move_applied = kcw_apply_pending_move(move_error, sizeof(move_error) / sizeof(move_error[0]));
    }

    wchar_t approved[14000];
    if (wrote_artifact) {
        if (had_move_preview && move_applied) {
            swprintf_s(
                approved,
                sizeof(approved) / sizeof(approved[0]),
                L"%s\r\n审批记录\r\n"
                L"- 状态：approved_applied\r\n"
                L"- 已写入 Markdown 产物：%s\r\n"
                L"- 文件操作：move_applied\r\n"
                L"- From：%s\r\n"
                L"- To：%s\r\n"
                L"- 审计日志：%s\r\n"
                L"- 回滚日志：%s\r\n"
                L"- 本轮不覆盖、不删除、不自动上传。\r\n",
                current,
                g_app.last_artifact_path,
                moved_from_relative,
                moved_to_relative,
                g_app.last_audit_path,
                g_app.last_rollback_path);
            kcw_scan_trusted_root();
            kcw_set_status(L"审批已执行：产物、文件移动、审计日志和回滚日志已写入本地工作区。");
        } else if (had_move_preview) {
            swprintf_s(
                approved,
                sizeof(approved) / sizeof(approved[0]),
                L"%s\r\n审批记录\r\n"
                L"- 状态：partial_applied\r\n"
                L"- 已写入 Markdown 产物：%s\r\n"
                L"- 文件操作：move_failed\r\n"
                L"- 原因：%s\r\n"
                L"- 审计日志：%s\r\n"
                L"- 回滚日志：%s\r\n"
                L"- 未覆盖、未删除、未上传任何用户文件。\r\n",
                current,
                g_app.last_artifact_path,
                move_error[0] ? move_error : L"未知错误",
                g_app.last_audit_path,
                g_app.last_rollback_path);
            kcw_set_status(L"审批部分执行：产物已写入，文件移动被阻止。");
        } else {
            swprintf_s(
                approved,
                sizeof(approved) / sizeof(approved[0]),
                L"%s\r\n审批记录\r\n"
                L"- 状态：approved_applied\r\n"
                L"- 已写入 Markdown 产物：%s\r\n"
                L"- 文件操作：no_preview\r\n"
                L"- 审计日志：%s\r\n"
                L"- 回滚日志：%s\r\n"
                L"- 本轮不覆盖、不删除、不自动上传。\r\n",
                current,
                g_app.last_artifact_path,
                g_app.last_audit_path,
                g_app.last_rollback_path);
            kcw_set_status(L"审批已执行：产物、审计日志和回滚日志已写入本地工作区。");
        }
    } else {
        swprintf_s(
            approved,
            sizeof(approved) / sizeof(approved[0]),
            L"%s\r\n审批记录\r\n- 状态：apply_failed\r\n- 原因：%s\r\n- 未覆盖、未删除、未上传任何用户文件。\r\n",
            current,
            error[0] ? error : L"未知错误");
        kcw_set_status(L"审批执行失败，未改动用户文件。");
    }
    SetWindowTextW(g_app.artifact_edit, approved);
    InvalidateRect(window, NULL, TRUE);
}

static void kcw_create_controls(HWND window) {
    g_app.new_chat_button = kcw_create_owner_button(window, KCW_ID_NEW_CHAT, L"+  新建会话");
    g_app.browse_button = kcw_create_owner_button(window, KCW_ID_BROWSE, L"+  选择本地文件夹");
    g_app.run_button = kcw_create_owner_button(window, KCW_ID_RUN, L"生成计划");
    g_app.approve_button = kcw_create_owner_button(window, KCW_ID_APPROVE, L"审批执行");
    g_app.developer_button = kcw_create_owner_button(window, KCW_ID_DEVELOPER, L"Developer Mode");
    g_app.browser_button = kcw_create_owner_button(window, KCW_ID_BROWSER, L"浏览器视图");

    for (int i = 0; i < KCW_TEMPLATE_COUNT; i++) {
        g_app.template_buttons[i] = kcw_create_owner_button(window, KCW_ID_TEMPLATE_BASE + i, KCW_TEMPLATES[i]);
    }

    g_app.prompt_edit = CreateWindowExW(
        0,
        L"EDIT",
        L"输入 “/” 可快速使用技能，例如：帮我整理这个文件夹并生成归档建议",
        WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN,
        0,
        0,
        1,
        1,
        window,
        (HMENU)(INT_PTR)KCW_ID_PROMPT,
        GetModuleHandleW(NULL),
        NULL);
    SendMessageW(g_app.prompt_edit, WM_SETFONT, (WPARAM)g_app.font_ui, TRUE);
    SendMessageW(g_app.prompt_edit, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(0, 0));

    g_app.file_list = CreateWindowExW(
        0,
        L"LISTBOX",
        NULL,
        WS_CHILD | WS_VISIBLE | LBS_NOTIFY | WS_VSCROLL,
        0,
        0,
        1,
        1,
        window,
        (HMENU)(INT_PTR)KCW_ID_FILE_LIST,
        GetModuleHandleW(NULL),
        NULL);
    SendMessageW(g_app.file_list, WM_SETFONT, (WPARAM)g_app.font_small, TRUE);
    SendMessageW(g_app.file_list, LB_SETITEMHEIGHT, 0, 24);

    g_app.artifact_edit = CreateWindowExW(
        0,
        L"EDIT",
        L"选择一个信任工作区后，Agent Cowork 会在这里显示计划、审批项、产物草稿和审计摘要。",
        WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL,
        0,
        0,
        1,
        1,
        window,
        (HMENU)(INT_PTR)KCW_ID_ARTIFACT,
        GetModuleHandleW(NULL),
        NULL);
    SendMessageW(g_app.artifact_edit, WM_SETFONT, (WPARAM)g_app.font_small, TRUE);
    SendMessageW(g_app.artifact_edit, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(0, 0));
}

static void kcw_layout_controls(HWND window) {
    RECT client;
    GetClientRect(window, &client);
    int width = client.right - client.left;
    int height = client.bottom - client.top;

    int sidebar = kcw_min_int(304, kcw_max_int(272, width / 5));
    int content_x = sidebar + 8;
    int content_w = kcw_max_int(560, width - content_x - 8);
    int card_x = content_x + 24;
    int card_w = content_w - 48;
    bool compact = height < 780;
    int prompt_w = kcw_min_int(960, card_w - 96);
    int prompt_x = content_x + (content_w - prompt_w) / 2;
    int brand_y = compact ? 92 : kcw_max_int(118, height / 4);
    int prompt_y = brand_y + (compact ? 96 : 130);
    int prompt_h = compact ? 132 : 148;
    int template_y = prompt_y + prompt_h + (compact ? 16 : 22);
    int bottom_y = template_y + (compact ? 76 : 86);
    int panel_h = kcw_max_int(172, height - bottom_y - 42);
    int left_panel_w = kcw_min_int(392, kcw_max_int(320, (card_w - 18) / 3));

    MoveWindow(g_app.new_chat_button, 14, compact ? 112 : 118, sidebar - 28, compact ? 42 : 46, TRUE);
    MoveWindow(g_app.developer_button, 14, compact ? height - 120 : height - 108, sidebar - 28, 42, TRUE);
    MoveWindow(g_app.browser_button, 14, compact ? height - 170 : height - 160, sidebar - 28, 42, TRUE);
    MoveWindow(g_app.browse_button, 14, compact ? height - 70 : height - 214, sidebar - 28, 42, TRUE);

    if (g_app.webview_visible) {
        ShowWindow(g_app.prompt_edit, SW_HIDE);
        ShowWindow(g_app.run_button, SW_HIDE);
        ShowWindow(g_app.approve_button, SW_HIDE);
        ShowWindow(g_app.file_list, SW_HIDE);
        ShowWindow(g_app.artifact_edit, SW_HIDE);
        for (int i = 0; i < KCW_TEMPLATE_COUNT; i++) ShowWindow(g_app.template_buttons[i], SW_HIDE);
        kcw_webview_resize(content_x, 8, content_w, height - 16);
    } else {
        ShowWindow(g_app.prompt_edit, SW_SHOW);
        ShowWindow(g_app.run_button, SW_SHOW);
        ShowWindow(g_app.approve_button, SW_SHOW);
        ShowWindow(g_app.file_list, SW_SHOW);
        ShowWindow(g_app.artifact_edit, SW_SHOW);
        for (int i = 0; i < KCW_TEMPLATE_COUNT; i++) ShowWindow(g_app.template_buttons[i], SW_SHOW);

        MoveWindow(g_app.prompt_edit, prompt_x + 26, prompt_y + 26, prompt_w - 52, 58, TRUE);
        MoveWindow(g_app.run_button, prompt_x + prompt_w - 300, prompt_y + prompt_h - 54, 132, 36, TRUE);
        MoveWindow(g_app.approve_button, prompt_x + prompt_w - 158, prompt_y + prompt_h - 54, 132, 36, TRUE);

        int template_w = 118;
        int template_gap = 10;
        int template_group_w = template_w * 4 + template_gap * 3;
        int template_x = content_x + (content_w - template_group_w) / 2;
        for (int i = 0; i < KCW_TEMPLATE_COUNT; i++) {
            int row = i / 4;
            int col = i % 4;
            MoveWindow(g_app.template_buttons[i], template_x + col * (template_w + template_gap), template_y + row * 40, template_w, 34, TRUE);
        }

        int file_panel_x = card_x;
        int file_panel_y = bottom_y;
        int file_panel_h = panel_h;
        int artifact_x = file_panel_x + left_panel_w + 18;
        int artifact_w = card_w - left_panel_w - 18;
        MoveWindow(g_app.file_list, file_panel_x + 20, file_panel_y + 58, left_panel_w - 40, file_panel_h - 82, TRUE);
        MoveWindow(g_app.artifact_edit, artifact_x + 20, file_panel_y + 58, artifact_w - 40, file_panel_h - 82, TRUE);
    }
}

static void kcw_draw_sidebar(HDC dc, RECT client, int sidebar) {
    bool compact = client.bottom < 780;
    RECT sidebar_rect = {0, 0, sidebar, client.bottom};
    FillRect(dc, &sidebar_rect, g_app.brush_bg);

    RECT logo_rect = {18, 28, 54, 64};
    kcw_draw_round_rect(dc, logo_rect, KCW_COLOR_BLACK, KCW_COLOR_BLACK, 10);
    kcw_draw_text(dc, g_app.font_ui_bold, L"K", logo_rect, RGB(255, 255, 255), DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    RECT dot = {45, 30, 53, 38};
    kcw_draw_round_rect(dc, dot, RGB(48, 126, 255), RGB(48, 126, 255), 8);

    RECT collapse = {sidebar - 48, 28, sidebar - 18, 56};
    kcw_draw_text(dc, g_app.font_ui, L"▱", collapse, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT tabs = {14, 76, sidebar - 14, 110};
    kcw_draw_round_rect(dc, tabs, RGB(242, 243, 245), RGB(242, 243, 245), 14);
    int tab_w = (tabs.right - tabs.left) / 3;
    RECT active_tab = {tabs.left + tab_w, tabs.top + 2, tabs.left + tab_w * 2, tabs.bottom - 2};
    kcw_draw_round_rect(dc, active_tab, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 12);
    RECT tab_chat = {tabs.left, tabs.top, tabs.left + tab_w, tabs.bottom};
    RECT tab_cowork = {tabs.left + tab_w, tabs.top, tabs.left + tab_w * 2, tabs.bottom};
    RECT tab_code = {tabs.left + tab_w * 2, tabs.top, tabs.right, tabs.bottom};
    kcw_draw_text(dc, g_app.font_small, L"Chat", tab_chat, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    kcw_draw_text(dc, g_app.font_small, L"Cowork", tab_cowork, KCW_COLOR_TEXT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    kcw_draw_text(dc, g_app.font_small, L"Code", tab_code, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    int y = compact ? 176 : 190;
    for (int i = 0; i < KCW_NAV_COUNT; i++) {
        RECT icon = {22, y + 6, 42, y + 28};
        RECT row = {54, y, sidebar - 22, y + 34};
        COLORREF color = i >= 5 ? KCW_COLOR_TEXT : KCW_COLOR_MUTED;
        HFONT font = i >= 5 ? g_app.font_ui_bold : g_app.font_ui;

        if (i == KCW_NAV_COUNT - 1) {
            RECT selected = {14, y - 5, sidebar - 14, y + 39};
            kcw_draw_round_rect(dc, selected, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 15);
        }

        if (i == KCW_NAV_COUNT - 1) {
            kcw_draw_round_rect(dc, icon, KCW_COLOR_ACCENT_SOFT, RGB(255, 225, 220), 10);
            kcw_draw_text(dc, g_app.font_micro, KCW_NAV_ICONS[i], icon, KCW_COLOR_ACCENT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        } else {
            kcw_draw_text(dc, g_app.font_small, KCW_NAV_ICONS[i], icon, color, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        }
        kcw_draw_text(dc, font, KCW_NAV_ITEMS[i], row, color, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
        y += i == 4 ? (compact ? 32 : 42) : (compact ? 34 : 40);
    }

    if (compact) {
        return;
    }

    RECT recent_title = {22, client.bottom - 318, sidebar - 22, client.bottom - 294};
    kcw_draw_text(dc, g_app.font_small, L"历史会话", recent_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

    RECT recent1 = {54, client.bottom - 280, sidebar - 24, client.bottom - 258};
    RECT recent2 = {54, client.bottom - 242, sidebar - 24, client.bottom - 220};
    kcw_draw_text(dc, g_app.font_small, L"Agent 岗位要点", recent1, KCW_COLOR_MUTED, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
    kcw_draw_text(dc, g_app.font_small, L"合同摘要与归档", recent2, KCW_COLOR_MUTED, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

    RECT workspace_title = {22, client.bottom - 174, sidebar - 22, client.bottom - 150};
    kcw_draw_text(dc, g_app.font_small, L"当前工作区", workspace_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

    RECT root_rect = {22, client.bottom - 146, sidebar - 22, client.bottom - 112};
    const wchar_t *root = g_app.trusted_root[0] ? g_app.trusted_root : L"尚未选择本地文件夹";
    kcw_draw_text(dc, g_app.font_small, root, root_rect, KCW_COLOR_MUTED, DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);

    RECT user = {22, client.bottom - 44, sidebar - 22, client.bottom - 18};
    kcw_draw_text(dc, g_app.font_small, L"~  Allegretto", user, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
}

static void kcw_draw_main(HDC dc, RECT client, int sidebar) {
    int content_x = sidebar + 8;
    int content_w = client.right - content_x - 8;
    RECT main_card = {content_x, 48, client.right - 8, client.bottom - 10};
    kcw_draw_round_rect(dc, main_card, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 14);

    int card_x = content_x + 24;
    int card_w = content_w - 48;
    bool compact = client.bottom < 780;
    int prompt_w = kcw_min_int(960, card_w - 96);
    int prompt_x = content_x + (content_w - prompt_w) / 2;
    int brand_y = compact ? 92 : kcw_max_int(118, client.bottom / 4);
    int prompt_y = brand_y + (compact ? 96 : 130);
    int prompt_h = compact ? 132 : 148;
    int template_y = prompt_y + prompt_h + (compact ? 16 : 22);
    int bottom_y = template_y + (compact ? 76 : 86);
    int panel_h = kcw_max_int(172, client.bottom - bottom_y - 42);
    int left_panel_w = kcw_min_int(392, kcw_max_int(320, (card_w - 18) / 3));
    int file_panel_x = card_x;
    int artifact_x = file_panel_x + left_panel_w + 18;
    int artifact_w = card_w - left_panel_w - 18;

    RECT top_status = {main_card.left + 22, main_card.top + 14, main_card.right - 22, main_card.top + 42};
    RECT local_badge = {top_status.left, top_status.top + 2, top_status.left + 94, top_status.bottom - 2};
    RECT policy_badge = {local_badge.right + 8, top_status.top + 2, local_badge.right + 118, top_status.bottom - 2};
    RECT model_badge = {top_status.right - 138, top_status.top + 2, top_status.right, top_status.bottom - 2};
    kcw_draw_badge(dc, local_badge, L"Local First", RGB(244, 246, 249), RGB(234, 236, 240), KCW_COLOR_MUTED);
    kcw_draw_badge(dc, policy_badge, L"审批后执行", KCW_COLOR_ACCENT_SOFT, RGB(255, 224, 220), RGB(194, 64, 55));
    kcw_draw_badge(dc, model_badge, L"Kimi API 默认", RGB(244, 246, 249), RGB(234, 236, 240), KCW_COLOR_MUTED);

    RECT brand = {content_x, brand_y, client.right - 8, brand_y + 76};
    kcw_draw_text(dc, g_app.font_brand, L"KIMI", brand, RGB(0, 0, 0), DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT sub = {content_x, brand_y + 78, client.right - 8, brand_y + 106};
    kcw_draw_text(dc, g_app.font_small, L"Cowork · 本地文件工作台 · Office Mode", sub, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT prompt_card = {prompt_x, prompt_y, prompt_x + prompt_w, prompt_y + prompt_h};
    kcw_draw_soft_shadow(dc, prompt_card, 30);
    kcw_draw_round_rect(dc, prompt_card, KCW_COLOR_SURFACE, RGB(204, 209, 216), 30);
    RECT prompt_inner_line = {prompt_card.left + 18, prompt_card.bottom - 62, prompt_card.right - 18, prompt_card.bottom - 61};
    kcw_draw_line(dc, prompt_inner_line.left, prompt_inner_line.top, prompt_inner_line.right, prompt_inner_line.top, RGB(241, 242, 244));

    RECT plus = {prompt_x + 20, prompt_y + prompt_h - 54, prompt_x + 58, prompt_y + prompt_h - 16};
    kcw_draw_round_rect(dc, plus, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 18);
    kcw_draw_text(dc, g_app.font_title, L"+", plus, KCW_COLOR_TEXT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT agent = {prompt_x + 70, prompt_y + prompt_h - 54, prompt_x + 158, prompt_y + prompt_h - 16};
    kcw_draw_round_rect(dc, agent, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 18);
    kcw_draw_text(dc, g_app.font_small, L"Agent", agent, KCW_COLOR_TEXT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT model = {prompt_x + prompt_w - 464, prompt_y + prompt_h - 54, prompt_x + prompt_w - 310, prompt_y + prompt_h - 16};
    kcw_draw_text(dc, g_app.font_ui, L"K2.6 思考⌄", model, KCW_COLOR_TEXT, DT_RIGHT | DT_VCENTER | DT_SINGLELINE);

    RECT ai = {prompt_x + prompt_w + 8, prompt_y + prompt_h - 60, prompt_x + prompt_w + 48, prompt_y + prompt_h - 20};
    kcw_draw_round_rect(dc, ai, KCW_COLOR_ACCENT, KCW_COLOR_ACCENT, 14);
    kcw_draw_text(dc, g_app.font_ui_bold, L"AI", ai, RGB(255, 255, 255), DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT tray_title = {card_x, template_y - 26, card_x + card_w, template_y - 6};
    kcw_draw_text(dc, g_app.font_micro, L"常用办公技能", tray_title, KCW_COLOR_FAINT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    int file_panel_y = bottom_y;
    RECT file_panel = {file_panel_x, file_panel_y, file_panel_x + left_panel_w, file_panel_y + panel_h};
    RECT artifact_panel = {artifact_x, file_panel_y, artifact_x + artifact_w, file_panel_y + panel_h};
    kcw_draw_round_rect(dc, file_panel, KCW_COLOR_PANEL, KCW_COLOR_BORDER, 16);
    kcw_draw_round_rect(dc, artifact_panel, KCW_COLOR_PANEL, KCW_COLOR_BORDER, 16);

    RECT file_title = {file_panel.left + 20, file_panel.top + 14, file_panel.right - 20, file_panel.top + 40};
    wchar_t file_label[96];
    swprintf_s(file_label, sizeof(file_label) / sizeof(file_label[0]), L"本地文件  %d", g_app.file_count);
    kcw_draw_text(dc, g_app.font_ui_bold, file_label, file_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    RECT file_caption = {file_panel.left + 20, file_panel.top + 38, file_panel.right - 20, file_panel.top + 56};
    kcw_draw_text(dc, g_app.font_micro, L"只读取已信任目录，默认禁止全盘扫描", file_caption, KCW_COLOR_FAINT, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

    RECT artifact_title = {artifact_panel.left + 20, artifact_panel.top + 14, artifact_panel.right - 20, artifact_panel.top + 40};
    kcw_draw_text(dc, g_app.font_ui_bold, L"计划 / 产物 / 审批", artifact_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
    RECT artifact_caption = {artifact_panel.left + 20, artifact_panel.top + 38, artifact_panel.right - 20, artifact_panel.top + 56};
    kcw_draw_text(dc, g_app.font_micro, L"生成草稿、预览 diff、审批后才执行本地操作", artifact_caption, KCW_COLOR_FAINT, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

    RECT status = {content_x + 28, client.bottom - 36, client.right - 24, client.bottom - 14};
    kcw_draw_text(dc, g_app.font_small, g_app.status_line, status, KCW_COLOR_MUTED, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
}

static void kcw_paint(HWND window) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);

    RECT client;
    GetClientRect(window, &client);
    FillRect(dc, &client, g_app.brush_bg);

    int sidebar = kcw_min_int(300, kcw_max_int(260, (client.right - client.left) / 5));
    kcw_draw_sidebar(dc, client, sidebar);
    kcw_draw_main(dc, client, sidebar);

    EndPaint(window, &paint);
}

static void kcw_init_resources(void) {
    g_app.font_ui = kcw_create_font(17, FW_NORMAL);
    g_app.font_ui_bold = kcw_create_font(17, FW_SEMIBOLD);
    g_app.font_small = kcw_create_font(14, FW_NORMAL);
    g_app.font_micro = kcw_create_font(12, FW_NORMAL);
    g_app.font_heading = kcw_create_font(20, FW_SEMIBOLD);
    g_app.font_brand = kcw_create_named_font(68, FW_HEAVY, L"Arial Black");
    g_app.font_title = kcw_create_font(24, FW_NORMAL);
    g_app.brush_bg = CreateSolidBrush(KCW_COLOR_BG);
    g_app.brush_surface = CreateSolidBrush(KCW_COLOR_SURFACE);
    g_app.brush_panel = CreateSolidBrush(KCW_COLOR_PANEL);
    g_app.selected_template = 0;
    kcw_set_status(L"Office Mode 就绪。请选择一个本地工作区开始。");
}

static void kcw_destroy_resources(void) {
    DeleteObject(g_app.font_ui);
    DeleteObject(g_app.font_ui_bold);
    DeleteObject(g_app.font_small);
    DeleteObject(g_app.font_micro);
    DeleteObject(g_app.font_heading);
    DeleteObject(g_app.font_brand);
    DeleteObject(g_app.font_title);
    DeleteObject(g_app.brush_bg);
    DeleteObject(g_app.brush_surface);
    DeleteObject(g_app.brush_panel);
}

static LRESULT CALLBACK kcw_window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_CREATE:
        kcw_init_resources();
        kcw_native_bridge_init(window);
        kcw_create_controls(window);
        kcw_layout_controls(window);
        kcw_detect_initial_workspace();
        if (g_initial_workspace[0] != L'\0') {
            wcsncpy_s(g_app.trusted_root, sizeof(g_app.trusted_root) / sizeof(g_app.trusted_root[0]), g_initial_workspace, _TRUNCATE);
            kcw_show_workspace_ready();
        }
        return 0;

    case WM_SIZE:
        kcw_layout_controls(window);
        InvalidateRect(window, NULL, TRUE);
        return 0;

    case WM_PAINT:
        kcw_paint(window);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORLISTBOX: {
        HDC dc = (HDC)wparam;
        HWND child = (HWND)lparam;
        SetTextColor(dc, KCW_COLOR_TEXT);
        if (child == g_app.file_list || child == g_app.artifact_edit) {
            SetBkColor(dc, KCW_COLOR_PANEL);
            return (LRESULT)g_app.brush_panel;
        }
        if (child == g_app.prompt_edit) {
            SetTextColor(dc, KCW_COLOR_MUTED);
        }
        SetBkColor(dc, KCW_COLOR_SURFACE);
        return (LRESULT)g_app.brush_surface;
    }

    case WM_DRAWITEM:
        kcw_draw_button((const DRAWITEMSTRUCT *)lparam);
        return TRUE;

    case WM_COMMAND: {
        int id = LOWORD(wparam);
        if (id == KCW_ID_BROWSE) {
            kcw_select_workspace(window);
            return 0;
        }
        if (id == KCW_ID_RUN) {
            kcw_generate_plan(window);
            return 0;
        }
        if (id == KCW_ID_APPROVE) {
            kcw_approve_plan(window);
            return 0;
        }
        if (id == KCW_ID_NEW_CHAT) {
            SetWindowTextW(g_app.prompt_edit, L"输入 “/” 可快速使用技能，例如：帮我整理这个文件夹并生成归档建议");
            SetWindowTextW(g_app.artifact_edit, L"新会话已创建。选择本地工作区后，可以开始 Office Mode 任务。");
            kcw_set_status(L"新会话已创建。");
            InvalidateRect(window, NULL, TRUE);
            return 0;
        }
        if (id == KCW_ID_DEVELOPER) {
            SetWindowTextW(
                g_app.artifact_edit,
                L"Developer Mode\r\n\r\n"
                L"- Kimi API：默认模型 Provider\r\n"
                L"- OpenAI-compatible：可配置 base URL / model / API key\r\n"
                L"- Kimi API Gateway / WebBridge：后续作为高级用户能力接入\r\n"
                L"- Shell、MCP、插件、脚本执行默认关闭，必须单独审批\r\n");
            kcw_set_status(L"Developer Mode 面板已打开。");
            InvalidateRect(window, NULL, TRUE);
            return 0;
        }
        if (id == KCW_ID_BROWSER) {
            g_app.webview_visible = !g_app.webview_visible;
            if (g_app.webview_visible) {
                if (!kcw_webview_is_created()) {
                    wchar_t url[512];
                    wcscpy_s(url, sizeof(url)/sizeof(url[0]), L"http://127.0.0.1:3017/");
                    int r = kcw_webview_create(window, url);
                    if (r != 0) {
                        /* fallback to static resource */
                        wchar_t exe_dir[MAX_PATH];
                        GetModuleFileNameW(NULL, exe_dir, MAX_PATH);
                        wchar_t *last_slash = wcsrchr(exe_dir, L'\\');
                        if (last_slash) *last_slash = L'\0';
                        swprintf_s(url, sizeof(url)/sizeof(url[0]), L"file:///%s/resources/app.html", exe_dir);
                        for (wchar_t *p = url; *p; p++) if (*p == L'\\') *p = L'/';
                        kcw_webview_create(window, url);
                    }
                }
                kcw_set_status(L"浏览器视图已打开。");
            } else {
                kcw_set_status(L"已返回原生视图。");
            }
            kcw_layout_controls(window);
            InvalidateRect(window, NULL, TRUE);
            return 0;
        }
        if (kcw_is_template_id(id)) {
            g_app.selected_template = id - KCW_ID_TEMPLATE_BASE;
            wchar_t status[256];
            swprintf_s(status, sizeof(status) / sizeof(status[0]), L"已选择模板：%s。", KCW_TEMPLATES[g_app.selected_template]);
            kcw_set_status(status);
            InvalidateRect(window, NULL, TRUE);
            return 0;
        }
        return 0;
    }

    case WM_DESTROY:
        kcw_webview_destroy();
        kcw_destroy_resources();
        PostQuitMessage(0);
        return 0;

    default:
        return DefWindowProcW(window, message, wparam, lparam);
    }
}

int kcw_run_app(HINSTANCE instance, int show_command) {
    return kcw_run_app_with_workspace(instance, show_command, NULL);
}

int kcw_run_app_with_workspace(HINSTANCE instance, int show_command, const wchar_t *initial_workspace) {
    g_initial_workspace[0] = L'\0';
    if (initial_workspace && initial_workspace[0] != L'\0') {
        wcsncpy_s(g_initial_workspace, sizeof(g_initial_workspace) / sizeof(g_initial_workspace[0]), initial_workspace, _TRUNCATE);
    }

    HRESULT com_result = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    WNDCLASSW window_class = {0};
    window_class.lpfnWndProc = kcw_window_proc;
    window_class.hInstance = instance;
    window_class.lpszClassName = KCW_CLASS_NAME;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.hbrBackground = NULL;

    if (!RegisterClassW(&window_class)) {
        if (SUCCEEDED(com_result)) {
            CoUninitialize();
        }
        return 1;
    }

    HWND window = CreateWindowExW(
        0,
        KCW_CLASS_NAME,
        L"Agent Cowork",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1160,
        680,
        NULL,
        NULL,
        instance,
        NULL);

    if (!window) {
        if (SUCCEEDED(com_result)) {
            CoUninitialize();
        }
        return 1;
    }

    ShowWindow(window, show_command);
    UpdateWindow(window);

    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    if (SUCCEEDED(com_result)) {
        CoUninitialize();
    }

    return (int)message.wParam;
}
