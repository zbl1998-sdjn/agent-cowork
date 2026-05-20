#include "app_window.h"
#include "native_bridge.h"

#include <shlobj.h>
#include <stdbool.h>
#include <stdio.h>
#include <wchar.h>

static const wchar_t *KCW_CLASS_NAME = L"KimiCoworkWindow";

#define KCW_MAX_FILES 240
#define KCW_TEMPLATE_COUNT 8
#define KCW_NAV_COUNT 9

#define KCW_ID_NEW_CHAT 1001
#define KCW_ID_BROWSE 1002
#define KCW_ID_RUN 1003
#define KCW_ID_APPROVE 1004
#define KCW_ID_DEVELOPER 1005
#define KCW_ID_PROMPT 2001
#define KCW_ID_FILE_LIST 2002
#define KCW_ID_ARTIFACT 2003
#define KCW_ID_TEMPLATE_BASE 3000

#define KCW_COLOR_BG RGB(248, 249, 250)
#define KCW_COLOR_SURFACE RGB(255, 255, 255)
#define KCW_COLOR_SIDEBAR RGB(247, 248, 250)
#define KCW_COLOR_PANEL RGB(250, 250, 251)
#define KCW_COLOR_BORDER RGB(226, 229, 233)
#define KCW_COLOR_TEXT RGB(24, 26, 29)
#define KCW_COLOR_MUTED RGB(109, 113, 122)
#define KCW_COLOR_SOFT RGB(241, 242, 244)
#define KCW_COLOR_ACCENT RGB(255, 76, 64)
#define KCW_COLOR_BLACK RGB(14, 15, 17)

typedef struct KcwAppState {
    HFONT font_ui;
    HFONT font_ui_bold;
    HFONT font_small;
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
    HWND template_buttons[KCW_TEMPLATE_COUNT];

    wchar_t trusted_root[MAX_PATH];
    wchar_t status_line[256];
    int selected_template;
    int file_count;
} KcwAppState;

static KcwAppState g_app;

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
    L"Kimi Cowork",
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

static HFONT kcw_create_font(int size, int weight) {
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
        L"Segoe UI");
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

static void kcw_draw_text(HDC dc, HFONT font, const wchar_t *text, RECT rect, COLORREF color, UINT format) {
    HFONT old_font = (HFONT)SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color);
    DrawTextW(dc, text, -1, &rect, format);
    SelectObject(dc, old_font);
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

    if (id == KCW_ID_RUN) {
        fill = pressed ? RGB(48, 49, 52) : KCW_COLOR_BLACK;
        border = fill;
        text_color = RGB(255, 255, 255);
    } else if (id == KCW_ID_APPROVE) {
        fill = pressed ? RGB(225, 56, 45) : KCW_COLOR_ACCENT;
        border = fill;
        text_color = RGB(255, 255, 255);
    } else if (id == KCW_ID_BROWSE || id == KCW_ID_NEW_CHAT) {
        fill = pressed ? KCW_COLOR_SOFT : KCW_COLOR_SURFACE;
    } else if (template_selected) {
        fill = KCW_COLOR_BLACK;
        border = KCW_COLOR_BLACK;
        text_color = RGB(255, 255, 255);
    } else if (id == KCW_ID_DEVELOPER) {
        fill = RGB(242, 246, 255);
        border = RGB(213, 224, 250);
    }

    if (focused && id != KCW_ID_RUN && id != KCW_ID_APPROVE && !template_selected) {
        border = RGB(158, 166, 178);
    }

    RECT rect = item->rcItem;
    InflateRect(&rect, -1, -1);
    kcw_draw_round_rect(item->hDC, rect, fill, border, 18);
    kcw_draw_text(item->hDC, g_app.font_ui, text, rect, text_color, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
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

static bool kcw_skip_directory(const wchar_t *name) {
    return _wcsicmp(name, L".git") == 0 || _wcsicmp(name, L"node_modules") == 0 ||
           _wcsicmp(name, L"build") == 0 || _wcsicmp(name, L"dist") == 0 ||
           _wcsicmp(name, L".KimiCowork") == 0;
}

static void kcw_join_path(wchar_t *out, size_t out_len, const wchar_t *base, const wchar_t *child) {
    if (!child || child[0] == L'\0') {
        wcsncpy_s(out, out_len, base, _TRUNCATE);
        return;
    }
    swprintf_s(out, out_len, L"%s\\%s", base, child);
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

    if (g_app.trusted_root[0] == L'\0') {
        return;
    }

    kcw_scan_files_recursive(g_app.trusted_root, L"", 0);

    wchar_t status[256];
    swprintf_s(status, sizeof(status) / sizeof(status[0]), L"已信任工作区，扫描到 %d 个可处理文件。", g_app.file_count);
    kcw_set_status(status);
}

static void kcw_select_workspace(HWND window) {
    BROWSEINFOW browse = {0};
    browse.hwndOwner = window;
    browse.lpszTitle = L"选择 Kimi Cowork 信任工作区";
    browse.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;

    PIDLIST_ABSOLUTE list = SHBrowseForFolderW(&browse);
    if (!list) {
        return;
    }

    if (SHGetPathFromIDListW(list, g_app.trusted_root)) {
        kcw_scan_trusted_root();
        wchar_t message[2048];
        swprintf_s(
            message,
            sizeof(message) / sizeof(message[0]),
            L"工作区：%s\r\n\r\nOffice Mode 已准备好。\r\n\r\n1. 选择文件或文件夹作为上下文\r\n2. 选择任务模板\r\n3. 生成计划并在审批中心确认\r\n4. 输出 Markdown / CSV / XLSX 草稿，默认不覆盖原文件",
            g_app.trusted_root);
        SetWindowTextW(g_app.artifact_edit, message);
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

    wchar_t plan[4096];
    swprintf_s(
        plan,
        sizeof(plan) / sizeof(plan[0]),
        L"Kimi Cowork 执行计划\r\n\r\n"
        L"模式：Office Mode\r\n"
        L"模型：Kimi API 默认，Developer Mode 可切换 OpenAI-compatible Provider\r\n"
        L"信任工作区：%s\r\n"
        L"任务模板：%s\r\n"
        L"可处理文件：%d\r\n"
        L"用户任务：%s\r\n\r\n"
        L"计划步骤\r\n"
        L"1. 只读取信任工作区内的 PDF / DOCX / XLSX / CSV / TXT / Markdown 文件。\r\n"
        L"2. 提取摘要、分类、关键字段和待办事项，生成结构化中间结果。\r\n"
        L"3. 在产物区生成 Markdown / CSV / XLSX 草稿。\r\n"
        L"4. 对重命名和移动操作先生成 diff/preview，不自动执行。\r\n"
        L"5. 等待审批中心确认后再执行本地文件操作，并写入 rollback journal。\r\n\r\n"
        L"安全边界\r\n"
        L"- 默认禁止 shell、删除、全盘扫描和凭据目录访问。\r\n"
        L"- 所有高风险动作必须审批、审计、可回滚。\r\n",
        root,
        template_name,
        g_app.file_count,
        prompt);

    SetWindowTextW(g_app.artifact_edit, plan);
    kcw_set_status(L"计划已生成，等待审批中心确认。");
    InvalidateRect(window, NULL, TRUE);
}

static void kcw_approve_plan(HWND window) {
    wchar_t current[4096] = L"";
    GetWindowTextW(g_app.artifact_edit, current, (int)(sizeof(current) / sizeof(current[0])));
    if (wcsstr(current, L"Kimi Cowork 执行计划") == NULL) {
        kcw_generate_plan(window);
        GetWindowTextW(g_app.artifact_edit, current, (int)(sizeof(current) / sizeof(current[0])));
    }

    wchar_t approved[4096];
    swprintf_s(
        approved,
        sizeof(approved) / sizeof(approved[0]),
        L"%s\r\n审批记录\r\n- 状态：approved\r\n- 本轮仅执行安全预览，不覆盖、不删除、不自动上传。\r\n- 下一步：接入 Go Local Agent 后写入 SQLite task_events / approvals / audit_logs。\r\n",
        current);
    SetWindowTextW(g_app.artifact_edit, approved);
    kcw_set_status(L"审批已记录。当前版本仍处于安全预览阶段。");
    InvalidateRect(window, NULL, TRUE);
}

static void kcw_create_controls(HWND window) {
    g_app.new_chat_button = kcw_create_owner_button(window, KCW_ID_NEW_CHAT, L"+ 新建会话");
    g_app.browse_button = kcw_create_owner_button(window, KCW_ID_BROWSE, L"+ 选择工作区");
    g_app.run_button = kcw_create_owner_button(window, KCW_ID_RUN, L"生成计划");
    g_app.approve_button = kcw_create_owner_button(window, KCW_ID_APPROVE, L"审批执行");
    g_app.developer_button = kcw_create_owner_button(window, KCW_ID_DEVELOPER, L"Developer Mode");

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

    g_app.artifact_edit = CreateWindowExW(
        0,
        L"EDIT",
        L"选择一个信任工作区后，Kimi Cowork 会在这里显示计划、审批项、产物草稿和审计摘要。",
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
}

static void kcw_layout_controls(HWND window) {
    RECT client;
    GetClientRect(window, &client);
    int width = client.right - client.left;
    int height = client.bottom - client.top;

    int sidebar = kcw_min_int(300, kcw_max_int(260, width / 5));
    int content_x = sidebar + 8;
    int content_w = kcw_max_int(520, width - content_x - 8);
    int card_x = content_x + 24;
    int card_w = content_w - 48;
    int prompt_w = kcw_min_int(930, card_w - 80);
    int prompt_x = content_x + (content_w - prompt_w) / 2;
    int brand_y = kcw_max_int(106, height / 4);
    int prompt_y = brand_y + 126;
    int prompt_h = 132;
    int template_y = prompt_y + prompt_h + 18;
    int bottom_y = template_y + 56;
    int panel_h = kcw_max_int(155, height - bottom_y - 38);
    int left_panel_w = kcw_min_int(390, (card_w - 16) / 3);

    MoveWindow(g_app.new_chat_button, 14, 94, sidebar - 28, 42, TRUE);
    MoveWindow(g_app.browse_button, 14, height - 202, sidebar - 28, 42, TRUE);
    MoveWindow(g_app.developer_button, 14, height - 98, sidebar - 28, 42, TRUE);

    MoveWindow(g_app.prompt_edit, prompt_x + 24, prompt_y + 24, prompt_w - 48, 56, TRUE);
    MoveWindow(g_app.run_button, prompt_x + prompt_w - 292, prompt_y + prompt_h - 48, 126, 34, TRUE);
    MoveWindow(g_app.approve_button, prompt_x + prompt_w - 154, prompt_y + prompt_h - 48, 126, 34, TRUE);

    int template_x = prompt_x;
    int template_w = 116;
    int template_gap = 10;
    for (int i = 0; i < KCW_TEMPLATE_COUNT; i++) {
        int row = i / 4;
        int col = i % 4;
        MoveWindow(g_app.template_buttons[i], template_x + col * (template_w + template_gap), template_y + row * 40, template_w, 34, TRUE);
    }

    int file_panel_x = card_x;
    int file_panel_y = bottom_y;
    int file_panel_h = panel_h;
    int artifact_x = file_panel_x + left_panel_w + 16;
    int artifact_w = card_w - left_panel_w - 16;
    MoveWindow(g_app.file_list, file_panel_x + 18, file_panel_y + 48, left_panel_w - 36, file_panel_h - 66, TRUE);
    MoveWindow(g_app.artifact_edit, artifact_x + 18, file_panel_y + 48, artifact_w - 36, file_panel_h - 66, TRUE);
}

static void kcw_draw_sidebar(HDC dc, RECT client, int sidebar) {
    RECT sidebar_rect = {0, 0, sidebar, client.bottom};
    FillRect(dc, &sidebar_rect, g_app.brush_bg);

    RECT logo_rect = {20, 24, 54, 58};
    kcw_draw_round_rect(dc, logo_rect, KCW_COLOR_BLACK, KCW_COLOR_BLACK, 10);
    kcw_draw_text(dc, g_app.font_ui_bold, L"K", logo_rect, RGB(255, 255, 255), DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    RECT dot = {45, 26, 52, 33};
    kcw_draw_round_rect(dc, dot, RGB(63, 141, 255), RGB(63, 141, 255), 7);

    RECT collapse = {sidebar - 48, 28, sidebar - 18, 56};
    kcw_draw_text(dc, g_app.font_ui, L"▣", collapse, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    int y = 162;
    for (int i = 0; i < KCW_NAV_COUNT; i++) {
        RECT row = {22, y, sidebar - 22, y + 32};
        COLORREF color = i >= 5 ? KCW_COLOR_TEXT : KCW_COLOR_MUTED;
        HFONT font = i >= 5 ? g_app.font_ui_bold : g_app.font_ui;

        if (i == KCW_NAV_COUNT - 1) {
            RECT selected = {14, y - 4, sidebar - 14, y + 36};
            kcw_draw_round_rect(dc, selected, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 16);
        }

        wchar_t label[96];
        swprintf_s(label, sizeof(label) / sizeof(label[0]), L"%s%s", i == KCW_NAV_COUNT - 1 ? L"●  " : L"   ", KCW_NAV_ITEMS[i]);
        kcw_draw_text(dc, font, label, row, color, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
        y += i == 4 ? 46 : 50;
    }

    RECT recent_title = {22, client.bottom - 292, sidebar - 22, client.bottom - 266};
    kcw_draw_text(dc, g_app.font_small, L"工作区", recent_title, KCW_COLOR_MUTED, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

    RECT root_rect = {22, client.bottom - 154, sidebar - 22, client.bottom - 114};
    const wchar_t *root = g_app.trusted_root[0] ? g_app.trusted_root : L"尚未选择本地文件夹";
    kcw_draw_text(dc, g_app.font_small, root, root_rect, KCW_COLOR_MUTED, DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);

    RECT user = {22, client.bottom - 44, sidebar - 22, client.bottom - 18};
    kcw_draw_text(dc, g_app.font_small, L"~  Kimi Cowork · Local", user, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
}

static void kcw_draw_main(HDC dc, RECT client, int sidebar) {
    int content_x = sidebar + 8;
    int content_w = client.right - content_x - 8;
    RECT main_card = {content_x, 48, client.right - 8, client.bottom - 10};
    kcw_draw_round_rect(dc, main_card, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 14);

    int card_x = content_x + 24;
    int card_w = content_w - 48;
    int prompt_w = kcw_min_int(930, card_w - 80);
    int prompt_x = content_x + (content_w - prompt_w) / 2;
    int brand_y = kcw_max_int(106, client.bottom / 4);
    int prompt_y = brand_y + 126;
    int prompt_h = 132;
    int template_y = prompt_y + prompt_h + 18;
    int bottom_y = template_y + 56;
    int panel_h = kcw_max_int(155, client.bottom - bottom_y - 38);
    int left_panel_w = kcw_min_int(390, (card_w - 16) / 3);
    int file_panel_x = card_x;
    int artifact_x = file_panel_x + left_panel_w + 16;
    int artifact_w = card_w - left_panel_w - 16;

    RECT brand = {content_x, brand_y, client.right - 8, brand_y + 76};
    kcw_draw_text(dc, g_app.font_brand, L"KIMI", brand, RGB(0, 0, 0), DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT sub = {content_x, brand_y + 74, client.right - 8, brand_y + 104};
    kcw_draw_text(dc, g_app.font_ui, L"Cowork · 本地文件工作台", sub, KCW_COLOR_MUTED, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT prompt_card = {prompt_x, prompt_y, prompt_x + prompt_w, prompt_y + prompt_h};
    kcw_draw_round_rect(dc, prompt_card, KCW_COLOR_SURFACE, RGB(209, 213, 219), 28);

    RECT plus = {prompt_x + 18, prompt_y + prompt_h - 48, prompt_x + 54, prompt_y + prompt_h - 12};
    kcw_draw_round_rect(dc, plus, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 18);
    kcw_draw_text(dc, g_app.font_title, L"+", plus, KCW_COLOR_TEXT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT agent = {prompt_x + 64, prompt_y + prompt_h - 48, prompt_x + 150, prompt_y + prompt_h - 12};
    kcw_draw_round_rect(dc, agent, KCW_COLOR_SURFACE, KCW_COLOR_BORDER, 18);
    kcw_draw_text(dc, g_app.font_small, L"Agent", agent, KCW_COLOR_TEXT, DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    RECT model = {prompt_x + prompt_w - 456, prompt_y + prompt_h - 48, prompt_x + prompt_w - 306, prompt_y + prompt_h - 12};
    kcw_draw_text(dc, g_app.font_ui, L"K2.6 思考⌄", model, KCW_COLOR_TEXT, DT_RIGHT | DT_VCENTER | DT_SINGLELINE);

    RECT ai = {prompt_x + prompt_w + 8, prompt_y + prompt_h - 54, prompt_x + prompt_w + 46, prompt_y + prompt_h - 16};
    kcw_draw_round_rect(dc, ai, KCW_COLOR_ACCENT, KCW_COLOR_ACCENT, 14);
    kcw_draw_text(dc, g_app.font_ui_bold, L"AI", ai, RGB(255, 255, 255), DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    int file_panel_y = bottom_y;
    RECT file_panel = {file_panel_x, file_panel_y, file_panel_x + left_panel_w, file_panel_y + panel_h};
    RECT artifact_panel = {artifact_x, file_panel_y, artifact_x + artifact_w, file_panel_y + panel_h};
    kcw_draw_round_rect(dc, file_panel, KCW_COLOR_PANEL, KCW_COLOR_BORDER, 14);
    kcw_draw_round_rect(dc, artifact_panel, KCW_COLOR_PANEL, KCW_COLOR_BORDER, 14);

    RECT file_title = {file_panel.left + 18, file_panel.top + 12, file_panel.right - 18, file_panel.top + 42};
    wchar_t file_label[96];
    swprintf_s(file_label, sizeof(file_label) / sizeof(file_label[0]), L"本地文件  %d", g_app.file_count);
    kcw_draw_text(dc, g_app.font_ui_bold, file_label, file_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

    RECT artifact_title = {artifact_panel.left + 18, artifact_panel.top + 12, artifact_panel.right - 18, artifact_panel.top + 42};
    kcw_draw_text(dc, g_app.font_ui_bold, L"计划 / 产物 / 审批", artifact_title, KCW_COLOR_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);

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
    g_app.font_ui = kcw_create_font(18, FW_NORMAL);
    g_app.font_ui_bold = kcw_create_font(18, FW_SEMIBOLD);
    g_app.font_small = kcw_create_font(15, FW_NORMAL);
    g_app.font_brand = kcw_create_font(64, FW_BOLD);
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
        return 0;

    case WM_SIZE:
        kcw_layout_controls(window);
        InvalidateRect(window, NULL, TRUE);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORLISTBOX: {
        HDC dc = (HDC)wparam;
        SetTextColor(dc, KCW_COLOR_TEXT);
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
                L"- Kimi CLI / Kimi WebBridge：后续作为高级用户能力接入\r\n"
                L"- Shell、MCP、插件、脚本执行默认关闭，必须单独审批\r\n");
            kcw_set_status(L"Developer Mode 面板已打开。");
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
        kcw_destroy_resources();
        PostQuitMessage(0);
        return 0;

    default:
        return DefWindowProcW(window, message, wparam, lparam);
    }
}

int kcw_run_app(HINSTANCE instance, int show_command) {
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
        L"Kimi Cowork",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1280,
        860,
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
