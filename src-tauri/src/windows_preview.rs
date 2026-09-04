use std::{
    ffi::c_void,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL,
};
use windows::{
    core::{w, Interface, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IServiceProvider,
                CLSCTX_ALL, COINIT_APARTMENTTHREADED,
            },
            Threading::GetCurrentThreadId,
            Variant::VARIANT,
        },
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_CONTROL, VK_DOWN, VK_ESCAPE, VK_LEFT, VK_LMENU, VK_LWIN,
                VK_MENU, VK_RIGHT, VK_RMENU, VK_RWIN, VK_SHIFT, VK_SPACE, VK_UP,
            },
            Shell::{
                AssocQueryStringW, IFolderView2, IShellBrowser, IShellWindows, IWebBrowser2,
                SID_STopLevelBrowser, ShellExecuteW, ShellWindows, ASSOCF_INIT_IGNOREUNKNOWN,
                ASSOCSTR_FRIENDLYAPPNAME, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                CallNextHookEx, CallWindowProcW, CreateWindowExW, GetClassNameW,
                GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindowRect,
                GetWindowThreadProcessId, KillTimer, PostThreadMessageW, SetTimer,
                SetWindowLongPtrW, SetWindowPos, SetWindowTextW, SetWindowsHookExW, ShowWindow,
                UnhookWindowsHookEx, BS_PUSHBUTTON, GUITHREADINFO, GWLP_WNDPROC, HC_ACTION,
                HWND_NOTOPMOST, HWND_TOPMOST, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, SM_CXSIZE,
                SM_CYSIZE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
                SW_SHOWNOACTIVATE, SW_SHOWNORMAL, WH_KEYBOARD_LL, WINDOW_STYLE, WM_APP, WM_KEYDOWN,
                WM_KEYUP, WM_LBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER, WNDPROC,
                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
            },
        },
    },
};

const WM_QUICKPEEK_OPEN: u32 = WM_APP + 0x51;
const WM_QUICKPEEK_REFRESH: u32 = WM_APP + 0x52;
const WM_QUICKPEEK_HIDE: u32 = WM_APP + 0x53;
const REFRESH_TIMER_ID: usize = 0x5145;
const LOW_MEMORY_DELAY: Duration = Duration::from_secs(30);

static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static SPACE_IS_DOWN: AtomicBool = AtomicBool::new(false);
static ESCAPE_IS_DOWN: AtomicBool = AtomicBool::new(false);
static PREVIEW_IS_VISIBLE: AtomicBool = AtomicBool::new(false);
static PREVIEW_WINDOW_HANDLE: AtomicIsize = AtomicIsize::new(0);
static SHOW_GENERATION: AtomicU32 = AtomicU32::new(0);
static MEMORY_MODE_GENERATION: AtomicU32 = AtomicU32::new(0);
static OPEN_BUTTON_HANDLE: AtomicIsize = AtomicIsize::new(0);
static OPEN_BUTTON_ORIGINAL_PROC: AtomicIsize = AtomicIsize::new(0);
static OPEN_BUTTON_LOGICAL_WIDTH: AtomicU32 = AtomicU32::new(36);
static CURRENT_PREVIEW_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn set_low_memory_mode(app: &AppHandle, low: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(move |webview| {
        let result = (|| -> windows::core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2()? };
            let core: ICoreWebView2_19 = core.cast()?;
            let level = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(if low { 1 } else { 0 });
            unsafe { core.SetMemoryUsageTargetLevel(level)? };

            // Read the value back from WebView2 instead of treating a successful setter call
            // as proof. This keeps diagnostics useful when a runtime accepts the interface but
            // silently ignores an unsupported target level.
            let mut actual = COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(0);
            unsafe { core.MemoryUsageTargetLevel(&mut actual)? };
            if actual != level {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x8000_4005_u32 as i32),
                    format!(
                        "WebView2 内存模式回读不一致（期望 {}，实际 {}）",
                        level.0, actual.0
                    ),
                ));
            }
            crate::diagnostic_log(if low {
                "WebView2 内存模式已确认：Low"
            } else {
                "WebView2 内存模式已确认：Normal"
            });
            Ok(())
        })();
        if let Err(error) = result {
            crate::diagnostic_log(&format!("WebView2 内存模式切换失败：{error}"));
        }
    });
}

pub fn prepare_for_use(app: &AppHandle) {
    MEMORY_MODE_GENERATION.fetch_add(1, Ordering::SeqCst);
    set_low_memory_mode(app, false);
}

pub fn schedule_low_memory(app: AppHandle) {
    let generation = MEMORY_MODE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(LOW_MEMORY_DELAY);
        if MEMORY_MODE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let is_visible = app
            .get_webview_window("main")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        if !is_visible {
            set_low_memory_mode(&app, true);
        }
    });
}

fn window_class_name(window: HWND) -> String {
    let mut buffer = [0_u16; 128];
    let length = unsafe { GetClassNameW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

fn modifier_is_down() -> bool {
    [
        VK_CONTROL, VK_SHIFT, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN,
    ]
    .into_iter()
    .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
}

fn is_navigation_key(key: u32) -> bool {
    [VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN]
        .into_iter()
        .any(|navigation_key| navigation_key.0 as u32 == key)
}

fn is_explorer_file_view_class(class_name: &str) -> bool {
    matches!(
        class_name,
        "DirectUIHWND" | "SysListView32" | "SHELLDLL_DefView"
    )
}

fn explorer_file_view_is_foreground(window: HWND) -> bool {
    let top_level_class = window_class_name(window);
    if top_level_class != "CabinetWClass" && top_level_class != "ExploreWClass" {
        return false;
    }

    let thread_id = unsafe { GetWindowThreadProcessId(window, None) };
    let mut thread_info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(thread_id, &mut thread_info) }.is_err() {
        return false;
    }

    let focus_class = window_class_name(thread_info.hwndFocus);
    is_explorer_file_view_class(&focus_class)
}

fn preview_window_is_foreground(window: HWND) -> bool {
    let preview_window = PREVIEW_WINDOW_HANDLE.load(Ordering::SeqCst);
    preview_window != 0 && window.0 as isize == preview_window
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let message = wparam.0 as u32;
        if !key.flags.contains(LLKHF_INJECTED)
            && is_navigation_key(key.vkCode)
            && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
            && !modifier_is_down()
        {
            let foreground = unsafe { GetForegroundWindow() };
            if explorer_file_view_is_foreground(foreground) {
                let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
                if thread_id != 0 {
                    let _ = unsafe {
                        PostThreadMessageW(thread_id, WM_QUICKPEEK_REFRESH, WPARAM(0), LPARAM(0))
                    };
                }
            }
        }

        if key.vkCode == VK_ESCAPE.0 as u32 && !key.flags.contains(LLKHF_INJECTED) {
            if message == WM_KEYUP || message == WM_SYSKEYUP {
                if ESCAPE_IS_DOWN.swap(false, Ordering::SeqCst) {
                    return LRESULT(1);
                }
            } else if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                if ESCAPE_IS_DOWN.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                let foreground = unsafe { GetForegroundWindow() };
                if PREVIEW_IS_VISIBLE.load(Ordering::SeqCst)
                    && (explorer_file_view_is_foreground(foreground)
                        || preview_window_is_foreground(foreground))
                {
                    ESCAPE_IS_DOWN.store(true, Ordering::SeqCst);
                    let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
                    if thread_id != 0 {
                        let _ = unsafe {
                            PostThreadMessageW(thread_id, WM_QUICKPEEK_HIDE, WPARAM(0), LPARAM(0))
                        };
                    }
                    return LRESULT(1);
                }
            }
        }

        if key.vkCode == VK_SPACE.0 as u32 && !key.flags.contains(LLKHF_INJECTED) {
            if message == WM_KEYUP || message == WM_SYSKEYUP {
                if SPACE_IS_DOWN.swap(false, Ordering::SeqCst) {
                    return LRESULT(1);
                }
            } else if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                if SPACE_IS_DOWN.load(Ordering::SeqCst) {
                    return LRESULT(1);
                }
                if modifier_is_down() {
                    return unsafe { CallNextHookEx(None, code, wparam, lparam) };
                }

                let foreground = unsafe { GetForegroundWindow() };
                if explorer_file_view_is_foreground(foreground) {
                    SPACE_IS_DOWN.store(true, Ordering::SeqCst);
                    let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
                    if thread_id != 0 {
                        let _ = unsafe {
                            PostThreadMessageW(thread_id, WM_QUICKPEEK_OPEN, WPARAM(0), LPARAM(0))
                        };
                    }
                    return LRESULT(1);
                } else if PREVIEW_IS_VISIBLE.load(Ordering::SeqCst)
                    && preview_window_is_foreground(foreground)
                {
                    SPACE_IS_DOWN.store(true, Ordering::SeqCst);
                    let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
                    if thread_id != 0 {
                        let _ = unsafe {
                            PostThreadMessageW(thread_id, WM_QUICKPEEK_HIDE, WPARAM(0), LPARAM(0))
                        };
                    }
                    return LRESULT(1);
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn selected_file(foreground: HWND) -> windows::core::Result<Option<PathBuf>> {
    unsafe {
        let shell_windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        for index in 0..shell_windows.Count()? {
            let dispatch = shell_windows.Item(&VARIANT::from(index))?;
            let browser: IWebBrowser2 = dispatch.cast()?;
            if browser.HWND()?.0 != foreground.0 as isize {
                continue;
            }

            let provider: IServiceProvider = browser.cast()?;
            let shell_browser: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser)?;
            let shell_view = shell_browser.QueryActiveShellView()?;
            let folder_view: IFolderView2 = shell_view.cast()?;
            let selection = folder_view.GetSelection(false)?;
            if selection.GetCount()? == 0 {
                return Ok(None);
            }

            let item = selection.GetItemAt(0)?;
            let display_name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = display_name.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(display_name.0.cast::<c_void>()));
            return Ok(path);
        }
    }

    Ok(None)
}

fn preview_path_store() -> &'static Mutex<Option<PathBuf>> {
    CURRENT_PREVIEW_PATH.get_or_init(|| Mutex::new(None))
}

fn default_application_name(path: &std::path::Path) -> Option<String> {
    if path.is_dir() {
        return Some("文件资源管理器".to_string());
    }
    let extension = path.extension()?.to_str()?;
    let association = HSTRING::from(format!(".{extension}"));
    let mut length = 0_u32;
    unsafe {
        let _ = AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_FRIENDLYAPPNAME,
            &association,
            PCWSTR::null(),
            None,
            &mut length,
        );
    }
    if length <= 1 {
        return None;
    }
    let mut buffer = vec![0_u16; length as usize];
    let result = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_FRIENDLYAPPNAME,
            &association,
            PCWSTR::null(),
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
    };
    if result.is_err() || length <= 1 {
        return None;
    }
    let name = String::from_utf16_lossy(&buffer[..length.saturating_sub(1) as usize]);
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn open_current_preview_with_default_application() {
    let path = preview_path_store()
        .lock()
        .ok()
        .and_then(|path| path.clone());
    let Some(path) = path else {
        return;
    };
    let path = HSTRING::from(path.to_string_lossy().as_ref());
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        crate::diagnostic_log("Windows 默认程序无法打开当前预览目标");
    }
}

fn original_open_button_proc() -> WNDPROC {
    let address = OPEN_BUTTON_ORIGINAL_PROC.load(Ordering::SeqCst);
    if address == 0 {
        None
    } else {
        Some(unsafe {
            std::mem::transmute::<
                isize,
                unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
            >(address)
        })
    }
}

unsafe extern "system" fn open_button_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let result =
        unsafe { CallWindowProcW(original_open_button_proc(), window, message, wparam, lparam) };
    if message == WM_LBUTTONUP {
        open_current_preview_with_default_application();
    }
    result
}

fn install_open_button(preview_window: HWND) {
    if OPEN_BUTTON_HANDLE.load(Ordering::SeqCst) != 0 {
        return;
    }
    let button = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("BUTTON"),
            w!("↗"),
            WS_POPUP | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            0,
            0,
            36,
            24,
            Some(preview_window),
            None,
            None,
            None,
        )
    };
    let Ok(button) = button else {
        crate::diagnostic_log("无法创建标题栏默认程序按钮");
        return;
    };
    let original = unsafe {
        SetWindowLongPtrW(
            button,
            GWLP_WNDPROC,
            open_button_window_proc as *const () as isize,
        )
    };
    OPEN_BUTTON_ORIGINAL_PROC.store(original, Ordering::SeqCst);
    OPEN_BUTTON_HANDLE.store(button.0 as isize, Ordering::SeqCst);
}

fn position_open_button_handles(preview_window: HWND, button: HWND) {
    if !PREVIEW_IS_VISIBLE.load(Ordering::SeqCst) {
        unsafe {
            let _ = ShowWindow(button, SW_HIDE);
        }
        return;
    }
    let mut bounds = RECT::default();
    if unsafe { GetWindowRect(preview_window, &mut bounds) }.is_err() {
        return;
    }
    let dpi = unsafe { GetDpiForWindow(preview_window) }.max(96);
    let scale = dpi as f64 / 96.0;
    let caption_button_width =
        unsafe { GetSystemMetricsForDpi(SM_CXSIZE, dpi) }.max((46.0 * scale).round() as i32);
    let caption_height =
        unsafe { GetSystemMetricsForDpi(SM_CYSIZE, dpi) }.max((30.0 * scale).round() as i32);
    let width = ((OPEN_BUTTON_LOGICAL_WIDTH.load(Ordering::SeqCst) as f64) * scale).round() as i32;
    let horizontal_margin = (8.0 * scale).round() as i32;
    let height = (caption_height - (6.0 * scale).round() as i32).max(22);
    let x = bounds.right - caption_button_width * 3 - horizontal_margin - width;
    let y = bounds.top + ((caption_height - height) / 2).max(1);
    unsafe {
        let _ = SetWindowPos(
            button,
            Some(HWND_TOPMOST),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

pub fn position_open_button(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(preview_window) = window.hwnd() else {
        return;
    };
    let button = OPEN_BUTTON_HANDLE.load(Ordering::SeqCst);
    if button == 0 {
        return;
    }
    position_open_button_handles(preview_window, HWND(button as *mut c_void));
}

pub fn set_preview_target(app: &AppHandle, path: &std::path::Path) {
    if let Ok(mut target) = preview_path_store().lock() {
        *target = Some(path.to_path_buf());
    }
    let application = default_application_name(path);
    let label = application
        .as_deref()
        .map(|application| format!("↗  用 {application} 打开"))
        .unwrap_or_else(|| "↗".to_string());
    let width = if application.is_some() {
        (42 + label.encode_utf16().count() as u32 * 8).clamp(112, 230)
    } else {
        36
    };
    OPEN_BUTTON_LOGICAL_WIDTH.store(width, Ordering::SeqCst);
    let button = OPEN_BUTTON_HANDLE.load(Ordering::SeqCst);
    if button != 0 {
        unsafe {
            let _ = SetWindowTextW(HWND(button as *mut c_void), &HSTRING::from(label));
        }
        position_open_button(app);
    }
}

unsafe fn run_hook_loop(app: AppHandle) -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
    HOOK_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0)? };
    let mut message = MSG::default();
    let mut last_previewed_path: Option<PathBuf> = None;
    let mut refresh_timer_id: Option<usize> = None;

    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
        if message.message == WM_QUICKPEEK_OPEN {
            let is_visible = app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if is_visible {
                crate::hide_preview(&app);
                last_previewed_path = None;
            } else {
                let foreground = unsafe { GetForegroundWindow() };
                if explorer_file_view_is_foreground(foreground) {
                    if let Ok(Some(path)) = selected_file(foreground) {
                        if path.is_file() || path.is_dir() {
                            crate::open_preview_path(&app, path.clone());
                            last_previewed_path = Some(path);
                        }
                    }
                }
            }
        } else if message.message == WM_QUICKPEEK_HIDE {
            crate::hide_preview(&app);
            last_previewed_path = None;
        } else if message.message == WM_QUICKPEEK_REFRESH {
            if refresh_timer_id.is_none() {
                let timer_id = unsafe { SetTimer(None, REFRESH_TIMER_ID, 35, None) };
                if timer_id != 0 {
                    refresh_timer_id = Some(timer_id);
                }
            }
        } else if message.message == WM_TIMER
            && refresh_timer_id.is_some_and(|timer_id| message.wParam.0 == timer_id)
        {
            let timer_id = refresh_timer_id.take().expect("timer ID was checked above");
            let _ = unsafe { KillTimer(None, timer_id) };

            let is_visible = app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            let foreground = unsafe { GetForegroundWindow() };
            if is_visible && explorer_file_view_is_foreground(foreground) {
                if let Ok(Some(path)) = selected_file(foreground) {
                    if (path.is_file() || path.is_dir())
                        && last_previewed_path.as_ref() != Some(&path)
                    {
                        crate::open_preview_path(&app, path.clone());
                        last_previewed_path = Some(path);
                    }
                }
            }
        }
    }

    let _ = unsafe { UnhookWindowsHookEx(hook) };
    unsafe { CoUninitialize() };
    Ok(())
}

pub fn start(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(window_handle) = window.hwnd() {
            PREVIEW_WINDOW_HANDLE.store(window_handle.0 as isize, Ordering::SeqCst);
            install_open_button(window_handle);
        }
    }
    std::thread::spawn(move || {
        if let Err(error) = unsafe { run_hook_loop(app) } {
            eprintln!("无法启动空格预览监听：{error}");
        }
    });
}

pub fn show_without_activation(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(window_handle) = window.hwnd() else {
        return;
    };

    PREVIEW_WINDOW_HANDLE.store(window_handle.0 as isize, Ordering::SeqCst);
    PREVIEW_IS_VISIBLE.store(true, Ordering::SeqCst);
    let generation = SHOW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    unsafe {
        let _ = ShowWindow(window_handle, SW_SHOWNOACTIVATE);
    }
    let shown = unsafe {
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
        SetWindowPos(window_handle, Some(HWND_TOPMOST), 0, 0, 0, 0, flags)
    };
    if shown.is_err() {
        let _ = window.show();
    }
    position_open_button(app);

    let window_handle_value = window_handle.0 as isize;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        if PREVIEW_IS_VISIBLE.load(Ordering::SeqCst)
            && SHOW_GENERATION.load(Ordering::SeqCst) == generation
        {
            let delayed_window = HWND(window_handle_value as *mut c_void);
            unsafe {
                let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
                let _ = SetWindowPos(delayed_window, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
            }
            let button = OPEN_BUTTON_HANDLE.load(Ordering::SeqCst);
            if button != 0 {
                position_open_button_handles(delayed_window, HWND(button as *mut c_void));
            }
        }
    });
}

pub fn clear_topmost(app: &AppHandle) {
    PREVIEW_IS_VISIBLE.store(false, Ordering::SeqCst);
    SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(window_handle) = window.hwnd() else {
        return;
    };

    unsafe {
        let _ = SetWindowPos(
            window_handle,
            Some(HWND_NOTOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

pub fn hide_window(app: &AppHandle) {
    clear_topmost(app);
    let button = OPEN_BUTTON_HANDLE.load(Ordering::SeqCst);
    if button != 0 {
        unsafe {
            let _ = ShowWindow(HWND(button as *mut c_void), SW_HIDE);
        }
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(window_handle) = window.hwnd() else {
        return;
    };
    unsafe {
        let _ = ShowWindow(window_handle, SW_HIDE);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_explorer_file_view_class, is_navigation_key};
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_DOWN, VK_LEFT, VK_RIGHT, VK_UP};

    #[test]
    fn accepts_only_explorer_file_view_controls() {
        for class_name in ["DirectUIHWND", "SysListView32", "SHELLDLL_DefView"] {
            assert!(is_explorer_file_view_class(class_name));
        }
    }

    #[test]
    fn rejects_text_input_and_unknown_controls() {
        for class_name in ["Edit", "RichEditD2DPT", "ComboBox", "", "ToolbarWindow32"] {
            assert!(!is_explorer_file_view_class(class_name));
        }
    }

    #[test]
    fn recognizes_arrow_navigation_keys_only() {
        for key in [VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN] {
            assert!(is_navigation_key(key.0 as u32));
        }
        assert!(!is_navigation_key(b'A' as u32));
    }
}
