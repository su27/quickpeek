//! Delayed native feedback. No WebView/JS timer, extra runtime, or resident worker.
//! Every UI operation runs on Tauri's window thread; generations invalidate stale work.
use std::{
    cell::RefCell,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, ClientToScreen, CreateSolidBrush, DeleteObject, DrawTextW, Ellipse,
            EndPaint, FillRect, GetStockObject, InvalidateRect, SelectObject, SetBkMode,
            SetTextColor, UpdateWindow, DEFAULT_GUI_FONT, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
            HGDIOBJ, NULL_PEN, PAINTSTRUCT, TRANSPARENT,
        },
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, KillTimer,
                RegisterClassW, SetTimer, SetWindowPos, ShowWindow, HWND_TOPMOST, MA_NOACTIVATE,
                SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_SHOWWINDOW, SW_HIDE, WM_ERASEBKGND,
                WM_MOUSEACTIVATE, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                WS_POPUP,
            },
        },
    },
};

const DELAY: Duration = Duration::from_millis(250);
const TIMER: usize = 0x5150;
static PENDING: AtomicU32 = AtomicU32::new(0);

#[derive(Clone)]
struct Request {
    app: AppHandle,
    generation: u32,
    started: Instant,
    name: String,
}
#[derive(Default)]
struct Feedback {
    request: Option<Request>,
    owner: HWND,
    overlay: HWND,
    shown: bool,
}
thread_local! { static UI: RefCell<Feedback> = RefCell::new(Feedback::default()); }

pub fn is_pending() -> bool {
    let generation = PENDING.load(Ordering::SeqCst);
    generation != 0 && crate::preview_generation_is_current(generation)
}

fn due(generation: u32, current: u32, elapsed: Duration) -> bool {
    generation == current && elapsed >= DELAY
}

fn complete(pending: &AtomicU32, generation: u32) -> bool {
    pending
        .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub fn begin(app: &AppHandle, generation: u32, name: String) {
    PENDING.store(generation, Ordering::SeqCst);
    let request = Request {
        app: app.clone(),
        generation,
        started: Instant::now(),
        name,
    };
    let _ = app.run_on_main_thread(move || {
        if !crate::preview_generation_is_current(generation) {
            return;
        }
        let Some(window) = request.app.get_webview_window("main") else {
            return;
        };
        let Ok(owner) = window.hwnd() else {
            return;
        };
        // Establish a hidden default before rendering starts, never at the feedback
        // deadline: changing it at 250 ms could invalidate PDF preflight dimensions.
        if !window.is_visible().unwrap_or(false) {
            if let Ok(Some(monitor)) = window.current_monitor() {
                let area = monitor.work_area();
                let scale = monitor.scale_factor();
                let width = (850.0_f64).min(area.size.width as f64 / scale * 0.94);
                let height = area.size.height as f64 / scale * 0.92 - 32.0;
                let _ = window.set_size(tauri::LogicalSize::new(width, height.max(200.0)));
                let _ = window.center();
            }
        }
        // Retain an already-visible loading cover across rapid selection changes.
        // Otherwise the old document would flash through between two slow requests.
        let shown = UI.with(|ui| {
            let mut ui = ui.borrow_mut();
            ui.owner = owner;
            ui.request = Some(request.clone());
            ui.shown
        });
        if shown {
            let _ = window.set_title(&format!("{} · 正在加载", request.name));
        }
        unsafe {
            SetTimer(Some(owner), TIMER, if shown { 33 } else { 250 }, Some(tick));
        }
    });
}

// Called on the native UI thread immediately before exposing the completed preview.
pub fn finish(generation: u32) {
    if complete(&PENDING, generation) {
        clear_ui();
    }
}

pub fn cancel(app: &AppHandle) {
    PENDING.store(0, Ordering::SeqCst);
    let _ = app.run_on_main_thread(|| {
        // A newer request may already be queued by the time this closure runs.
        let stale = UI.with(|ui| {
            ui.borrow()
                .request
                .as_ref()
                .is_none_or(|r| !crate::preview_generation_is_current(r.generation))
        });
        if stale {
            clear_ui();
        }
    });
}

fn clear_ui() {
    let (owner, overlay) = UI.with(|ui| {
        let mut ui = ui.borrow_mut();
        ui.request = None;
        ui.shown = false;
        (ui.owner, std::mem::take(&mut ui.overlay))
    });
    unsafe {
        if !owner.0.is_null() {
            let _ = KillTimer(Some(owner), TIMER);
        }
        if !overlay.0.is_null() {
            let _ = ShowWindow(overlay, SW_HIDE);
            let _ = DestroyWindow(overlay); // Release the compositor surface, not just visibility.
        }
    }
}

pub fn reposition(app: &AppHandle) {
    let _ = app.run_on_main_thread(position_ui);
}

fn position_ui() {
    let (owner, overlay, shown) = UI.with(|ui| {
        let ui = ui.borrow();
        (ui.owner, ui.overlay, ui.shown)
    });
    if !shown || overlay.0.is_null() {
        return;
    }
    unsafe {
        let mut rect = RECT::default();
        let mut origin = POINT::default();
        if GetClientRect(owner, &mut rect).is_err() || !ClientToScreen(owner, &mut origin).as_bool()
        {
            return;
        }
        let _ = SetWindowPos(
            overlay,
            Some(HWND_TOPMOST),
            origin.x,
            origin.y,
            rect.right,
            rect.bottom,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        );
    }
}

fn create_overlay(owner: HWND) -> HWND {
    unsafe {
        let class = WNDCLASSW {
            lpfnWndProc: Some(paint_window),
            lpszClassName: w!("QuickPeekLoading"),
            ..Default::default()
        };
        RegisterClassW(&class);
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("QuickPeekLoading"),
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            Some(owner),
            None,
            None,
            None,
        )
        .unwrap_or_default()
    }
}

unsafe extern "system" fn tick(_hwnd: HWND, _message: u32, _timer: usize, _time: u32) {
    let (request, shown) = UI.with(|ui| {
        let ui = ui.borrow();
        (ui.request.clone(), ui.shown)
    });
    let Some(request) = request else {
        return;
    };
    if !crate::preview_generation_is_current(request.generation) {
        clear_ui();
        return;
    }
    if !shown
        && due(
            request.generation,
            PENDING.load(Ordering::SeqCst),
            request.started.elapsed(),
        )
    {
        let Some(window) = request.app.get_webview_window("main") else {
            return;
        };
        let owner = UI.with(|ui| ui.borrow().owner);
        let mut overlay = UI.with(|ui| ui.borrow().overlay);
        if overlay.0.is_null() {
            overlay = create_overlay(owner);
            if overlay.0.is_null() {
                return;
            } // Never expose stale content without a cover.
        }
        UI.with(|ui| {
            let mut ui = ui.borrow_mut();
            ui.overlay = overlay;
            ui.shown = true;
        });
        let _ = window.set_title(&format!("{} · 正在加载", request.name));
        // Place the opaque native cover before showing its owner. Native child
        // handlers and a busy WebView cannot paint through this owned popup.
        position_ui();
        unsafe {
            let _ = UpdateWindow(overlay);
        }
        crate::windows_preview::show_without_activation(&request.app);
        position_ui();
        unsafe {
            SetTimer(Some(owner), TIMER, 33, Some(tick));
        }
        crate::diagnostic_log("loading feedback shown after threshold");
    }
    let overlay = UI.with(|ui| ui.borrow().overlay);
    if !overlay.0.is_null() {
        unsafe {
            let _ = InvalidateRect(Some(overlay), None, false);
        }
    }
}

unsafe extern "system" fn paint_window(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => return LRESULT(1),
        WM_PAINT => unsafe {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let bg = CreateSolidBrush(COLORREF(0x202020));
            FillRect(dc, &rect, bg);
            let _ = DeleteObject(HGDIOBJ(bg.0));
            let scale = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
            let x = rect.right / 2;
            let y = rect.bottom / 2 - (14.0 * scale) as i32;
            let elapsed = UI.with(|ui| {
                ui.borrow()
                    .request
                    .as_ref()
                    .map(|r| r.started.elapsed().as_millis())
                    .unwrap_or(0)
            });
            let phase = (elapsed / 80 % 8) as usize;
            let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
            for i in 0..8 {
                let shade = 72 + ((i + 8 - phase) % 8) as u32 * 16;
                let brush = CreateSolidBrush(COLORREF(shade * 0x010101));
                let old_brush = SelectObject(dc, HGDIOBJ(brush.0));
                let angle = i as f64 * std::f64::consts::TAU / 8.0;
                let cx = x + (angle.cos() * 12.0 * scale) as i32;
                let cy = y + (angle.sin() * 12.0 * scale) as i32;
                let radius = (2.2 * scale).round().max(2.0) as i32;
                let _ = Ellipse(dc, cx - radius, cy - radius, cx + radius, cy + radius);
                SelectObject(dc, old_brush);
                let _ = DeleteObject(HGDIOBJ(brush.0));
            }
            SelectObject(dc, old_pen);
            let font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, COLORREF(0x999999));
            let mut text: Vec<u16> = "正在加载…".encode_utf16().collect();
            let mut label = RECT {
                left: 0,
                top: y + (24.0 * scale) as i32,
                right: rect.right,
                bottom: y + (54.0 * scale) as i32,
            };
            DrawTextW(
                dc,
                &mut text,
                &mut label,
                DT_CENTER | DT_SINGLELINE | DT_VCENTER,
            );
            SelectObject(dc, font);
            let _ = EndPaint(hwnd, &ps);
            return LRESULT(0);
        },
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, message, wp, lp) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn threshold_is_feedback_only_and_stale_requests_never_show() {
        assert!(!due(1, 1, Duration::from_millis(249)));
        assert!(due(1, 1, Duration::from_millis(250)));
        assert!(!due(1, 2, Duration::from_secs(10)));
        assert!(!due(1, 0, Duration::from_secs(10)));
    }

    #[test]
    fn fast_completion_close_and_rapid_switch_cancel_feedback() {
        let pending = AtomicU32::new(1);
        assert!(complete(&pending, 1)); // Fast completion; no timer-driven show.
        assert!(!due(
            1,
            pending.load(Ordering::SeqCst),
            Duration::from_secs(1)
        ));
        pending.store(2, Ordering::SeqCst);
        pending.store(3, Ordering::SeqCst); // Superseded before old completion.
        assert!(!complete(&pending, 2));
        assert!(due(3, pending.load(Ordering::SeqCst), DELAY));
        pending.store(0, Ordering::SeqCst); // Close while loading.
        assert!(!complete(&pending, 3));
        assert!(!due(3, pending.load(Ordering::SeqCst), DELAY));
        pending.store(4, Ordering::SeqCst);
        assert!(complete(&pending, 4)); // No minimum spinner duration.
    }

    #[test]
    fn native_cover_is_hidden_nonactivating_and_releases_timer() {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindow, GetWindowLongPtrW, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
        };
        unsafe {
            let owner = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                w!("STATIC"),
                w!("loading test"),
                WS_POPUP,
                0,
                0,
                320,
                240,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let overlay = create_overlay(owner);
            assert!(!overlay.0.is_null());
            assert!(!IsWindowVisible(overlay).as_bool());
            assert_eq!(GetWindow(overlay, GW_OWNER).unwrap(), owner);
            assert_ne!(
                GetWindowLongPtrW(overlay, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE.0,
                0
            );
            UI.with(|ui| {
                let mut ui = ui.borrow_mut();
                ui.owner = owner;
                ui.overlay = overlay;
            });
            assert_ne!(SetTimer(Some(owner), TIMER, 250, None), 0);
            clear_ui();
            assert!(UI.with(|ui| ui.borrow().request.is_none() && !ui.borrow().shown));
            assert!(!IsWindow(Some(overlay)).as_bool());
            // KillTimer fails when clear_ui has already removed it.
            assert!(KillTimer(Some(owner), TIMER).is_err());
            DestroyWindow(owner).unwrap();
            UI.with(|ui| *ui.borrow_mut() = Feedback::default());
        }
    }
}
